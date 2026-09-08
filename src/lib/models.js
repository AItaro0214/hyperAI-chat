import { GROQ_PRICING, OPENROUTER_TOOL_PRICING } from '../data/groq-pricing.js';
import { getApiKey, getJsonSetting } from './store.js';

const CACHE_TTL_SEC = 1800; // 30 min
// Bump when the normalized model shape changes so cached entries are not
// served without the new fields.
const SCHEMA = 'v2';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

export const FAMILIES = ['GPT', 'Claude', 'Gemini', 'Qwen', 'Kimi', 'GLM', 'Llama', 'DeepSeek', 'Grok', 'Mistral', 'その他'];

export function familyOf(id, name = '') {
  const s = (id + ' ' + name).toLowerCase();
  if (/(^|\/)openai\//.test(id) || /\bgpt|\bo[134]-|codex/.test(s)) {
    if (/gpt-oss/.test(s)) return 'GPT';
    return 'GPT';
  }
  if (/anthropic|claude/.test(s)) return 'Claude';
  if (/google|gemini|gemma/.test(s)) return 'Gemini';
  if (/qwen|alibaba/.test(s)) return 'Qwen';
  if (/moonshot|kimi/.test(s)) return 'Kimi';
  if (/z-ai|zhipu|thudm|glm|chatglm/.test(s)) return 'GLM';
  if (/llama|meta-llama/.test(s)) return 'Llama';
  if (/deepseek/.test(s)) return 'DeepSeek';
  if (/x-ai|grok/.test(s)) return 'Grok';
  if (/mistral|magistral|codestral|ministral/.test(s)) return 'Mistral';
  return 'その他';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// OpenRouter prices are USD per token (per request/image for some fields).
function normalizeOpenRouterPricing(p = {}) {
  return {
    input_per_m: num(p.prompt) * 1e6,
    output_per_m: num(p.completion) * 1e6,
    cache_read_per_m: num(p.input_cache_read) * 1e6,
    cache_write_per_m: num(p.input_cache_write) * 1e6,
    reasoning_per_m: num(p.internal_reasoning) * 1e6,
    image_input: num(p.image),
    image_output: num(p.image_output ?? p.output_image ?? 0),
    audio_per_m: num(p.audio) * 1e6,
    per_request: num(p.request),
    web_search: num(p.web_search),
  };
}

function groqKind(id) {
  const s = id.toLowerCase();
  if (s.includes('whisper')) return 'asr';
  if (s.includes('tts') || s.includes('orpheus')) return 'tts';
  if (s.includes('guard') && !s.includes('safeguard')) return 'moderation';
  return 'chat';
}

function normalizeGroqPricing(id, table) {
  const p = table.models?.[id];
  if (!p) return null;
  if (p.kind === 'asr') return { kind: 'asr', per_hour: p.per_hour };
  if (p.kind === 'tts') return { kind: 'tts', per_million_chars: p.per_million_chars };
  return {
    kind: 'chat',
    input_per_m: p.input,
    output_per_m: p.output,
    cache_read_per_m: p.cached_input ?? null,
    note: p.note || null,
  };
}

async function cached(env, key, ttl, loader) {
  if (env.KV) {
    const hit = await env.KV.get('cache:' + key, 'json');
    if (hit && hit.at && Date.now() - hit.at < ttl * 1000) return hit.data;
  }
  const data = await loader();
  if (env.KV) {
    await env.KV.put('cache:' + key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: ttl * 4 });
  }
  return data;
}

async function stale(env, key) {
  if (!env.KV) return null;
  const hit = await env.KV.get('cache:' + key, 'json');
  return hit?.data ?? null;
}

export async function fetchOpenRouterModels(env, { force = false } = {}) {
  const load = async () => {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('OpenRouter /models ' + res.status);
    const json = await res.json();
    return (json.data || []).map((m) => ({
      ref: 'openrouter:' + m.id,
      provider: 'openrouter',
      id: m.id,
      name: m.name || m.id,
      family: familyOf(m.id, m.name),
      kind: 'chat',
      description: (m.description || '').slice(0, 400),
      created: m.created || 0,
      context: m.context_length || m.top_provider?.context_length || null,
      maxOutput: m.top_provider?.max_completion_tokens || null,
      input: m.architecture?.input_modalities || ['text'],
      output: m.architecture?.output_modalities || ['text'],
      supported: m.supported_parameters || [],
      tools: (m.supported_parameters || []).includes('tools'),
      reasoning: (m.supported_parameters || []).includes('reasoning'),
      // OpenRouter marks its free tier with a ":free" suffix; a few others are
      // simply priced at zero.
      free: /:free$/.test(m.id) || (num(m.pricing?.prompt) === 0 && num(m.pricing?.completion) === 0),
      pricing: normalizeOpenRouterPricing(m.pricing),
    }));
  };
  if (force) {
    const data = await load();
    if (env.KV) await env.KV.put('cache:models:openrouter:' + SCHEMA, JSON.stringify({ at: Date.now(), data }), { expirationTtl: CACHE_TTL_SEC * 4 });
    return data;
  }
  return cached(env, 'models:openrouter:' + SCHEMA, CACHE_TTL_SEC, load);
}

