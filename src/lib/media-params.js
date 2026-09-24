/* What can be set on a media model, described once.
 *
 * Image, video and speech models each come with some statement of what they
 * accept, and those statements are not equally trustworthy:
 *
 *   1. Images publish a typed schema (enum / range / boolean) on
 *      /images/models. It is the same source OpenRouter validates against, so
 *      a form built from it cannot offer a knob that does not exist.
 *   2. Video publishes typed lists for the common settings (durations,
 *      resolutions, aspect ratios…) and a bare list of names for provider
 *      passthrough. The names have no types, so those are typed from the
 *      table below where the meaning is known, and left as free text in the
 *      advanced section where it is not.
 *   3. Speech publishes nothing — supported_parameters is empty for every
 *      model — and unknown parameters are dropped without an error. A form
 *      built from guesses would show sliders that do nothing and still bill.
 *      So speech is a hand-kept manifest, and every entry in it was checked
 *      against the live endpoint by measuring the audio and transcribing it
 *      (see SPEECH_FAMILIES).
 *
 * Everything becomes the same field shape, which the browser turns into a
 * form and the server uses to validate what comes back. The server never
 * trusts the form: sanitizeParams() re-checks every value against the field
 * it claims to be for, and drops anything without one.
 *
 * Field:
 *   { key, label, type, values?, min?, max?, step?, default?, advanced?,
 *     target: 'body' | 'passthrough' | 'speech', hint? }
 *   type: 'enum' | 'range' | 'number' | 'boolean' | 'text' | 'longtext' | 'tags' | 'raw'
 */

/* -------------------------------- labels --------------------------------- */

const LABELS = {
  aspect_ratio: 'アスペクト比',
  quality: '品質',
  resolution: '解像度',
  background: '背景',
  output_format: '出力形式',
  output_compression: '圧縮率',
  seed: 'シード',
  duration: '長さ（秒）',
  size: 'サイズ',
  generate_audio: '音声も生成',
  style: 'スタイル',
  moderation: 'モデレーション',
};
const labelFor = (key) => LABELS[key] || key.replace(/_/g, ' ');

/* Parameters the studios handle with their own controls, not the form. */
const IMAGE_OWN = new Set(['n', 'input_references']);

/* -------------------------------- images --------------------------------- */

/** Fields from an image model's published schema, in a stable order. */
export function imageFields(schema = {}) {
  const order = ['aspect_ratio', 'resolution', 'quality', 'background', 'output_format', 'output_compression', 'seed'];
  const keys = Object.keys(schema || {})
    .filter((k) => !IMAGE_OWN.has(k))
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));

  const fields = [];
  for (const key of keys) {
    const spec = schema[key] || {};
    const base = { key, label: labelFor(key), target: 'body' };
    if (key === 'seed') {
      // Declared as a boolean ("the model takes one"), entered as a number.
      fields.push({ ...base, type: 'number', min: 0, max: 2147483647, step: 1, advanced: true, hint: '空欄ならランダム' });
    } else if (spec.type === 'enum' && Array.isArray(spec.values) && spec.values.length) {
      if (spec.values.length === 1) continue; // nothing to choose
      fields.push({ ...base, type: 'enum', values: spec.values, advanced: key === 'output_format' });
    } else if (spec.type === 'range' && Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max))) {
      if (Number(spec.min) === Number(spec.max)) continue;
      const span = Number(spec.max) - Number(spec.min);
      fields.push({ ...base, type: span > 1000 ? 'number' : 'range', min: Number(spec.min), max: Number(spec.max), step: span <= 1 ? 0.01 : 1, advanced: true });
    } else if (spec.type === 'boolean') {
      fields.push({ ...base, type: 'boolean', advanced: true });
    }
  }
  return fields;
}

/* --------------------------------- video --------------------------------- */

/* Passthrough names mean different things per provider, and OpenRouter gives
 * them no types. These are the ones whose meaning is plain from the name and
 * the provider's own docs; the rest stay free text. */
