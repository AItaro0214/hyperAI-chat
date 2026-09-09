/* xAI (Grok) — specifically its X search tool.
 *
 * Grok models are reachable through OpenRouter already, so the reason to talk
 * to xAI directly is the one thing OpenRouter cannot proxy: `x_search`, a
 * server-side tool that reads X itself. Nothing else here is a chat provider —
 * a question goes in, an answer with post citations comes back.
 *
 * The endpoint is /v1/responses (OpenAI Responses API compatible), not
 * /v1/chat/completions: the input field is `input`, not `messages`, and the
 * older `search_parameters` / `live_search` forms are gone. */

import { getApiKey } from './store.js';

export const XAI_BASE = 'https://api.x.ai/v1';

const CACHE_TTL_SEC = 3600;
const SCHEMA = 'v1';

/* Model ids move quickly here — the April 2026 `grok-4-1-fast-*` family no
 * longer exists — so the catalogue is always read live and this is only the
 * fallback when the request is made without one. */
export const DEFAULT_MODEL = 'grok-4.6';

export async function xaiKey(env) {
  const key = await getApiKey(env, 'XAI_API_KEY');
  if (!key) throw new Error('XAI_API_KEY が未設定です。管理コンソールで登録してください。');
  return key;
}

/* ------------------------------ catalogue ------------------------------- */

/**
 * xAI publishes two listings: /language-models carries pricing and modalities,
 * /models is the plain OpenAI-compatible one. Prefer the richer of the two.
 */
export async function fetchXaiModels(env, { force = false } = {}) {
  const key = 'cache:xaimodels:' + SCHEMA;
  if (!force && env.KV) {
    const hit = await env.KV.get(key, 'json');
    if (hit && Date.now() - hit.at < CACHE_TTL_SEC * 1000) return hit.data;
  }

  const apiKey = await xaiKey(env);
  const headers = { authorization: 'Bearer ' + apiKey, accept: 'application/json' };

  let data = [];
  const rich = await fetch(XAI_BASE + '/language-models', { headers, signal: AbortSignal.timeout(20000) }).catch(
    () => null
  );
  if (rich?.ok) {
    const json = await rich.json().catch(() => ({}));
    data = (json.models || json.data || []).map((m) => ({
      id: m.id,
      // Prices are quoted per 100M tokens in this listing.
      perMillionIn: Number(m.prompt_text_token_price || 0) / 100,
      perMillionOut: Number(m.completion_text_token_price || 0) / 100,
      modalities: m.input_modalities || [],
      aliases: m.aliases || [],
    }));
  }

  if (!data.length) {
    const plain = await fetch(XAI_BASE + '/models', { headers, signal: AbortSignal.timeout(20000) });
    if (!plain.ok) throw new Error('xAI /models ' + plain.status);
    const json = await plain.json();
    data = (json.data || []).map((m) => ({ id: m.id, perMillionIn: 0, perMillionOut: 0, modalities: [], aliases: [] }));
  }

  data.sort((a, b) => a.id.localeCompare(b.id));
  if (env.KV) await env.KV.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: CACHE_TTL_SEC * 4 });
  return data;
}

/* ----------------------------- request shape ---------------------------- */

const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const handleList = (v) =>
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map((h) => String(h).trim().replace(/^@/, ''))
    .filter(Boolean)
    .slice(0, 20);

/**
 * Builds the /v1/responses body for an X search.
 * `allowed_x_handles` and `excluded_x_handles` are mutually exclusive upstream,
 * so a request naming both keeps only the allow list.
 */
export function buildSearchRequest({
  query,
  model,
  fromDate,
  toDate,
  handles,
  excludeHandles,
  images = false,
  videos = false,
  alsoWeb = false,
  instructions,
} = {}) {
  const tool = { type: 'x_search' };
  const from = isoDate(fromDate);
  const to = isoDate(toDate);
  if (from) tool.from_date = from;
  if (to) tool.to_date = to;

  const allow = handleList(handles);
  const deny = handleList(excludeHandles);
  if (allow.length) tool.allowed_x_handles = allow;
  else if (deny.length) tool.excluded_x_handles = deny;

  if (images) tool.enable_image_understanding = true;
  if (videos) tool.enable_video_understanding = true;

  const tools = [tool];
  if (alsoWeb) tools.push({ type: 'web_search' });

  const body = {
    model: model || DEFAULT_MODEL,
    input: [{ role: 'user', content: String(query || '').trim() }],
    tools,
  };
  if (instructions) body.instructions = String(instructions);
  return body;
}

/* ---------------------------- response shape ---------------------------- */

/**
 * Pulls the answer and its sources out of a Responses API reply.
 *
 * The shape is walked defensively rather than indexed into: the output array
 * mixes reasoning, tool-call and message items whose order is not guaranteed,
 * and citations have appeared both as annotations on the text and as a
 * top-level array. Anything unrecognised is ignored rather than throwing, so a
 * new item type upstream cannot empty out an otherwise good answer.
 */
export function parseSearchResponse(json) {
  const text = [];
  const sources = [];
  const seen = new Set();

  const addSource = (url, title) => {
    const clean = String(url || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    sources.push({ url: clean, title: String(title || '').slice(0, 200) });
  };

  for (const item of json?.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part?.type === 'output_text' || typeof part?.text === 'string') {
        if (part.text) text.push(part.text);
        for (const note of part.annotations || []) {
          if (note?.url) addSource(note.url, note.title);
        }
      }
    }
  }

  // Some replies carry the answer only as the convenience field.
  if (!text.length && typeof json?.output_text === 'string') text.push(json.output_text);

  for (const c of json?.citations || []) {
    if (typeof c === 'string') addSource(c);
    else if (c?.url) addSource(c.url, c.title);
  }

  const usage = json?.usage || {};
  return {
    text: text.join('\n\n').trim(),
    sources,
    tokens: Number(usage.total_tokens) || 0,
    sourcesUsed: Number(usage.num_sources_used) || sources.length,
  };
}

/** Number of X posts read — this is what xAI bills for, on top of tokens. */
export const SOURCE_COST = 0.005;
export const estimateSearchCost = (sourcesUsed) => (Number(sourcesUsed) || 0) * SOURCE_COST;

/* -------------------------------- the call ------------------------------- */

export async function searchX(apiKey, options = {}) {
  const body = buildSearchRequest(options);
  const res = await fetch(XAI_BASE + '/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json?.error?.message || json?.error || json?.msg || raw || ('HTTP ' + res.status);
    throw new Error('X検索に失敗 (' + res.status + '): ' + String(err).slice(0, 300));
  }

  const parsed = parseSearchResponse(json);
  // An empty answer from a 200 means the shape moved; say so instead of
  // handing back a blank string that reads like "nothing was found".
  if (!parsed.text && !parsed.sources.length) {
    throw new Error('X検索の応答を解釈できませんでした: ' + raw.slice(0, 300));
  }
  return { ...parsed, model: body.model };
}

/** Formats a result for a tool message. */
export function formatSearchResult({ text, sources }) {
  const lines = [text];
  if (sources.length) {
    lines.push('', '## 参照した投稿');
    for (const s of sources.slice(0, 30)) lines.push('- ' + (s.title ? s.title + ' — ' : '') + s.url);
  }
  return lines.join('\n');
}