export async function fetchGroqModels(env, { force = false } = {}) {
  const key = await getApiKey(env, 'GROQ_API_KEY');
  if (!key) return [];
  const table = await getGroqPricing(env);
  const load = async () => {
    const res = await fetch(GROQ_MODELS_URL, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('Groq /models ' + res.status);
    const json = await res.json();
    return (json.data || [])
      .filter((m) => m.active !== false)
      .map((m) => {
        const kind = groqKind(m.id);
        const vision = /llama-4|scout|maverick|vision/.test(m.id.toLowerCase());
        return {
          ref: 'groq:' + m.id,
          provider: 'groq',
          id: m.id,
          name: m.id,
          family: familyOf(m.id),
          kind,
          description: 'Groq / owned by ' + (m.owned_by || 'unknown'),
          created: m.created || 0,
          context: m.context_window || null,
          maxOutput: m.max_completion_tokens || null,
          input: kind === 'asr' ? ['audio'] : vision ? ['text', 'image'] : ['text'],
          output: kind === 'tts' ? ['audio'] : ['text'],
          supported: [],
          tools: kind === 'chat',
          reasoning: /gpt-oss|qwen3|deepseek-r1/.test(m.id.toLowerCase()),
          browserSearch: /gpt-oss/.test(m.id.toLowerCase()),
          free: false,
          pricing: null,
        };
      });
  };
  let list;
  try {
    list = force ? await load() : await cached(env, 'models:groq:' + SCHEMA, CACHE_TTL_SEC, load);
  } catch (e) {
    console.error('groq models', e);
    list = (await stale(env, 'models:groq:' + SCHEMA)) || [];
  }
  // Pricing table may have been edited since the list was cached.
  return list.map((m) => ({ ...m, pricing: normalizeGroqPricing(m.id, table) }));
}

export async function getGroqPricing(env) {
  const override = await getJsonSetting(env, 'groq_pricing', null);
  if (override && override.models) return override;
  return GROQ_PRICING;
}

export function toolPricing() {
  return OPENROUTER_TOOL_PRICING;
}

export async function getCatalog(env, { force = false } = {}) {
  const errors = [];
  let openrouter = [];
  let groq = [];
  try {
    openrouter = await fetchOpenRouterModels(env, { force });
  } catch (e) {
    errors.push('openrouter: ' + e.message);
    openrouter = (await stale(env, 'models:openrouter:' + SCHEMA)) || [];
  }
  try {
    groq = await fetchGroqModels(env, { force });
  } catch (e) {
    errors.push('groq: ' + e.message);
  }
  return { models: [...openrouter, ...groq], errors, updatedAt: Date.now() };
}

export function findModel(catalog, ref) {
  return catalog.models.find((m) => m.ref === ref) || null;
}

/* --------------------------- cost calculation --------------------------- */
export function estimateChatCost(model, usage) {
  if (!model?.pricing || !usage) return null;
  const p = model.pricing;
  const inTok = usage.prompt_tokens || 0;
  const outTok = usage.completion_tokens || 0;
  if (model.provider === 'openrouter') {
    return (inTok / 1e6) * (p.input_per_m || 0) + (outTok / 1e6) * (p.output_per_m || 0);
  }
  if (p.kind === 'chat' && p.input_per_m != null) {
    return (inTok / 1e6) * p.input_per_m + (outTok / 1e6) * (p.output_per_m || 0);
  }
  return null;
}

export function estimateAsrCost(model, seconds) {
  const per = model?.pricing?.per_hour;
  if (!per || !seconds) return null;
  return (seconds / 3600) * per;
}

export function estimateTtsCost(model, chars) {
  const per = model?.pricing?.per_million_chars;
  if (!per || !chars) return null;
  return (chars / 1e6) * per;
}