const PASSTHROUGH_TYPES = {
  negative_prompt: { type: 'text', label: 'ネガティブプロンプト' },
  negativePrompt: { type: 'text', label: 'ネガティブプロンプト' },
  prompt_extend: { type: 'boolean', label: 'プロンプトを自動で補強' },
  enhancePrompt: { type: 'boolean', label: 'プロンプトを自動で補強' },
  enable_prompt_expansion: { type: 'boolean', label: 'プロンプトを自動で補強' },
  prompt_optimizer: { type: 'boolean', label: 'プロンプトを自動で最適化' },
  watermark: { type: 'boolean', label: '透かしを入れる' },
  aigc_watermark: { type: 'boolean', label: 'AI生成の透かしを入れる' },
  return_last_frame: { type: 'boolean', label: '最終フレームも返す' },
  fast_pretreatment: { type: 'boolean', label: '前処理を高速化' },
  cfg_scale: { type: 'range', label: 'プロンプトへの忠実度', min: 0, max: 1, step: 0.05 },
  conditioningScale: { type: 'number', label: '条件付けの強さ' },
};

/* Names that duplicate a built-in setting, take a media file rather than a
 * value, or are internal routing keys. Offering them as text boxes would only
 * invite a request that fails. */
const PASSTHROUGH_HIDDEN = new Set([
  'aspectRatio', 'ratio', 'size', 'resolution', 'duration',
  'audio', 'last_image', 'video', 'videos', 'images', 'image',
  'req_key',
]);

/* How each provider wants its options nested. OpenRouter's docs show Vertex
 * taking them under `parameters`; the others are forwarded flat. */
const PASSTHROUGH_WRAP = { 'google-vertex': 'parameters' };

export function videoFields(model = {}) {
  const f = [];
  const body = (key, extra) => f.push({ key, label: labelFor(key), target: 'body', ...extra });
  if (model.durations?.length > 1) body('duration', { type: 'enum', values: model.durations, default: model.durations.includes(5) ? 5 : model.durations[0] });
  if (model.resolutions?.length > 1) body('resolution', { type: 'enum', values: model.resolutions, default: model.resolutions[0] });
  if (model.aspectRatios?.length > 1) body('aspect_ratio', { type: 'enum', values: model.aspectRatios });
  if (model.sizes?.length > 1) body('size', { type: 'enum', values: model.sizes, hint: '指定すると解像度より優先' });
  if (model.generateAudio) body('generate_audio', { type: 'boolean', default: false });
  if (model.seed) body('seed', { type: 'number', min: 0, max: 2147483647, step: 1, advanced: true, hint: '空欄ならランダム' });

  for (const name of model.passthrough || []) {
    if (PASSTHROUGH_HIDDEN.has(name)) continue;
    const known = PASSTHROUGH_TYPES[name];
    f.push({
      key: name,
      label: known?.label || name,
      target: 'passthrough',
      advanced: true,
      ...(known || { type: 'raw', hint: 'プロバイダ固有の値（true / 数値 / 文字列）' }),
    });
  }
  return f;
}

/** Where passthrough values go in the request body. */
export function passthroughBody(providerTag, values) {
  if (!providerTag || !values || !Object.keys(values).length) return null;
  const wrap = PASSTHROUGH_WRAP[providerTag];
  return { options: { [providerTag]: wrap ? { [wrap]: values } : values } };
}

/* -------------------------------- speech --------------------------------- */

/* Google ships one cast across its TTS models. */
export const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

const SPEED = { key: 'speed', label: '話す速さ', type: 'range', min: 0.5, max: 2, step: 0.1, default: 1, target: 'speech' };

