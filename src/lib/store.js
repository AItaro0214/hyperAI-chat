import { seal, unseal } from './crypto.js';
import { maskSecret, now } from './auth.js';

export const SECRET_KEYS = [
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'RUNPOD_API_KEY',
  // Raw web search, for the self-hosted model that has none of its own.
  'OLLAMA_API_KEY',
  'BRAVE_API_KEY',
];

/* ---------------------------- sealed API keys ---------------------------
 * Keys entered in the admin console are sealed with AES-256-GCM using
 * MASTER_KEY (a Cloudflare Worker secret) and only the ciphertext is stored
 * in D1. Plaintext is never returned by any API route: the console only ever
 * sees the masked hint.
 * ---------------------------------------------------------------------- */
export async function getApiKey(env, name) {
  const row = await env.DB.prepare('SELECT value_enc FROM app_secrets WHERE key = ?').bind(name).first();
  if (row?.value_enc) {
    try {
      return await unseal(env.MASTER_KEY, row.value_enc);
    } catch (e) {
      console.error('failed to unseal ' + name, e);
    }
  }
  // Fallback: a plain Worker secret of the same name, useful for bootstrap.
  return env[name] || null;
}

export async function setApiKey(env, name, value, userId) {
  const enc = await seal(env.MASTER_KEY, value);
  await env.DB.prepare(
    'INSERT INTO app_secrets (key, value_enc, hint, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, hint = excluded.hint, ' +
      'updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  )
    .bind(name, enc, maskSecret(value), now(), userId || null)
    .run();
}

export async function deleteApiKey(env, name) {
  await env.DB.prepare('DELETE FROM app_secrets WHERE key = ?').bind(name).run();
}

export async function listApiKeys(env) {
  const { results } = await env.DB.prepare('SELECT key, hint, updated_at FROM app_secrets').all();
  const byKey = Object.fromEntries((results || []).map((r) => [r.key, r]));
  return SECRET_KEYS.map((key) => ({
    key,
    configured: !!byKey[key] || !!env[key],
    source: byKey[key] ? 'secret-store' : env[key] ? 'worker-env' : null,
    hint: byKey[key]?.hint || (env[key] ? 'worker env var' : null),
    updated_at: byKey[key]?.updated_at || null,
  }));
}

/* ------------------------------- settings ------------------------------- */
export const DEFAULT_SETTINGS = {
  defaultProvider: 'openrouter',
  defaultModel: 'anthropic/claude-sonnet-5',
  systemPrompt: '',
  // Empty / 0 means "send nothing and let the provider use its own default",
  // which is almost always the model's full capability.
  temperature: '',
  maxTokens: 0,
  webSearchDefault: true,
  imageDefault: true,
  // "server" hands the model OpenRouter's server-side tools and lets it decide
  // when to search. The other values search on every single turn.
  webSearchEngine: 'server', // server | exa | native | auto
  imageMode: 'server', // server = model decides | force = always emit an image
  webSearchMaxResults: 5,
  reasoningEffort: '', // '' (provider default) | low | medium | high | off
  // Groq compound only: domain filters, country bias, and dropping
  // visit_website so whole pages never enter the context.
  groqSearch: { includeDomains: [], excludeDomains: [], country: '', snippetOnly: false },
  historyLimit: 0, // 0 = 全件（コンテキストに収まる範囲で自動調整）
  // Agent runs carry this many characters of the room's prior turns. 0 = off.
  agentHistoryChars: 6000,

  /* Breakthrough mode: a self-hosted model on a rented GPU. Serverless with
   * no volume, so an idle endpoint costs nothing and is kept between uses. */
  breakthrough: false,
  runpodEndpointId: '',
  runpodTemplateId: '',
  runpodModel: '',
  // A self-hosted model has no built-in search; xAI runs it as a tool instead.
  breakthroughSearch: true,
  // Raw results, not another model's summary — see search.js.
  searchBackend: 'ollama',
  searxngUrl: '',
  asrModel: 'whisper-large-v3-turbo',
  ttsModel: 'google/gemini-3.1-flash-tts-preview',
  ttsVoice: 'Kore',
  imageModel: 'google/gemini-3.1-flash-image',
  showCost: true,
};

export async function getSettings(env) {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind('app').first();
  let stored = {};
  if (row?.value) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = {};
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = { ...current, ...patch };
  await env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  )
    .bind('app', JSON.stringify(next), now())
    .run();
  return next;
}

export async function getJsonSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first();
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export async function setJsonSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  )
    .bind(key, JSON.stringify(value), now())
    .run();
  return value;
}

/* ----------------------------- usage logging ---------------------------- */
export async function logUsage(env, entry) {
  try {
    await env.DB.prepare(
      'INSERT INTO usage_log (user_id, room_id, provider, model, kind, prompt_tokens, completion_tokens, units, cost, at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        entry.userId || null,
        entry.roomId || null,
        entry.provider || null,
        entry.model || null,
        entry.kind || null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        entry.units ?? null,
        entry.cost ?? null,
        now()
      )
      .run();
  } catch (e) {
    console.error('logUsage failed', e);
  }
}
