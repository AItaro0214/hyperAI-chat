/* OpenRouter's dedicated image API.
 *
 * Unlike the chat route (one picture per reply), this endpoint takes an `n` and
 * returns a batch — but the ceiling differs per model, so the catalogue is read
 * for each model's declared range rather than assumed. */

import { OPENROUTER_BASE } from './chat.js';
import { attribution } from './branding.js';
import { imageFields, sanitizeParams } from './media-params.js';

const CACHE_TTL_SEC = 3600;
const SCHEMA = 'v2';

export async function fetchImageModels(env, { force = false } = {}) {
  const key = 'cache:imagemodels:' + SCHEMA;
  if (!force && env.KV) {
    const hit = await env.KV.get(key, 'json');
    if (hit && Date.now() - hit.at < CACHE_TTL_SEC * 1000) return hit.data;
  }
  const res = await fetch(OPENROUTER_BASE + '/images/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('OpenRouter /images/models ' + res.status);
  const json = await res.json();

  const data = (json.data || []).map((m) => {
    const params = m.supported_parameters || {};
    const enumOf = (name) => (params[name]?.type === 'enum' ? params[name].values || [] : []);
    return {
      id: m.id,
      name: m.name || m.id,
      description: (m.description || '').slice(0, 240),
      created: m.created || 0,
      maxN: Math.max(1, Number(params.n?.max) || 1),
      aspectRatios: enumOf('aspect_ratio'),
      qualities: enumOf('quality'),
      resolutions: enumOf('resolution'),
      backgrounds: enumOf('background'),
      outputFormats: enumOf('output_format'),
      seed: !!params.seed,
      maxReferences: Number(params.input_references?.max) || 0,
      params: Object.keys(params),
      // The form is built from this, and requests are checked against it.
      fields: imageFields(params),
    };
  });

  data.sort((a, b) => b.maxN - a.maxN || b.created - a.created);
  if (env.KV) await env.KV.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: CACHE_TTL_SEC * 4 });
  return data;
}

/** Only forwards the parameters this particular model declares. */
export function buildImageRequest(model, options = {}) {
  const body = { model: model.id, prompt: String(options.prompt || '').trim() };
  const wanted = Math.max(1, Math.min(Number(options.n) || 1, model.maxN));
  if (wanted > 1) body.n = wanted;
  if (options.aspectRatio && model.aspectRatios.includes(options.aspectRatio)) body.aspect_ratio = options.aspectRatio;
  if (options.quality && model.qualities.includes(options.quality)) body.quality = options.quality;
  if (options.resolution && model.resolutions.includes(options.resolution)) body.resolution = options.resolution;
  if (options.background && model.backgrounds.includes(options.background)) body.background = options.background;
  if (options.outputFormat && model.outputFormats.includes(options.outputFormat)) body.output_format = options.outputFormat;
  if (model.seed && options.seed !== undefined && options.seed !== null && options.seed !== '') {
    const n = Number(options.seed);
    if (Number.isFinite(n)) body.seed = n;
  }
  if (model.maxReferences > 0 && Array.isArray(options.references) && options.references.length) {
    body.input_references = options.references.slice(0, model.maxReferences);
  }
  /* The dynamic form sends `params`, keyed as the schema names them. Each is
   * re-checked here against the model's own fields, so a stale form or a
   * hand-written request cannot forward something the model never declared. */
  let dropped = [];
  if (options.params && typeof options.params === 'object') {
    const clean = sanitizeParams(model.fields || imageFields({}), options.params);
    Object.assign(body, clean.body);
    dropped = clean.dropped;
  }
  return { body, requested: wanted, dropped };
}

/**
 * Splits a request into as few API calls as the model's ceiling allows, then
 * runs them together. A model capped at n=1 still yields a batch this way.
 */
export function planBatches(total, maxN) {
  const per = Math.max(1, maxN);
  const calls = [];
  let left = Math.max(1, total);
  while (left > 0) {
    const take = Math.min(per, left);
    calls.push(take);
    left -= take;
  }
  return calls;
}

export async function generateImages(apiKey, body) {
  const res = await fetch(OPENROUTER_BASE + '/images', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      ...attribution(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json?.error?.message || json?.message || text || ('HTTP ' + res.status);
    throw new Error('画像生成に失敗 (' + res.status + '): ' + String(err).slice(0, 300));
  }
  return json;
}

const B64 = /^[A-Za-z0-9+/=\s]+$/;

/** Normalises the response into raw bytes regardless of the shape returned. */
export function imagesFrom(response) {
  const out = [];
  for (const item of response?.data || []) {
    let b64 = item?.b64_json || item?.b64 || null;
    let mime = item?.media_type || item?.mime_type || 'image/png';
    const url = item?.url || item?.image_url?.url;
    if (!b64 && typeof url === 'string' && url.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m) {
        mime = m[1];
        b64 = m[2];
      }
    }
    if (!b64 || !B64.test(b64.slice(0, 64))) continue;
    try {
      const bin = atob(b64.replace(/\s/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out.push({ bytes, mime });
    } catch {
      /* a single unusable entry should not sink the batch */
    }
  }
  return out;
}

export function costOf(response) {
  const usage = response?.usage || {};
  const cost = Number(usage.cost ?? usage.total_cost);
  return Number.isFinite(cost) ? cost : null;
}