/* Every row below was measured on 2026-09-24 against OpenRouter, with the same
 * sentence each time (about 3.8s at normal pace), and transcribed with Whisper
 * to confirm the control itself was not spoken.
 *
 *   Gemini   `[slowly]` → 8.0s, `[extremely slowly]` → 10.2s, `[ゆっくり]` →
 *            7.3s, `[laughing]` adds a laugh; none of them spoken. Prefixing
 *            a sentence of instruction instead ("ゆっくり読んで: …") was read
 *            out loud, word for word. `instructions` and `speed` are ignored,
 *            and google-ai-studio provider options are rejected with a 400.
 *   MiniMax  top-level `speed` 0.5 → 7.0s, 2.0 → 1.9s. `<#1.5#>` inserts a
 *            1.5s pause. Everything under provider.options.minimax — pitch,
 *            emotion, and a made-up key — is accepted and silently dropped.
 *            mp3 only.
 *   Azure    `speed` 0.5 → 11.7s. Style options return 400.
 *   Fish     `speed` 0.5 → 8.2s; `(whispering)` is not spoken. No voice needed.
 *   Kokoro   `speed` 0.5 → 9.0s.
 *   xAI      six voices answer; `speed` is ignored.
 *   GPT      only through chat completions with audio output, streamed, as
 *            pcm16. Without a system prompt it *answers* the text instead of
 *            reading it; with one, style instructions work (4.1s → 6.4s) and
 *            are not spoken.
 *   Qwen     rejects every voice name tried (DashScope and Qwen3-TTS casts
 *            alike) and publishes none, so it takes a typed voice and says so.
 */
export const SPEECH_FAMILIES = [
  {
    id: 'gemini',
    match: /gemini.*tts/i,
    format: 'pcm',
    voices: GEMINI_VOICES,
    style: {
      kind: 'tags',
      wrap: (t) => '[' + t + ']',
      presets: [
        ['ゆっくり', 'slowly'],
        ['とてもゆっくり', 'extremely slowly'],
        ['ささやき', 'whispering'],
        ['元気に', 'excited'],
        ['落ち着いて', 'calm'],
        ['叫ぶ', 'shouting'],
        ['笑いながら', 'laughing'],
      ],
      hint: '読み方は [ ] のタグとして先頭に付きます（タグ自体は読み上げられません）。日本語のタグも有効です。',
    },
  },
  {
    id: 'minimax',
    match: /^minimax\//,
    format: 'mp3',
    voices: [
      'Japanese_KindLady', 'female-shaonv',
    ],
    freeVoice: true,
    speed: true,
    hint: '文中に <#1.5#> と書くと、その位置に 1.5 秒の間が入ります。',
  },
  {
    id: 'azure',
    match: /^microsoft\/mai-voice/,
    voices: ['en-US-Harper:MAI-Voice-2', 'en-US-Jasper:MAI-Voice-2'],
    freeVoice: true,
    speed: true,
  },
  {
    id: 'fish',
    match: /^fish-audio\//,
    voices: [],
    freeVoice: true,
    voiceOptional: true,
    speed: true,
    style: {
      kind: 'tags',
      wrap: (t) => '(' + t + ')',
      presets: [
        ['ささやき', 'whispering'],
        ['元気に', 'excited'],
        ['悲しげに', 'sad'],
        ['落ち着いて', 'calm'],
      ],
      hint: '読み方は ( ) のタグとして先頭に付きます（タグ自体は読み上げられません）。',
    },
  },
  { id: 'kokoro', match: /kokoro/i, speed: true },
  { id: 'xai', match: /^x-ai\/grok-voice/, voices: ['Eve', 'Ara', 'Rex', 'Sal', 'Leo', 'Una'] },
  {
    id: 'gpt-audio',
    match: /^openai\/gpt-audio/,
    route: 'chat',
    format: 'pcm16',
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
    style: {
      kind: 'instructions',
      presets: ['ゆっくり丁寧に', '明るく元気に', 'ニュースキャスターのように', 'ささやくように', '感情を込めて'],
      hint: '自然な文章で読み方を指示できます（指示は読み上げられません）。',
    },
  },
  {
    id: 'qwen',
    match: /^qwen\/.*tts/i,
    voices: [],
    freeVoice: true,
    hint: 'このモデルはボイスIDが公開されておらず、試した名前はすべて拒否されました。DashScope のボイスIDを直接入力してください。',
  },
];

