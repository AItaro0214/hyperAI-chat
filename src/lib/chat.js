import { getApiKey } from './store.js';
import { attribution } from './branding.js';
import { extractDocument, documentBlock, docKindOf } from './docs.js';
import { withCacheBreakpoints } from './cache.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const GROQ_BASE = 'https://api.groq.com/openai/v1';

export class ProviderError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const KEY_NAMES = { groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY', xai: 'XAI_API_KEY' };

export async function requireKey(env, provider) {
  const name = KEY_NAMES[provider] || KEY_NAMES.openrouter;
  const key = await getApiKey(env, name);
  if (!key) throw new ProviderError(name + ' が未設定です。管理コンソールで登録してください。', 400);
  return key;
}

/* --------------------------- message building --------------------------- */
// Formats OpenRouter accepts for input_audio. MediaRecorder's webm/opus is not
// among them, so recordings go through transcription instead.
const AUDIO_FORMATS = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

export function audioFormatFor(mime, name = '') {
  const direct = AUDIO_FORMATS[String(mime || '').toLowerCase()];
  if (direct) return direct;
  const ext = String(name).toLowerCase().split('.').pop();
  return ['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a', 'aiff'].includes(ext) ? ext : null;
}

async function attachmentBase64(env, att) {
  if (!att.id || !env.KV) return null;
  const buf = await env.KV.get('file:' + att.id, 'arrayBuffer');
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function attachmentUrl(env, att) {
  // Providers cannot reach our authenticated /api/files route, so attachments
  // are inlined as data URLs.
  if (att.dataUrl) return att.dataUrl;
  const b64 = await attachmentBase64(env, att);
  return b64 ? 'data:' + (att.mime || 'image/png') + ';base64,' + b64 : null;
}

/**
 * Turns stored message rows into OpenAI-compatible chat messages, inlining the
 * attachment kinds the target model actually accepts. Budgets are applied from
 * the newest turn backwards so recent context always wins.
 */
export async function buildMessages(env, rows, { systemPrompt, caps = {}, budgets = {} } = {}) {
  const out = [];
  if (systemPrompt && systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt.trim() });

  const left = { image: budgets.image ?? 20, audio: budgets.audio ?? 3, file: budgets.file ?? 6 };
  const skipped = new Set();
  let usedPdf = false;
  const ordered = [...rows];
  const parts = new Map();

  for (let i = ordered.length - 1; i >= 0; i--) {
    const row = ordered[i];
    if (row.role !== 'user') continue;
    let atts = [];
    try {
      atts = row.attachments ? JSON.parse(row.attachments) : [];
    } catch {
      atts = [];
    }
    if (!atts.length) continue;

    const picked = [];
    for (const att of atts) {
      if (att.kind === 'image') {
        if (!caps.image) {
          skipped.add('image');
          continue;
        }
        if (left.image <= 0) continue;
        const url = await attachmentUrl(env, att);
        if (url) {
          picked.push({ type: 'image_url', image_url: { url } });
          left.image--;
        }
      } else if (att.kind === 'audio') {
        const format = audioFormatFor(att.mime, att.name);
        if (!caps.audio) {
          skipped.add('audio');
          continue;
        }
        if (!format) {
          skipped.add('audio-format');
          continue;
        }
        if (left.audio <= 0) continue;
        const data = await attachmentBase64(env, att);
        if (data) {
          picked.push({ type: 'input_audio', input_audio: { data, format } });
          left.audio--;
        }
      } else {
        if (left.file <= 0) continue;
        // Spreadsheets, documents, slides and plain text are extracted here so
        // they reach every model on both providers, including ones with no file
        // input at all. Only PDFs are handed over raw, for OpenRouter to parse.
        const docKind = docKindOf(att.name, att.mime);
        if (docKind === 'office' || docKind === 'text') {
          const buf = env.KV && att.id ? await env.KV.get('file:' + att.id, 'arrayBuffer') : null;
          const extracted = buf ? await extractDocument(new Uint8Array(buf), att.name, att.mime).catch(() => null) : null;
          if (extracted && extracted.text.trim()) {
            picked.push({ type: 'text', text: documentBlock(att.name || 'file', extracted) });
            if (extracted.truncated) skipped.add('doc-truncated');
            left.file--;
          } else skipped.add('doc-unreadable');
          continue;
        }
        if (!caps.file && !caps.pdfPlugin) {
          skipped.add('file');
          continue;
        }
        const url = await attachmentUrl(env, att);
        if (url) {
          picked.push({ type: 'file', file: { filename: att.name || 'file', file_data: url } });
          usedPdf = true;
          left.file--;
        }
      }
    }
    if (picked.length) parts.set(row.id, picked);
  }

  for (const row of ordered) {
    if (row.role === 'system') continue;
    const extra = parts.get(row.id);
    const text = row.content || '';
    if (row.role === 'user' && extra && extra.length) {
      out.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...extra] });
    } else if (text) {
      out.push({ role: row.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
  }
  return { messages: out, skipped: [...skipped], usedPdf };
}

/* --------------------------- context budgeting --------------------------
 * Providers reject a request when prompt + requested completion exceeds the
 * model's window. Japanese runs close to one token per character, so the
 * estimate stays deliberately pessimistic.
 * ---------------------------------------------------------------------- */
const CHARS_PER_TOKEN = 1.5;
const IMAGE_TOKENS = 900;

export function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += 8;
    if (typeof m.content === 'string') {
      total += Math.ceil(m.content.length / CHARS_PER_TOKEN);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        total += part.type === 'text' ? Math.ceil((part.text || '').length / CHARS_PER_TOKEN) : IMAGE_TOKENS;
      }
    }
  }
  return total;
}

