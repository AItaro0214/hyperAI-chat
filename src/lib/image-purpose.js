/* Which image model suits which job.
 *
 * The agent should not have to reason about 50 model slugs, so it picks a
 * purpose and this resolves it against whatever the live catalogue actually
 * offers. Each entry is a preference order, so a retired model degrades to the
 * next candidate rather than failing. */

export const PURPOSES = {
  fast: {
    label: '速い・安い',
    hint: '下書きや大量生成向け',
    models: ['google/gemini-3.1-flash-lite-image', 'google/gemini-3.1-flash-image', 'openai/gpt-image-1-mini'],
  },
  icon: {
    label: 'アイコン・UI素材',
    hint: '輪郭のはっきりした小さな素材',
    models: ['recraft/recraft-v4.1', 'recraft/recraft-v4', 'openai/gpt-image-1-mini', 'google/gemini-3.1-flash-image'],
  },
  vector: {
    label: 'ベクター（SVG）',
    hint: 'ロゴやアイコンを拡大しても劣化しない形式で',
    models: ['recraft/recraft-v4.1-vector', 'recraft/recraft-v4-vector', 'recraft/recraft-v4-styles-vector'],
    format: 'svg',
  },
  photo: {
    label: '写真・リアル',
    hint: 'ヒーロー画像や背景写真',
    models: ['bytedance-seed/seedream-5-0-pro', 'bytedance-seed/seedream-4.5', 'google/gemini-3-pro-image'],
  },
  illustration: {
    label: 'イラスト・アート',
    hint: '挿絵やキャラクター',
    models: ['qwen/qwen-image-3-pro', 'qwen/qwen-image-3', 'krea/krea-2-large'],
  },
  text: {
    label: '文字入り',
    hint: 'バナーなど画像内に文字を入れる場合',
    models: ['openai/gpt-image-2', 'openai/gpt-image-1', 'openai/gpt-image-1-mini'],
  },
};

export const PURPOSE_KEYS = Object.keys(PURPOSES);

/** Video models: the money here is per second, so the split is cost vs finish. */
export const VIDEO_PURPOSES = {
  fast: {
    label: '速い・安い',
    hint: '確認用や短いループ',
    models: ['bytedance/seedance-2.0-mini', 'bytedance/seedance-2.5', 'minimax/hailuo-3'],
  },
  quality: {
    label: '高品質',
    hint: '仕上げ・本番用',
    models: ['google/veo-3.1', 'bytedance/seedance-2.5', 'minimax/hailuo-3'],
  },
  audio: {
    label: '音声つき',
    hint: '効果音やセリフを含む映像',
    models: ['google/veo-3.1', 'minimax/hailuo-3'],
  },
};
export const VIDEO_PURPOSE_KEYS = Object.keys(VIDEO_PURPOSES);

/** Speech models. Japanese quality is the axis that matters most here. */
export const SPEECH_PURPOSES = {
  natural: {
    label: '自然・日本語向き',
    hint: '通常のナレーション',
    models: ['google/gemini-3.1-flash-tts-preview', 'qwen/qwen-audio-3.0-tts-flash', 'openai/gpt-audio-mini'],
  },
  quality: {
    label: '高品質',
    hint: '作品用の読み上げ',
    models: ['qwen/qwen-audio-3.0-tts-plus', 'minimax/speech-2.8-hd', 'openai/gpt-audio'],
  },
  free: {
    label: '無料',
    hint: '下読みや大量生成',
    models: ['deepgram/flux-tts:free', 'fish-audio/s2.1-pro-free:free', 'google/gemini-3.1-flash-tts-preview'],
  },
};
export const SPEECH_PURPOSE_KEYS = Object.keys(SPEECH_PURPOSES);

/** Builds the enum help text for any of the purpose tables above. */
export const helpFor = (table) =>
  Object.keys(table).map((k) => k + '（' + table[k].label + '：' + table[k].hint + '）').join('、');

/** A one-line summary for the tool description, built from the table above. */
export const purposeHelp = () =>
  PURPOSE_KEYS.map((k) => k + '（' + PURPOSES[k].label + '：' + PURPOSES[k].hint + '）').join('、');

/* Loose names people actually use, mapped to the id fragment that identifies
 * the family. Order matters: the first hit wins. */
const ALIASES = [
  [/gpt|openai|チャットgpt|ジーピーティー|dall|ダリ/i, 'openai/gpt'],
  [/nano\s*banana|ナノバナナ/i, 'google/gemini-3.1-flash-image'],
  [/veo|ヴェオ|ベオ/i, 'google/veo'],
  [/seedance|シードダンス|シーダンス/i, 'bytedance/seedance'],
  [/hailuo|ハイルオ|海螺/i, 'minimax/hailuo'],
  [/gemini|ジェミニ|google|グーグル/i, 'google/gemini'],
  [/seedream|シードリーム/i, 'bytedance-seed/seedream'],
  [/flux|フラックス|black\s*forest|bfl/i, 'black-forest-labs/flux'],
  [/recraft|リクラフト/i, 'recraft/recraft'],
  [/qwen|クウェン|キュウェン|alibaba/i, 'qwen/'],
  [/grok|グロック|x-?ai|イーロン/i, 'x-ai/grok'],
  [/wan|ワン/i, 'alibaba/wan'],
  [/krea|クレア/i, 'krea/krea'],
  [/minimax|ミニマックス/i, 'minimax/'],
  [/orpheus|オルフェウス/i, 'canopylabs/orpheus'],
  [/deepgram|aura/i, 'deepgram/'],
  [/kokoro|コウ?コロ/i, 'hexgrad/kokoro'],
  [/mai|microsoft|マイクロソフト/i, 'microsoft/mai'],
  [/riverflow|sourceful/i, 'sourceful/riverflow'],
  [/muse|meta|メタ/i, 'meta/muse'],
];

