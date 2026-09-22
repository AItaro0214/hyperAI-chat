import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { getSettings, logUsage } from '../lib/store.js';
import { getCatalog, findModel, estimateChatCost } from '../lib/models.js';
import { openaiBase as runpodBase } from '../lib/runpod.js';
import { webSearch as webSearch2, formatResults } from '../lib/search.js';
import {
  buildMessages,
  buildRequest,
  consumeChatStream,
  fitToContext,
  isContextError,
  postJson,
  readProviderError,
  requireKey,
  GROQ_BASE,
  OPENROUTER_BASE,
} from '../lib/chat.js';

/** The question a pre-search should answer: the newest user turn. */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 400);
    if (Array.isArray(m.content)) {
      const text = m.content.find((b) => b?.type === 'text' || typeof b?.text === 'string');
      if (text?.text) return String(text.text).slice(0, 400);
    }
  }
  return '';
}

const chat = new Hono();
chat.use('/chat', requireAuth);
chat.use('/title', requireAuth);

const encoder = new TextEncoder();

function sse(writer, event, data) {
  return writer.write(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'));
}

async function ownedRoom(env, id, userId) {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM rooms WHERE id = ? AND user_id = ?').bind(id, userId).first();
}

async function createRoom(env, userId, settings, body) {
  const id = newId('room');
  const t = now();
  const title = titleFrom(body.content, body.attachments || []) || '新しいトークルーム';
  await env.DB.prepare(
    'INSERT INTO rooms (id, user_id, title, provider, model, system_prompt, web_search, temperature, max_tokens, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      id,
      userId,
      title,
      body.provider || settings.defaultProvider,
      body.model || settings.defaultModel,
      body.systemPrompt ?? settings.systemPrompt ?? '',
      body.webSearch ? 1 : 0,
      numOrNull(body.temperature ?? settings.temperature),
      numOrNull(body.maxTokens ?? settings.maxTokens),
      t,
      t
    )
    .run();
  return env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first();
}

/** Turns a bare 429 into something actionable. */
function rateLimitHint(provider, modelId) {
  const br = String.fromCharCode(10);
  if (/:free$/.test(String(modelId))) {
    return br + '無料モデルはリクエスト数の上限が厳しく設定されています。少し時間をおくか、有料モデルに切り替えてください。';
  }
  if (provider === 'groq') {
    return br + 'Groq 無料枠の 1 日あたりトークン上限（20万）に達している可能性があります。日次リセットを待つか、Dev Tier へのアップグレードが必要です。';
  }
  return br + '少し時間をおいてから再試行してください。';
}

function parseSearchSettings(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Groq search tuning: domain filters and country apply to compound systems. */
function normalizeGroqSearch(v) {
  const src = v || {};
  const list = (x) =>
    (Array.isArray(x) ? x : String(x || '').split(','))
      .map((d) => String(d).trim())
      .filter(Boolean)
      .slice(0, 20);
  return {
    includeDomains: list(src.includeDomains),
    excludeDomains: list(src.excludeDomains),
    country: String(src.country || '').trim().slice(0, 60),
    snippetOnly: !!src.snippetOnly,
  };
}

/** Empty strings and zeros mean "unset" — they must not reach the provider. */
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const IMAGE_SAVE_FAILED = '生成された画像を保存できませんでした（もう一度お試しください）';
const MAX_REASONING = 40000;
const MAX_META_BYTES = 8000;
const MAX_TOOL_RECORDS = 12;

/**
 * Provider tool payloads embed whole fetched web pages. Keeping them would put
 * hundreds of KB into a single D1 row, which then breaks every later read of
 * that room, so only the identifying parts are retained.
 */
function compactTool(tool) {
  let query = null;
  try {
    const args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments;
    query = args?.query || args?.pattern || args?.id || null;
  } catch {
    query = null;
  }
  const results = (tool.search_results?.results || [])
    .filter((r) => r && r.url)
    .slice(0, 8)
    .map((r) => ({ title: String(r.title || r.url).slice(0, 200), url: String(r.url).slice(0, 500) }));
  return { name: String(tool.name || tool.type || 'tool').slice(0, 60), type: String(tool.type || '').slice(0, 40), query: query ? String(query).slice(0, 200) : null, results };
}

/** Turns provider tool results into the same citation shape OpenRouter emits. */
function citationsFromTools(tools, seen) {
  const out = [];
  for (const tool of tools) {
    for (const r of tool.results || []) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({ type: 'url_citation', url_citation: { url: r.url, title: r.title } });
    }
  }
  return out;
}

const PLACEHOLDER_TITLES = ['新しいトークルーム', '新しいトーク', ''];

export function isPlaceholderTitle(title) {
  return PLACEHOLDER_TITLES.includes(String(title || '').trim());
}

/** First line of the opening message, trimmed to something sidebar-sized. */
export function titleFrom(content, attachments = []) {
  const raw = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) {
    if (attachments.some((a) => a.kind === 'image')) return '画像について';
    if (attachments.some((a) => a.kind === 'audio')) return '音声について';
    return null;
  }
  return raw.length > 28 ? raw.slice(0, 28) + '…' : raw;
}