export const speechFamily = (model) => SPEECH_FAMILIES.find((f) => f.match.test(String(model || ''))) || null;

/** Fields for a speech model. Voice stays with the voice picker; this is the rest. */
export function speechFields(model) {
  const fam = speechFamily(model);
  if (!fam) return [];
  const f = [];
  if (fam.freeVoice) {
    f.push({
      key: 'voice_custom',
      label: fam.voices?.length ? 'ボイスID（一覧以外を使う場合）' : 'ボイスID',
      type: 'text',
      target: 'speech',
      advanced: !!fam.voices?.length,
      hint: fam.voiceOptional ? '空欄ならモデル既定の声' : undefined,
    });
  }
  if (fam.speed) f.push({ ...SPEED });
  if (fam.style?.kind === 'tags') {
    f.push({
      key: 'style_tags',
      label: '読み方',
      type: 'tags',
      values: fam.style.presets.map(([label, tag]) => ({ label, value: tag })),
      target: 'speech',
      hint: fam.style.hint,
    });
  } else if (fam.style?.kind === 'instructions') {
    f.push({
      key: 'instructions',
      label: '読み方の指示',
      type: 'longtext',
      values: fam.style.presets,
      target: 'speech',
      hint: fam.style.hint,
    });
  }
  return f;
}

/** The text actually sent, with style tags folded in where the family uses them. */
export function styledText(model, text, values = {}) {
  const fam = speechFamily(model);
  const tags = Array.isArray(values.style_tags) ? values.style_tags : [];
  if (!fam?.style || fam.style.kind !== 'tags' || !tags.length) return text;
  return tags.map((t) => fam.style.wrap(t)).join(' ') + ' ' + text;
}

/* ------------------------------ validation ------------------------------- */

const MAX_TEXT = 2000;

function coerceRaw(value) {
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[[{]/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      /* fall through to a string */
    }
  }
  return s.slice(0, MAX_TEXT);
}

/**
 * Checks submitted values against the fields they claim to be for.
 * Unknown keys are dropped and reported, never forwarded.
 *
 * @returns {{ body: object, passthrough: object, speech: object, dropped: string[] }}
 */
export function sanitizeParams(fields, values) {
  const out = { body: {}, passthrough: {}, speech: {}, dropped: [] };
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(values || {})) {
    const field = byKey.get(key);
    if (!field) {
      out.dropped.push(key);
      continue;
    }
    let value;
    switch (field.type) {
      case 'enum': {
        // Values arrive as strings from a <select>; keep the schema's own type.
        const hit = field.values.find((v) => String(v) === String(raw));
        value = hit;
        break;
      }
      case 'range':
      case 'number': {
        if (raw === '' || raw === null || raw === undefined) break;
        const n = Number(raw);
        if (!Number.isFinite(n)) break;
        const lo = field.min ?? -Infinity;
        const hi = field.max ?? Infinity;
        value = Math.min(hi, Math.max(lo, n));
        if (field.step >= 1) value = Math.round(value);
        break;
      }
      case 'boolean':
        if (raw === '' || raw === null || raw === undefined) break;
        value = raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'on';
        break;
      case 'text':
      case 'longtext': {
        const s = String(raw ?? '').trim();
        if (s) value = s.slice(0, MAX_TEXT);
        break;
      }
      case 'tags': {
        const list = (Array.isArray(raw) ? raw : String(raw || '').split(','))
          .map((t) => String(t).replace(/[[\]()]/g, '').trim())
          .filter(Boolean)
          .slice(0, 6)
          .map((t) => t.slice(0, 40));
        if (list.length) value = list;
        break;
      }
      case 'raw':
        value = coerceRaw(raw);
        break;
      default:
        break;
    }
    if (value === undefined) continue;
    out[field.target === 'passthrough' ? 'passthrough' : field.target === 'speech' ? 'speech' : 'body'][key] = value;
  }
  return out;
}