/**
 * Drops the oldest turns until the prompt fits, and clamps the completion cap
 * to what the model actually accepts. `toolHeavy` requests (server-side web
 * search) get extra headroom because the provider injects fetched pages we
 * cannot measure.
 */
export function fitToContext({ messages, modelMeta, requestedMax, toolHeavy = false }) {
  const context = modelMeta?.context || 128000;
  const hardMax = modelMeta?.maxOutput || null;

  // 0 keeps the cap unset: the model may answer as long as it likes.
  let maxTokens = Number(requestedMax) > 0 ? Number(requestedMax) : 0;
  if (maxTokens && hardMax) maxTokens = Math.min(maxTokens, hardMax);

  // Room the answer will need, used only to size the prompt budget.
  const reserve = maxTokens || Math.min(hardMax || 8192, Math.max(4096, Math.floor(context * 0.1)));
  let budget = context - reserve - 1024;
  // Server-side search injects pages into the same window, so leave it room.
  if (toolHeavy) budget = Math.min(budget, Math.floor(context * 0.6));
  budget = Math.max(budget, 2000);

  const system = messages[0]?.role === 'system' ? messages[0] : null;
  const rest = system ? messages.slice(1) : messages.slice();
  let dropped = 0;
  while (rest.length > 1 && estimateTokens([...(system ? [system] : []), ...rest]) > budget) {
    rest.shift();
    dropped++;
  }
  const out = system ? [system, ...rest] : rest;

  // A single oversized turn cannot be dropped, so shrink an explicit cap.
  const used = estimateTokens(out);
  if (maxTokens && used + maxTokens + 1024 > context) {
    maxTokens = Math.max(256, context - used - 1024);
  }
  return { messages: out, maxTokens, dropped };
}

export function isContextError(message) {
  return /reduce the length|context length|too long|maximum context|context_length_exceeded|tokens? per request/i.test(
    String(message || '')
  );
}

/* ---------------------------- request building -------------------------- */
// groq/compound rejects reasoning_effort outright, so capability is derived
// from the model actually being called rather than the one the user picked.
export function groqTakesReasoning(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('compound')) return false;
  return /gpt-oss|qwen3|deepseek-r1/.test(id);
}

// OpenRouter's ladder, from least to most thinking. Providers accept different
// subsets, so the request is adjusted rather than rejected.
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'];
const GROQ_EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high', none: 'low' };

export function clampEffort(provider, modelId, effort) {
  if (!effort || !EFFORT_LEVELS.includes(effort)) return { effort: null, notice: null };
  if (provider === 'groq') {
    const mapped = GROQ_EFFORT[effort];
    return {
      effort: mapped,
      notice: mapped === effort ? null : 'Groq は low / medium / high のみ対応のため ' + effort + ' → ' + mapped + ' に調整しました',
    };
  }
  if (/^anthropic\//i.test(String(modelId)) && effort === 'none') {
    return { effort: 'minimal', notice: 'Claude は思考の完全停止に対応していないため minimal に調整しました' };
  }
  return { effort, notice: null };
}

