/* Text to speech.
 *
 * OpenRouter has a dedicated OpenAI-compatible /audio/speech endpoint. Its TTS
 * models are declared with the `speech` output modality — not `audio`, which is
 * only music and the conversational audio models — so they never show up in the
 * default catalogue listing. */

import { OPENROUTER_BASE, GROQ_BASE, readProviderError } from './chat.js';
import { attribution } from './branding.js';

const CACHE_TTL_SEC = 3600;
const SCHEMA = 'v1';

/** Voice sets are per provider and not exposed by the API, so they are listed here. */
const VOICES = {
  'google/gemini-3.1-flash-tts-preview': [
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
  ],
  'openai/gpt-audio': ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
  'openai/gpt-audio-mini': ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
  'deepgram/aura-2': ['thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries', 'amalthea'],
  'deepgram/flux-tts:free': ['thalia', 'andromeda', 'helena', 'apollo', 'arcas'],
  'hexgrad/kokoro-82m': ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'jf_alpha', 'jm_kumo'],
};

/** Models the app should offer first — the ones that handle Japanese well. */
const PREFERRED = [
  'google/gemini-3.1-flash-tts-preview',
  'qwen/qwen-audio-3.0-tts-flash',
  'qwen/qwen-audio-3.0-tts-plus',
  'minimax/speech-2.8-turbo',
  'openai/gpt-audio-mini',
];

export const voicesFor = (model) => VOICES[model] || [];

/**
 * Every model OpenRouter can speak with.
 * The listing is filtered by the `speech` output modality; `audio` returns music
 * models and the conversational audio pair instead.
 */
export async function fetchSpeechModels(env, { force = false } = {}) {
  const key = 'cache:speechmodels:' + SCHEMA;
  if (!force && env.KV) {
    const hit = await env.KV.get(key, 'json');
    if (hit && Date.now() - hit.at < CACHE_TTL_SEC * 1000) return hit.data;
  }

  const res = await fetch(OPENROUTER_BASE + '/models?output_modality=speech', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('OpenRouter /models?output_modality=speech ' + res.status);
  const json = await res.json();

  const data = (json.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    description: (m.description || '').slice(0, 240),
    free: /:free$/.test(m.id) || Number(m.pricing?.prompt) === 0,
    // These models bill by input characters, so `prompt` is the rate that matters.
    perMillionChars: Number(m.pricing?.prompt || 0) * 1e6,
    voices: voicesFor(m.id),
    params: m.supported_parameters || [],
  }));

  const rank = (m) => {
    const at = PREFERRED.indexOf(m.id);
    return at === -1 ? PREFERRED.length + (m.free ? 0.5 : 1) : at;
  };
  data.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

  if (env.KV) await env.KV.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: CACHE_TTL_SEC * 4 });
  return data;
}

const MIME_FOR = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', flac: 'audio/flac', pcm: 'audio/wav' };
export const speechMime = (format) => MIME_FOR[format] || 'audio/mpeg';

/** Groq keeps its own speech endpoint; everything else goes through OpenRouter. */
export const isGroqSpeech = (model) => /orpheus|playai/i.test(String(model || ''));

/**
 * Synthesises speech. Both providers expose the same OpenAI-compatible shape.
 * @returns {Promise<{bytes: Uint8Array, mime: string}>}
 */
export async function synthesize(apiKey, model, { text, voice, format = 'mp3', provider = 'openrouter' } = {}) {
  const groq = provider === 'groq';
  const body = { model, input: text, response_format: format };
  // Omitting the voice lets the provider pick its own default.
  if (voice) body.voice = voice;

  const res = await fetch((groq ? GROQ_BASE : OPENROUTER_BASE) + '/audio/speech', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      ...(groq ? {} : attribution()),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(await readProviderError(res));

  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('音声が返りませんでした');
  return { bytes: new Uint8Array(buf), mime: res.headers.get('content-type') || speechMime(format) };
}