async function storeImage(env, userId, roomId, dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!match) return null;
  const mime = match[1] || 'image/png';
  const isB64 = !!match[2];
  const raw = match[3];
  let bytes;
  if (isB64) {
    const bin = atob(raw);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(raw));
  }
  const id = newId('file');
  await env.KV.put('file:' + id, bytes, { metadata: { mime, at: now() } });
  await env.DB.prepare('INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, roomId, 'image', mime, 'generated.' + (mime.split('/')[1] || 'png'), bytes.length, now())
    .run();
  return { id, kind: 'image', mime, name: 'generated.' + (mime.split('/')[1] || 'png'), size: bytes.length, url: '/api/files/' + id };
}

chat.post('/chat', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const settings = await getSettings(c.env);

  let room = await ownedRoom(c.env, body.roomId, userId);
  if (!room) room = await createRoom(c.env, userId, settings, body);

  /* Breakthrough mode overrides the room's model entirely: a self-hosted
   * endpoint has exactly one model on it. */
  const breakthroughOn = !!settings.breakthrough && !!settings.runpodEndpointId;
  const provider = breakthroughOn ? 'runpod' : body.provider || room.provider || settings.defaultProvider;
  const modelId = breakthroughOn
    ? settings.runpodModel || 'breakthrough'
    : body.model || room.model || settings.defaultModel;
  const breakthrough = breakthroughOn
    ? { baseUrl: runpodBase(settings.runpodEndpointId), model: modelId }
    : null;
  // The mode is authoritative; the booleans only mirror it for the UI.
  const webSearchEngineRaw = body.webSearchEngine || room.web_search_engine || settings.webSearchEngine || 'server';
  const imageModeRaw = body.imageMode || room.image_mode || settings.imageMode || 'server';
  const webSearch = webSearchEngineRaw !== 'off';
  const imageOutput = imageModeRaw !== 'off';
  const temperature = numOrNull(body.temperature ?? room.temperature ?? settings.temperature);
  const maxTokens = numOrNull(body.maxTokens ?? room.max_tokens ?? settings.maxTokens);
  const systemPrompt = body.systemPrompt ?? room.system_prompt ?? settings.systemPrompt;
  const webSearchEngine = webSearchEngineRaw;
  const imageMode = imageModeRaw;
  const reasoningEffort = body.reasoning ?? room.reasoning_effort ?? settings.reasoningEffort ?? '';
  const groqSearch = normalizeGroqSearch(body.groqSearch ?? parseSearchSettings(room.search_settings) ?? settings.groqSearch);

  // Remember the current selection on the room so reopening it keeps the model.
  await c.env.DB.prepare(
    'UPDATE rooms SET provider = ?, model = ?, web_search = ?, temperature = ?, max_tokens = ?, system_prompt = ?, ' +
      'web_search_engine = ?, reasoning_effort = ?, search_settings = ?, image_mode = ?, image_output = ?, updated_at = ? WHERE id = ?'
  )
    .bind(
      provider,
      modelId,
      webSearch ? 1 : 0,
      temperature,
      maxTokens,
      systemPrompt,
      webSearchEngine,
      reasoningEffort || null,
      JSON.stringify(groqSearch),
      imageMode,
      imageOutput ? 1 : 0,
      now(),
      room.id
    )
    .run();

  let apiKey;
  try {
    apiKey = await requireKey(c.env, provider);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }

  const catalog = await getCatalog(c.env).catch(() => ({ models: [] }));
  const modelMeta = findModel(catalog, provider + ':' + modelId);

  // Persist the user turn (skipped when regenerating).
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  let roomTitle = room.title;
  if (!body.regenerate) {
    const userMsgId = newId('msg');
    await c.env.DB.prepare(
      'INSERT INTO messages (id, room_id, user_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(userMsgId, room.id, userId, 'user', String(body.content || ''), JSON.stringify(attachments), now())
      .run();

    // Name the room after its opening message instead of leaving every room
    // called "新しいトークルーム".
    if (isPlaceholderTitle(room.title)) {
      const derived = titleFrom(body.content, attachments);
      if (derived) {
        roomTitle = derived;
        await c.env.DB.prepare('UPDATE rooms SET title = ? WHERE id = ?').bind(derived, room.id).run();
      }
    }
  } else {
    // Drop the trailing assistant turn so the model can have another go.
    const last = await c.env.DB.prepare(
      "SELECT id FROM messages WHERE room_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
      .bind(room.id)
      .first();
    if (last) await c.env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(last.id).run();
  }

  // 0 means no explicit cap: fitToContext trims only if the window demands it.
  const limit = Number(settings.historyLimit) > 0 ? Number(settings.historyLimit) : 1000;
  const { results: historyDesc } = await c.env.DB.prepare(
    'SELECT id, role, content, attachments FROM messages WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
  )
    .bind(room.id, limit)
    .all();
  const history = (historyDesc || []).reverse();

  const inputs = modelMeta?.input || ['text'];
  const caps = {
    image: inputs.includes('image'),
    audio: inputs.includes('audio'),
    file: inputs.includes('file'),
    // OpenRouter parses PDFs on behalf of models that cannot read files, so a
    // PDF is worth sending even when the model declares no file input.
    pdfPlugin: provider === 'openrouter',
  };
  const { messages: built, skipped, usedPdf } = await buildMessages(c.env, history, { systemPrompt, caps });

  // Server-side web search injects fetched pages we cannot measure, so those
  // requests keep a much larger share of the window free.
  const toolHeavy = webSearch && (provider === 'groq' || webSearchEngine !== 'native');
  const fitted = fitToContext({ messages: built, modelMeta, requestedMax: maxTokens, toolHeavy });
  const messages = fitted.messages;

  const options = {
    temperature: temperature ?? '',
    maxTokens: fitted.maxTokens,
    webSearch,
    webSearchEngine,
    webSearchMaxResults: body.webSearchMaxResults || settings.webSearchMaxResults,
    imageOutput,
    imageMode,
    reasoning: reasoningEffort || null,
    groqSearch,
    usedPdf,
  };
  const req = buildRequest({ provider, model: modelId, messages, options, apiKey, stream: true, modelMeta, breakthrough });
  const skipNotes = {
    image: 'このモデルは画像入力に対応していないため、画像は送信されませんでした',
    audio: 'このモデルは音声入力に対応していないため、音声は送信されませんでした（🎙️ の文字起こしを使ってください）',
    file: provider === 'groq'
      ? 'Groq は PDF を直接読めません。PDF は OpenRouter のモデルに切り替えてください（Excel/Word/PowerPoint/CSV はどちらでも読めます）'
      : 'このモデルはファイル入力に対応していないため、添付ファイルは送信されませんでした',
    'audio-format': '対応していない音声形式のため送信されませんでした（wav / mp3 / m4a / ogg / flac / aac のみ）',
    'doc-truncated': '添付ファイルが大きいため、先頭部分のみ送信しました',
    'doc-unreadable': '添付ファイルからテキストを取り出せませんでした（破損しているか、画像だけの可能性があります）',
  };
  for (const key of skipped) if (skipNotes[key]) req.notices.push(skipNotes[key]);
  if (fitted.dropped) {
    req.notices.push('コンテキスト長に収めるため、古い ' + fitted.dropped + ' 件の発言を今回の送信から除きました');
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const assistantId = newId('msg');
  const startedAt = now();

  const pump = async () => {
    let text = '';
    let reasoning = '';
    let usage = null;
    let annotations = [];
    let tools = [];
    const citedUrls = new Set();
    const images = [];
    let failed = null;
    const debugShapes = [];
    let clientGone = false;
    let retried = false;
    let phase = 'connecting';
    let lastSaved = 0;
    let savedText = '';

    // Once the browser goes away, keep draining the provider so the answer is
    // still saved to the room instead of being lost mid-flight.
    const emit = async (event, data) => {
      if (clientGone) return;
      try {
        await sse(writer, event, data);
      } catch {
        clientGone = true;
      }
    };
    const setPhase = async (next) => {
      if (phase === next) return;
      phase = next;
      await emit('status', { phase });
    };

    const savePartial = async (final) => {
      if (!final && (text === savedText || Date.now() - lastSaved < 8000)) return;
      lastSaved = Date.now();
      savedText = text;
      try {
        await c.env.DB.prepare(
          'UPDATE messages SET content = ?, reasoning = ?, attachments = ?, annotations = ?, prompt_tokens = ?, ' +
            'completion_tokens = ?, cost = ?, meta = ?, error = ? WHERE id = ?'
        )
          .bind(
            text,
            reasoning ? reasoning.slice(0, MAX_REASONING) : null,
            JSON.stringify(images),
            JSON.stringify(annotations),
            usage?.prompt_tokens ?? null,
            usage?.completion_tokens ?? null,
            final ? costOf() : null,
            metaJson(final),
            failed,
            assistantId
          )
          .run();
      } catch (e) {
        console.error('savePartial failed', e);
      }
    };

    const metaJson = (final) => {
      const base = {
        webSearch,
        webSearchEngine,
        imageMode,
        reasoningEffort,
        notices: noticesOut(final),
        imageOutput,
        partial: !final,
        elapsed: now() - startedAt,
      };
      let json = JSON.stringify({ ...base, tools });
      if (json.length > MAX_META_BYTES) {
        json = JSON.stringify({ ...base, tools: tools.slice(0, 4), toolsTruncated: tools.length });
      }
      if (json.length > MAX_META_BYTES) json = JSON.stringify({ ...base, toolsTruncated: tools.length });
      return json;
    };

    const costOf = () => (usage ? (typeof usage.cost === 'number' ? usage.cost : estimateChatCost(modelMeta, usage)) : null);
    const noticesOut = (final) => {
      const list = [...req.notices];
      // In "server" mode not searching is a legitimate decision by the model,
      // so the warning only applies to the modes that promise a search.
      const forcedSearch = webSearch && webSearchEngine !== 'server';
      if (final && !failed && forcedSearch && !annotations.length && !tools.length) {
        list.push(
          'Web検索は要求されましたが、検索結果が返りませんでした。ルーム設定で検索エンジンを exa に切り替えると確実に検索されます。'
        );
      }
      return list;
    };

    // Insert the row up front so an interrupted turn is never lost.
    try {
      await c.env.DB.prepare(
        'INSERT INTO messages (id, room_id, user_id, role, content, provider, model, attachments, annotations, meta, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(assistantId, room.id, userId, 'assistant', '', provider, req.effectiveModel, '[]', '[]', JSON.stringify({ partial: true }), startedAt)
        .run();
    } catch (e) {
      console.error('placeholder insert failed', e);
    }

    try {
      await emit('meta', {
        roomId: room.id,
        messageId: assistantId,
        provider,
        model: req.effectiveModel,
        notices: req.notices,
        webSearch,
        webSearchEngine,
        reasoningEffort,
        title: roomTitle,
      });
      /* A self-hosted model has no search of its own, so it is done here and
       * the results are put in front of the question. Raw links and snippets,
       * not a summary: the whole point of this mode is that no other model's
       * judgement sits in the middle. */
      if (breakthroughOn && webSearch) {
        await setPhase('searching');
        try {
          const found = await webSearch2(c.env, {
            query: lastUserText(req.body.messages),
            maxResults: Number(settings.webSearchMaxResults) || 5,
            backend: settings.searchBackend || 'ollama',
          });
          const block = formatResults(found);
          req.body.messages.splice(req.body.messages.length - 1, 0, {
            role: 'user',
            content: ['以下はいまウェブを検索した生の結果です。', '内容は裏取りされていません。', '', block].join('\n'),
          });
          await emit('meta', { notices: ['ウェブ検索: ' + found.backend + ' / ' + found.results.length + '件'] });
        } catch (e) {
          await emit('meta', { notices: ['ウェブ検索に失敗しました: ' + String(e.message).slice(0, 200)] });
        }
      }

      await setPhase(webSearch ? 'searching' : 'connecting');

      /* A cold GPU takes minutes to answer the first request. The stream is
       * kept alive with phase updates so the browser does not give up and the
       * user can see that something is still happening. */
      let keepalive = null;
      if (breakthroughOn) {
        const started = Date.now();
        keepalive = setInterval(() => {
          const secs = Math.round((Date.now() - started) / 1000);
          emit('meta', { notices: ['GPU の起動待ち… ' + secs + '秒（初回は重みの読み込みに数分かかります）'] }).catch(() => {});
        }, 10000);
      }

      let upstream = await postJson(req.url, req.headers, req.body).finally(() => clearInterval(keepalive));
      if (!upstream.ok) {
        const detail = await readProviderError(upstream);
        // Fetched web pages can blow past the window; one retry with just the
        // latest turns usually succeeds instead of failing outright.
        if (isContextError(detail) && !retried) {
          retried = true;
          // Keep as much as possible: drop the older half rather than everything.
          const system = req.body.messages.filter((m) => m.role === 'system').slice(0, 1);
          const rest = req.body.messages.filter((m) => m.role !== 'system');
          const kept = rest.length > 1 ? rest.slice(Math.ceil(rest.length / 2)) : rest;
          req.body.messages = [...system, ...(kept.length ? kept : rest.slice(-1))];
          req.notices.push('コンテキスト超過のため、古い ' + (rest.length - kept.length) + ' 件を除いて再実行しました');
          await emit('meta', {
            roomId: room.id,
            messageId: assistantId,
            provider,
            model: req.effectiveModel,
            notices: req.notices,
            title: roomTitle,
          });
          upstream = await postJson(req.url, req.headers, req.body);
        }
        if (!upstream.ok) {
          const body = isContextError(detail) ? await readProviderError(upstream) : detail;
          if (upstream.status === 429) {
            failed = 'レート制限 (429): ' + body + rateLimitHint(provider, req.effectiveModel);
          } else {
            failed = 'プロバイダエラー (' + upstream.status + '): ' + body;
          }
          await emit('error', { message: failed });
        }
      }
      if (!failed && !upstream.body) {
        failed = 'プロバイダから応答本文が返りませんでした';
        await emit('error', { message: failed });
      }
      if (!failed) {
        await consumeChatStream(upstream, {
          onText: async (t) => {
            text += t;
            await setPhase('writing');
            await emit('delta', { text: t });
            await savePartial(false);
          },
          onReasoning: async (t) => {
            reasoning += t;
            await setPhase('thinking');
            await emit('reasoning', { text: t });
          },
          onAnnotations: async (a) => {
            const fresh = a.filter((x) => {
              const url = x?.url_citation?.url;
              if (!url || citedUrls.has(url)) return false;
              citedUrls.add(url);
              return true;
            });
            if (!fresh.length) return;
            // Citation payloads carry the page body; only the link is worth keeping.
            const slim = fresh.map((x) => ({
              type: 'url_citation',
              url_citation: { url: x.url_citation.url, title: String(x.url_citation.title || x.url_citation.url).slice(0, 200) },
            }));
            annotations = annotations.concat(slim).slice(0, 30);
            await emit('annotations', { annotations: slim });
          },
          onTools: async (raw) => {
            const compact = raw.map(compactTool).filter((t) => t.query || t.results.length);
            if (!compact.length) return;
            tools = tools.concat(compact).slice(-MAX_TOOL_RECORDS);
            const fresh = citationsFromTools(compact, citedUrls);
            if (fresh.length) {
              annotations = annotations.concat(fresh);
              await emit('annotations', { annotations: fresh });
            }
            await setPhase('searching');
            await emit('tools', { tools: compact });
          },
          onUsage: (u) => {
            usage = { ...(usage || {}), ...u };
          },
          onImages: async (imgs) => {
            await setPhase('drawing');
            for (const img of imgs) {
              const url = img?.image_url?.url || img?.url;
              let stored = null;
              try {
                stored = await storeImage(c.env, userId, room.id, url);
              } catch (e) {
                console.error('storeImage failed', e);
              }
              if (stored) {
                images.push(stored);
                await emit('image', stored);
              } else if (!req.notices.includes(IMAGE_SAVE_FAILED)) {
                // Never drop a generated image silently.
                req.notices.push(IMAGE_SAVE_FAILED);
              }
            }
          },
          onError: async (m) => {
            failed = m;
            await emit('error', { message: m });
          },
          // Diagnostic only: reports where a provider actually puts images.
          onRaw: body.debugRaw
            ? (json, raw) => {
                if (debugShapes.length > 40) return;
                const choice = json.choices?.[0] || {};
                const looksImage = /data:image|image_url|b64_json|attachment:|\.png|generated_image/i.test(raw);
                if (!looksImage && debugShapes.length > 6) return;
                debugShapes.push({
                  top: Object.keys(json),
                  choice: Object.keys(choice),
                  delta: Object.keys(choice.delta || {}),
                  message: Object.keys(choice.message || {}),
                  looksImage,
                  sample: looksImage ? raw.slice(0, 900) : undefined,
                });
              }
            : undefined,
        });
      }
    } catch (e) {
      failed = e?.message || String(e);
      await emit('error', { message: failed });
    }

    // Some models reference the generated file as attachment://… in prose.
    // Point those at the stored copy, or drop them if nothing was captured.
    if (/attachment:\/\//.test(text)) {
      let index = 0;
      text = text.replace(/!\[([^\]]*)\]\(attachment:\/\/[^)]*\)/g, (whole, alt) => {
        const img = images[index++];
        return img ? '![' + alt + '](' + img.url + ')' : '';
      });
      text = text.replace(/attachment:\/\/\S+/g, '').trim();
    }

    const cost = costOf();
    await savePartial(true);

    try {
      if (cost) {
        await c.env.DB.prepare('UPDATE rooms SET total_cost = total_cost + ?, updated_at = ? WHERE id = ?')
          .bind(cost, now(), room.id)
          .run();
      }
      await logUsage(c.env, {
        userId,
        roomId: room.id,
        provider,
        model: req.effectiveModel,
        kind: imageOutput ? 'image' : 'chat',
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        cost,
      });
    } catch (e) {
      console.error('usage bookkeeping failed', e);
    }

    if (body.debugRaw) await emit('debug', { shapes: debugShapes });
    await emit('usage', { usage, cost });
    await emit('done', { messageId: assistantId, roomId: room.id, error: failed, notices: noticesOut(true) });
    try {
      await writer.close();
    } catch {
      /* client disconnected */
    }
  };

  c.executionCtx.waitUntil(pump());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

/**
 * Titles are throwaway work, so pick a small current model from the live
 * catalog rather than hard-coding an id that goes stale.
 */
async function pickCheapModel(env, provider) {
  const fallback = provider === 'groq' ? 'llama-3.1-8b-instant' : 'google/gemini-2.5-flash-lite';
  try {
    const catalog = await getCatalog(env);
    const candidates = catalog.models.filter(
      (m) =>
        m.provider === provider &&
        m.kind === 'chat' &&
        !m.id.includes(':') &&
        (m.input || []).includes('text') &&
        m.pricing &&
        (m.pricing.input_per_m ?? null) !== null
    );
    if (!candidates.length) return fallback;
    const price = (m) => (m.pricing.input_per_m || 0) + (m.pricing.output_per_m || 0);
    const small = candidates.filter((m) => /flash-lite|flash|mini|haiku|instant|[^0-9]8b|small|lite/i.test(m.id));
    const pool = small.length ? small : candidates;
    pool.sort((a, b) => price(a) - price(b) || (b.created || 0) - (a.created || 0));
    return pool[0].id;
  } catch {
    return fallback;
  }
}

/* --------------------------- title generation --------------------------- */
chat.post('/title', async (c) => {
  const userId = c.get('userId');
  const { roomId } = await c.req.json().catch(() => ({}));
  const room = await ownedRoom(c.env, roomId, userId);
  if (!room) return c.json({ error: 'not found' }, 404);

  const { results } = await c.env.DB.prepare(
    'SELECT role, content FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 6'
  )
    .bind(room.id)
    .all();
  if (!results?.length) return c.json({ error: 'メッセージがありません' }, 400);

  const settings = await getSettings(c.env);
  const provider = room.provider || settings.defaultProvider;
  let apiKey;
  try {
    apiKey = await requireKey(c.env, provider);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
  const cheap = await pickCheapModel(c.env, provider);
  const transcript = results.map((r) => r.role + ': ' + (r.content || '').slice(0, 500)).join('\n');
  const res = await postJson(
    (provider === 'groq' ? GROQ_BASE : OPENROUTER_BASE) + '/chat/completions',
    { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    {
      model: cheap,
      messages: [
        { role: 'system', content: '会話に短い日本語のタイトルを付けます。20文字以内、句読点や引用符なしで、タイトルだけを返してください。' },
        { role: 'user', content: transcript.slice(0, 4000) },
      ],
      temperature: 0.3,
      max_tokens: 40,
    },
    60000
  );
  if (!res.ok) return c.json({ error: await readProviderError(res) }, 502);
  const json = await res.json();
  const title = (json.choices?.[0]?.message?.content || '').trim().replace(/^["'「]|["'」]$/g, '').slice(0, 60);
  if (!title) return c.json({ error: 'タイトルを生成できませんでした' }, 502);
  await c.env.DB.prepare('UPDATE rooms SET title = ?, updated_at = ? WHERE id = ?').bind(title, now(), room.id).run();
  return c.json({ title });
});

export default chat;