export function buildRequest({ provider, model, messages, options = {}, apiKey, stream = true, modelMeta }) {
  const notices = [];
  let effectiveModel = model;
  // Long chats re-send the whole history; Claude and Qwen need to be told to
  // cache it, everyone else already does.
  const body = { model: effectiveModel, messages: withCacheBreakpoints(messages, { provider, model }), stream };

  // Unset temperature / token caps are simply omitted so the provider applies
  // its own defaults rather than our guesses.
  if (options.temperature !== null && options.temperature !== undefined && options.temperature !== '') {
    body.temperature = Number(options.temperature);
  }

  if (provider === 'openrouter') {
    if (Number(options.maxTokens) > 0) body.max_tokens = Number(options.maxTokens);
    body.usage = { include: true };
    if (stream) body.stream_options = { include_usage: true };

    // Server tools are executed by OpenRouter when the model asks for them,
    // which is how ChatGPT-style "decide for yourself" behaviour is achieved.
    const serverTools = [];

    const engine = options.webSearchEngine || 'server';
    if (engine !== 'off') {
      if (engine === 'server') {
        serverTools.push({ type: 'openrouter:web_search' }, { type: 'openrouter:web_fetch' });
        notices.push('Web検索はモデルの判断に任せます（Server Tools）');
      } else {
        const plugin = { id: 'web' };
        if (engine !== 'auto') plugin.engine = engine;
        if (engine !== 'native') plugin.max_results = Number(options.webSearchMaxResults || 5);
        body.plugins = [plugin];
        notices.push('毎回 Web 検索します（engine: ' + engine + '）');
      }
    }

    const imageMode = options.imageMode || 'server';
    if (imageMode !== 'off') {
      if (imageMode === 'server') {
        serverTools.push({ type: 'openrouter:image_generation' });
        notices.push('画像生成はモデルの判断に任せます（Server Tools）');
      } else if (modelMeta && !(modelMeta.output || []).includes('image')) {
        notices.push('このモデルは画像出力に対応していないため、強制モードは無視されました');
      } else {
        body.modalities = ['image', 'text'];
        notices.push('画像出力を強制します（modalities: image, text）');
      }
    }

    if (serverTools.length) {
      // Knowing the date keeps searches and "today" questions honest.
      serverTools.push({ type: 'openrouter:datetime' });
      body.tools = [...(body.tools || []), ...serverTools];
    }

    // OpenRouter parses PDFs for models that cannot read files themselves, so a
    // PDF works everywhere as long as the plugin is declared.
    if (options.usedPdf) {
      const native = (modelMeta?.input || []).includes('file');
      body.plugins = [
        ...(body.plugins || []),
        { id: 'file-parser', pdf: { engine: native ? 'native' : options.pdfEngine || 'cloudflare-ai' } },
      ];
      notices.push(
        native
          ? 'PDF はモデルが直接読みます（native）'
          : 'PDF は OpenRouter 側で本文抽出します（cloudflare-ai・無料）'
      );
    }
    if (options.reasoning && modelMeta?.reasoning) {
      const { effort, notice } = clampEffort('openrouter', effectiveModel, options.reasoning);
      if (effort) body.reasoning = { effort };
      if (notice) notices.push(notice);
    }
    return {
      url: OPENROUTER_BASE + '/chat/completions',
      headers: {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        ...attribution(),
      },
      body,
      notices,
      effectiveModel,
    };
  }

  // Groq
  if (Number(options.maxTokens) > 0) body.max_completion_tokens = Number(options.maxTokens);
  const gs = options.groqSearch || {};
  if (options.webSearch) {
    if (modelMeta?.browserSearch) {
      // gpt-oss browses server-side; reasoning_effort is the only documented
      // lever on how far it goes.
      body.tools = [{ type: 'browser_search' }];
      notices.push('Groq の組み込み browser_search を有効化しました（取得したページ全文が入力トークンとして課金されます）');
      if (options.reasoning === 'high') {
        notices.push('思考=高 は検索が深くなり消費が跳ね上がります。Groq は低い effort を推奨しています');
      }
      if (gs.includeDomains?.length || gs.excludeDomains?.length || gs.country || gs.snippetOnly) {
        notices.push('ドメイン制限・スニペット限定は groq/compound 系のみ有効で、browser_search には適用されません');
      }
    } else if (!/compound/.test(effectiveModel)) {
      effectiveModel = 'groq/compound';
      body.model = effectiveModel;
      notices.push('選択モデルは Web 検索に対応していないため groq/compound に切り替えました');
    }

    if (/compound/.test(effectiveModel)) {
      const searchSettings = {};
      if (gs.includeDomains?.length) searchSettings.include_domains = gs.includeDomains;
      if (gs.excludeDomains?.length) searchSettings.exclude_domains = gs.excludeDomains;
      if (gs.country) searchSettings.country = gs.country;
      if (Object.keys(searchSettings).length) {
        body.search_settings = searchSettings;
        notices.push('検索範囲を制限しました（' + JSON.stringify(searchSettings) + '）');
      }
      if (gs.snippetOnly) {
        // Dropping visit_website keeps whole page bodies out of the context.
        body.compound_custom = { tools: { enabled_tools: ['web_search'] } };
        notices.push('ページ本文の取得を無効化し、検索スニペットのみ使用します（トークン節約）');
      }
    }
  }
  // Decided last: a swap above can land on a model that rejects the parameter.
  if (options.reasoning && groqTakesReasoning(effectiveModel)) {
    const { effort, notice } = clampEffort('groq', effectiveModel, options.reasoning);
    if (effort) body.reasoning_effort = effort;
    if (notice) notices.push(notice);
  }
  // Groq returns usage on the final chunk as x_groq.usage, so stream_options
  // is unnecessary here.
  return {
    url: GROQ_BASE + '/chat/completions',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body,
    notices,
    effectiveModel,
  };
}

