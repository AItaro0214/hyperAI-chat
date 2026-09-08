import { OPENROUTER_BASE } from './chat.js';
import { attribution } from './branding.js';

const CACHE_TTL_SEC = 3600;
const SCHEMA = 'v3';
// OpenRouter bills video by "video tokens": (w * h * fps * duration) / 1024.
// Providers render at 24fps unless stated otherwise.
const ASSUMED_FPS = 24;

/**
 * Video models live behind their own listing; the default /models response
 * filters them out entirely.
 */
export async function fetchVideoModels(env, { force = false } = {}) {
  const key = 'cache:videomodels:' + SCHEMA;
  if (!force && env.KV) {
    const hit = await env.KV.get(key, 'json');
    if (hit && Date.now() - hit.at < CACHE_TTL_SEC * 1000) return hit.data;
  }
  const res = await fetch(OPENROUTER_BASE + '/videos/models', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('OpenRouter /videos/models ' + res.status);
  const json = await res.json();
  const data = (json.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    description: (m.description || '').slice(0, 300),
    created: m.created || 0,
    resolutions: m.supported_resolutions || [],
    aspectRatios: m.supported_aspect_ratios || [],
    sizes: m.supported_sizes || [],
    durations: m.supported_durations || [],
    frameImages: m.supported_frame_images || [],
    generateAudio: !!m.generate_audio,
    seed: !!m.seed,
    pricing: m.pricing_skus || {},
    rates: normalizeRates(m.pricing_skus),
    passthrough: m.allowed_passthrough_parameters || [],
  }));
  // Promotional discounts only appear on the per-model endpoints route, so they
  // are collected in parallel and folded in before caching.
  const raw = json.data || [];
  await Promise.all(
    data.map(async (model, i) => {
      model.discount = 0;
      const slug = raw[i]?.canonical_slug || model.id;
      try {
        const detail = await fetch(OPENROUTER_BASE + '/models/' + slug + '/endpoints', {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        if (!detail.ok) return;
        const body = await detail.json();
        const discount = Number(body?.data?.endpoints?.[0]?.pricing?.discount || 0);
        if (Number.isFinite(discount) && discount > 0 && discount < 1) model.discount = discount;
      } catch {
        /* a missing discount just means list price */
      }
    })
  );

  if (env.KV) await env.KV.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: CACHE_TTL_SEC * 4 });
  return data;
}

/** List price minus any promotion currently running on the model. */
export function applyDiscount(cost, discount) {
  if (cost == null) return null;
  const off = Number(discount) || 0;
  return off > 0 && off < 1 ? cost * (1 - off) : cost;
}

export const RES_DIMS = {
  '480p': [854, 480],
  '720p': [1280, 720],
  '768p': [1366, 768],
  '1024p': [1820, 1024],
  '1080p': [1920, 1080],
  '4k': [3840, 2160],
};

/**
 * Video pricing comes in four unrelated shapes depending on the provider:
 * per video token, dollars per second, cents per second, and cents per
 * megapixel-second. They are folded into one lookup table here.
 */
export function normalizeRates(skus) {
  const perSecond = {};
  const perToken = {};
  const extra = {};
  const put = (bag, key, value) => {
    // Colliding keys (text-to-video vs image-to-video) keep the dearer rate so
    // estimates never understate.
    bag[key] = bag[key] === undefined ? value : Math.max(bag[key], value);
  };

  for (const [key, raw] of Object.entries(skus || {})) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const res = (key.match(/_(\d+p|4k)(?:_|$)/) || [])[1] || 'default';
    const audio = key.includes('without_audio') ? 'noaudio:' : key.includes('with_audio') ? 'audio:' : '';

    if (key === 'minimum_cents_per_generation') extra.minimum = value / 100;
    else if (key === 'reference_images') extra.referenceImage = value;
    else if (key === 'cents_per_image_input') extra.imageInput = value / 100;
    else if (key.startsWith('cents_per_megapixel_second')) {
      extra.megapixelSecond = Math.min(extra.megapixelSecond ?? Infinity, value / 100);
    } else if (key.startsWith('video_tokens')) {
      if (key.includes('with_video_input')) continue; // situational
      put(perToken, (key.includes('without_audio') ? 'noaudio:' : '') + res, value);
    } else if (key.includes('duration_seconds')) {
      put(perSecond, audio + res, value);
    } else if (key.includes('cents_per_second_output') || key.includes('cents_per_video_output_second')) {
      if (key.includes('continuation')) continue;
      put(perSecond, audio + res, value / 100);
    }
  }
  return { perSecond, perToken, extra };
}

