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
/* Google ships one cast across its TTS models. */
const GEMINI_VOICES = [
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

const VOICES = {
  'google/gemini-3.1-flash-tts-preview': GEMINI_VOICES,
  'google/gemini-3.8-flash-tts': GEMINI_VOICES,
  'google/gemini-3.8-flash-lite-tts': GEMINI_VOICES,
  'openai/gpt-audio': ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
  'openai/gpt-audio-mini': ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
  'deepgram/aura-2': ['thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries', 'amalthea'],
  'deepgram/flux-tts:free': ['thalia', 'andromeda', 'helena', 'apollo', 'arcas'],
  'minimax/speech-2.8-turbo': ['Japanese_KindLady', 'female-shaonv'],
  'minimax/speech-2.8-hd': ['Japanese_KindLady', 'female-shaonv'],
  'x-ai/grok-voice-tts-1.0': ['Eve'],
  'hexgrad/kokoro-82m': ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'jf_alpha', 'jm_kumo'],
};

/** Models the app should offer first — the ones that handle Japanese well. */
const PREFERRED = [
  'google/gemini-3.8-flash-tts',
  'google/gemini-3.8-flash-lite-tts',
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

/* ------------------------------- Formats ---------------------------------
 *
 * The output format is not a preference, it is a negotiation with three
 * parties that disagree.
 *
 * OpenRouter's /audio/speech accepts exactly two values — mp3 and pcm — and
 * rejects wav, opus and flac outright, whatever the OpenAI SDK's own list
 * says. Google's TTS models then narrow that to one: asking for mp3 returns
 * `Gemini TTS only supports response_format="pcm"`. And pcm is not a file —
 * it is raw samples with no header, which no <audio> element will play and no
 * download will open. Groq's endpoint is the exception that keeps wav.
 *
 * So the format is chosen per model rather than fixed, and anything that
 * comes back headerless is given a WAV header before it is stored. What the
 * caller asked for and what the file ends up being are therefore two
 * different things, and synthesize() returns both. */

/** Everything OpenRouter's speech endpoint will accept, verified against it. */
export const OPENROUTER_FORMATS = ['mp3', 'pcm'];

/** Groq's own endpoint is a separate service with a separate list. */
export const GROQ_FORMATS = ['wav', 'mp3', 'flac'];

/* Models that dictate the format rather than offering one. */
const FORMAT_RULES = [{ match: /gemini.*tts|tts.*gemini/i, only: 'pcm' }];

/**
 * The format to actually request for a model.
 * @param {string} model
 * @param {string} [wanted] what the caller would prefer
 */
export function formatFor(model, wanted, { provider = 'openrouter' } = {}) {
  const allowed = provider === 'groq' ? GROQ_FORMATS : OPENROUTER_FORMATS;
  const forced = FORMAT_RULES.find((r) => r.match.test(String(model || '')))?.only;
  if (forced) return forced;
  if (wanted && allowed.includes(wanted)) return wanted;
  return allowed[0];
}

/** `audio/pcm;rate=24000;channels=1` and `audio/L16;rate=24000` both turn up. */
export function parsePcmType(contentType) {
  const type = String(contentType || '');
  if (!/pcm|L16|l16/.test(type)) return null;
  const num = (name, fallback) => {
    const hit = type.match(new RegExp(name + '\\s*=\\s*(\\d+)'));
    return hit ? Number(hit[1]) : fallback;
  };
  return { sampleRate: num('rate', 24000), channels: num('channels', 1), bits: num('bits', 16) };
}

/**
 * Wraps raw little-endian PCM in a WAV header, so the browser can play it.
 * The samples are not touched; only 44 bytes are prepended.
 */
export function wavFromPcm(bytes, { sampleRate = 24000, channels = 1, bits = 16 } = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = new Uint8Array(44 + body.length);
  const dv = new DataView(out.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
  };
  const blockAlign = channels * (bits / 8);
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + body.length, true);
  ascii(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  ascii(36, 'data');
  dv.setUint32(40, body.length, true);
  out.set(body, 44);
  return out;
}

/** Does this already look like a container a player can open? */
export function hasContainer(bytes) {
  const b = bytes;
  if (!b || b.length < 4) return false;
  const magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (magic === 'RIFF' || magic === 'OggS' || magic === 'fLaC' || magic === 'FORM') return true;
  if (magic.startsWith('ID3')) return true; // mp3 with a tag
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // bare mp3 frame
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true; // ftyp: m4a/aac
  return false;
}

/**
 * Synthesises speech. Both providers expose the same OpenAI-compatible shape.
 *
 * The format asked for is not always the format that comes back: Gemini is
 * pcm or nothing, and pcm is given a WAV header here so that what the rest of
 * the app handles is always a playable file. `format` in the result is that
 * final one — the extension the file should carry.
 *
 * @returns {Promise<{bytes: Uint8Array, mime: string, format: string, requested: string}>}
 */
export async function synthesize(apiKey, model, { text, voice, format, provider = 'openrouter' } = {}) {
  const groq = provider === 'groq';
  const requested = formatFor(model, format, { provider });
  const body = { model, input: text, response_format: requested };
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
  if (!res.ok) throw new Error(speechError(await readProviderError(res), model));

  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('音声が返りませんでした');
  let bytes = new Uint8Array(buf);
  const contentType = res.headers.get('content-type') || '';

  /* Raw samples with no header: unplayable as a file, and the provider says
   * so in the content type (`audio/pcm;rate=24000;channels=1`). */
  const pcm = parsePcmType(contentType) || (requested === 'pcm' ? { sampleRate: 24000, channels: 1, bits: 16 } : null);
  if (pcm && !hasContainer(bytes)) {
    bytes = wavFromPcm(bytes, pcm);
    return { bytes, mime: 'audio/wav', format: 'wav', requested };
  }

  const format2 = requested === 'pcm' ? 'wav' : requested;
  return { bytes, mime: contentType || speechMime(format2), format: format2, requested };
}

/* Provider errors arrive in English and in their own vocabulary; the two that
 * come up in normal use are worth saying plainly. */
function speechError(message, model) {
  const text = String(message || '');
  if (/explicit voice is required|voice.*required/i.test(text)) {
    return 'このモデルはボイスの指定が必須です。読み上げ設定でボイスを選んでください（' + model + '）。';
  }
  if (/response_format/i.test(text)) {
    return '音声形式がこのモデルに対応していません: ' + text;
  }
  return text;
}