/* ------------------------------ SSE parsing ----------------------------- */
export async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Generated images arrive under different keys depending on whether the model
 * emitted them directly or OpenRouter's image tool produced them, so the whole
 * choice is scanned for anything that looks like image data.
 */
export function collectImages(choice, depth = 0) {
  const found = [];
  const walk = (node, level) => {
    if (!node || level > 5 || found.length > 8) return;
    if (typeof node === 'string') {
      if (node.startsWith('data:image/') || /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?|$)/i.test(node)) {
        found.push({ image_url: { url: node } });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, level + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.image_url?.url) {
      found.push({ image_url: { url: node.image_url.url } });
      return;
    }
    if (typeof node.b64_json === 'string') {
      found.push({ image_url: { url: 'data:image/png;base64,' + node.b64_json } });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      // Prose can mention a URL; only structural fields are worth walking.
      if (key === 'content' || key === 'text' || key === 'reasoning') continue;
      walk(value, level + 1);
    }
  };
  walk(choice?.delta?.images ?? null, depth);
  walk(choice?.delta?.attachments ?? null, depth);
  walk(choice?.message?.images ?? null, depth);
  walk(choice?.message?.attachments ?? null, depth);
  if (!found.length) walk(choice?.delta ?? null, depth);
  return found;
}

/**
 * Consumes an OpenAI-compatible SSE stream and invokes the handler for every
 * meaningful piece. Works for both OpenRouter and Groq.
 */
export async function consumeChatStream(response, handlers) {
  for await (const line of sseLines(response)) {
    if (line.startsWith(':')) continue; // comment / keep-alive
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    handlers.onRaw?.(json, payload);
    if (json.error) {
      await handlers.onError?.(json.error.message || JSON.stringify(json.error));
      continue;
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta || {};
    // Every handler is awaited: they persist to KV/D1 and write to the SSE
    // stream, and a floating promise could still be running when the turn is
    // saved, dropping generated images.
    if (typeof delta.content === 'string' && delta.content) await handlers.onText?.(delta.content);
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning) await handlers.onReasoning?.(reasoning);
    const images = collectImages(choice);
    if (images.length) await handlers.onImages?.(images);
    if (Array.isArray(delta.annotations) && delta.annotations.length) await handlers.onAnnotations?.(delta.annotations);
    if (Array.isArray(choice?.message?.annotations)) await handlers.onAnnotations?.(choice.message.annotations);
    if (json.x_groq?.usage) await handlers.onUsage?.(json.x_groq.usage);
    if (json.usage) await handlers.onUsage?.(json.usage);
    const tools = choice?.delta?.executed_tools || json.choices?.[0]?.message?.executed_tools;
    if (Array.isArray(tools) && tools.length) await handlers.onTools?.(tools);
  }
}

// Server-side web search on reasoning models can browse for many minutes;
// the streaming UI shows progress, so the ceiling is deliberately generous.
export async function postJson(url, headers, body, timeoutMs = 600000) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

export async function readProviderError(res) {
  const text = await res.text().catch(() => '');
  let msg = text;
  try {
    const json = JSON.parse(text);
    const err = json.error || json;
    msg = err.message || json.message || text;
    // OpenRouter wraps upstream failures as a bare "Provider returned error";
    // the useful detail only lives in metadata.
    const meta = err.metadata || {};
    const extra = [];
    if (meta.provider_name) extra.push(String(meta.provider_name));
    const raw = typeof meta.raw === 'string' ? meta.raw : meta.raw ? JSON.stringify(meta.raw) : '';
    if (raw) extra.push(raw.slice(0, 400));
    if (extra.length) msg += ' — ' + extra.join(' / ');
  } catch {
    /* keep raw */
  }
  return (msg || 'upstream error').slice(0, 900);
}