function resolutionKey(resolution, size) {
  const dims = /^(\d+)x(\d+)$/.exec(String(size || ''));
  if (dims) {
    const shorter = Math.min(Number(dims[1]), Number(dims[2]));
    if (shorter <= 480) return '480p';
    if (shorter <= 720) return '720p';
    if (shorter <= 768) return '768p';
    if (shorter <= 1080) return '1080p';
    return '4k';
  }
  const res = String(resolution || '').toLowerCase();
  return RES_DIMS[res] ? res : 'default';
}

/** Rough list price for the chosen settings; promotional discounts excluded. */
export function estimateVideoCost(model, { size, resolution, duration, generateAudio } = {}) {
  const rates = model?.rates || normalizeRates(model?.pricing);
  const seconds = Number(duration) || 0;
  if (!seconds) return null;
  const res = resolutionKey(resolution, size);
  const prefix = generateAudio ? 'audio:' : 'noaudio:';

  const secondRate =
    rates.perSecond[prefix + res] ??
    rates.perSecond[res] ??
    rates.perSecond[prefix + 'default'] ??
    rates.perSecond.default;
  if (secondRate !== undefined) {
    return Math.max(secondRate * seconds, rates.extra.minimum || 0);
  }

  const tokenRate =
    (!generateAudio ? rates.perToken['noaudio:' + res] : undefined) ??
    rates.perToken[res] ??
    (!generateAudio ? rates.perToken['noaudio:default'] : undefined) ??
    rates.perToken.default;
  if (tokenRate !== undefined) {
    const dims = /^(\d+)x(\d+)$/.exec(String(size || ''));
    const [width, height] = dims ? [Number(dims[1]), Number(dims[2])] : RES_DIMS[res] || [];
    if (!width) return null;
    return ((width * height * ASSUMED_FPS * seconds) / 1024) * tokenRate;
  }

  if (rates.extra.megapixelSecond) {
    const [width, height] = RES_DIMS[res] || RES_DIMS['720p'];
    return ((width * height) / 1e6) * seconds * rates.extra.megapixelSecond;
  }
  return null;
}

export async function submitVideoJob(apiKey, body) {
  const res = await fetch(OPENROUTER_BASE + '/videos', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      ...attribution(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
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
    throw new Error('動画ジョブの投入に失敗 (' + res.status + '): ' + String(err).slice(0, 400));
  }
  return json;
}

export async function pollVideoJob(apiKey, jobId) {
  const res = await fetch(OPENROUTER_BASE + '/videos/' + encodeURIComponent(jobId), {
    headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json?.error?.message || text || ('HTTP ' + res.status);
    throw new Error('ジョブ状態の取得に失敗 (' + res.status + '): ' + String(err).slice(0, 400));
  }
  return json;
}

/** Pulls the first finished video URL out of whichever shape the API returns. */
export function videoUrlFrom(job) {
  const candidates = [
    ...(Array.isArray(job?.unsigned_urls) ? job.unsigned_urls : []),
    ...(Array.isArray(job?.urls) ? job.urls : []),
    ...(Array.isArray(job?.output) ? job.output : []),
    job?.video?.url,
    job?.url,
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string') return c;
    if (c && typeof c.url === 'string') return c.url;
  }
  return null;
}

export function jobStatusOf(job) {
  const status = String(job?.status || '').toLowerCase();
  if (['completed', 'succeeded', 'success'].includes(status)) return 'completed';
  if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) return 'failed';
  if (['in_progress', 'processing', 'running'].includes(status)) return 'in_progress';
  return 'pending';
}