/* Words that appear in half the catalogue; on their own they identify nothing,
 * so they never drive a match — they only break ties. */
const GENERIC = new Set([
  'pro', 'max', 'mini', 'lite', 'flash', 'turbo', 'fast', 'plus', 'ultra', 'preview', 'exp',
  'image', 'images', 'video', 'audio', 'speech', 'tts', 'model', 'models', 'ai', 'v', 'the',
]);

const squash = (s) => String(s).toLowerCase().replace(/[\s._\-/]/g, '');

/** Digit runs, so "seedance2.5" prefers 2.5 over 1.5. */
const versionsIn = (s) => String(s).toLowerCase().match(/\d+(?:[.\-_]\d+)*/g) || [];

/**
 * Cheap "is this the plain flagship" score, to avoid picking odd variants.
 * A loose name like "gpt" should land on the main model, not the mini one.
 */
function tierScore(id) {
  let score = 0;
  if (/:(free|batch)$/.test(id)) score -= 6;
  if (/vector/.test(id)) score -= 4;
  if (/utility|styles/.test(id)) score -= 2;
  if (/mini|lite|turbo|fast/.test(id)) score -= 2;
  if (/flash/.test(id)) score -= 1;
  if (/-pro|-max/.test(id)) score += 3;
  return score;
}

/**
 * Turns a loose model name — "GPTの画像生成", "seedance2.5", "flux2 pro" — into
 * a concrete id, so a prompt can name a model without knowing slugs.
 */
export function resolveModelHint(catalogue, hint) {
  const raw = String(hint || '').trim();
  if (!raw) return null;

  const exact = catalogue.find((m) => m.id === raw);
  if (exact) return exact;

  const flat = squash(raw);
  const wantsVector = /vector|ベクター|svg/i.test(raw);
  const wantedVersions = versionsIn(raw).map(squash);
  // Japanese carries particles, so only the latin runs are usable as tokens.
  const tokens = (raw.toLowerCase().match(/[a-z0-9][a-z0-9.]*/g) || [])
    .map(squash)
    .filter((t) => t.length >= 2);
  const strong = tokens.filter((t) => !GENERIC.has(t));
  const modifiers = tokens.filter((t) => GENERIC.has(t));

  /** Ranks candidates: exact version wins, then the requested modifier, then tier. */
  const rank = (list) => {
    const pool = wantsVector ? list.filter((m) => /vector/.test(m.id)) : list;
    const use = pool.length ? pool : list;
    return use
      .slice()
      .sort((a, b) => score(b) - score(a))[0];

    function score(m) {
      const id = squash(m.id);
      let s = tierScore(m.id);
      if (wantedVersions.length) {
        s += wantedVersions.some((v) => id.includes(v)) ? 10 : -4;
      }
      // "seedance mini" should reach the mini, despite the tier penalty.
      for (const mod of modifiers) if (id.includes(mod)) s += 6;
      return s;
    }
  };

  const contains = (needle) => catalogue.filter((m) => squash(m.id).includes(needle));

  // Whole phrase first: "gptimage2" pins the model outright.
  const whole = contains(flat);
  if (whole.length) return rank(whole);

  // Then every meaningful token has to appear somewhere in the id.
  if (strong.length) {
    const all = catalogue.filter((m) => {
      const id = squash(m.id);
      return strong.every((t) => id.includes(t));
    });
    if (all.length) return rank(all);

    for (const token of strong) {
      const hits = contains(token);
      if (hits.length) return rank(hits);
    }
  }

  for (const [pattern, fragment] of ALIASES) {
    if (!pattern.test(raw)) continue;
    const family = catalogue.filter((m) => squash(m.id).includes(squash(fragment)));
    if (family.length) return rank(family);
  }
  return null;
}

/**
 * Resolves a request to a concrete model in the live catalogue.
 * @param {{id: string}[]} catalogue
 * @returns {{model: object|null, format: string|null, why: string}}
 */
export function pickModel(catalogue, table, { model, purpose, fallback, defaultId } = {}) {
  const has = (id) => catalogue.find((m) => m.id === id);

  if (model) {
    const matched = resolveModelHint(catalogue, model);
    if (matched) return { model: matched, format: /vector/.test(matched.id) ? 'svg' : null, why: '指定: ' + model };
  }

  const spec = purpose ? table[String(purpose).toLowerCase()] : null;
  if (spec) {
    for (const id of spec.models) {
      const found = has(id);
      if (found) return { model: found, format: spec.format || null, why: purpose };
    }
  }

  const chosen = (fallback && has(fallback)) || (defaultId && has(defaultId)) || catalogue[0] || null;
  return { model: chosen, format: null, why: spec ? purpose + '（候補が見つからず既定）' : '既定' };
}

export const pickImageModel = (catalogue, opts = {}) =>
  pickModel(catalogue, PURPOSES, { ...opts, defaultId: 'google/gemini-3.1-flash-image' });

export const pickVideoModel = (catalogue, opts = {}) =>
  pickModel(catalogue, VIDEO_PURPOSES, { ...opts, defaultId: 'bytedance/seedance-2.0-mini' });

export const pickSpeechModel = (catalogue, opts = {}) =>
  pickModel(catalogue, SPEECH_PURPOSES, { ...opts, defaultId: 'google/gemini-3.1-flash-tts-preview' });

/** Vector output only makes sense with an .svg name. */
export function fixExtension(path, format) {
  if (!format) return path;
  const clean = String(path || 'asset');
  return /\.[a-z0-9]+$/i.test(clean) ? clean.replace(/\.[a-z0-9]+$/i, '.' + format) : clean + '.' + format;
}
