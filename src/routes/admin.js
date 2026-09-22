import { Hono } from 'hono';
import {
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  seal,
  timingSafeEqual,
  totpUri,
  totpVerify,
  unseal,
  wrapClientHash,
} from '../lib/crypto.js';
import {
  MAX_FAILED_ATTEMPTS,
  clientMeta,
  destroyAllSessions,
  getUserById,
  logEvent,
  now,
  signTicket,
  verifyTicket,
} from '../lib/auth.js';
import { requireAdmin } from '../lib/guard.js';
import {
  DEFAULT_SETTINGS,
  SECRET_KEYS,
  deleteApiKey,
  getApiKey,
  getSettings,
  listApiKeys,
  saveSettings,
  setApiKey,
  setJsonSetting,
} from '../lib/store.js';
import { GROQ_PRICING } from '../data/groq-pricing.js';
import { getGroqPricing } from '../lib/models.js';
import { GROQ_BASE, OPENROUTER_BASE } from '../lib/chat.js';
import { XAI_BASE } from '../lib/xai.js';
import { provision, destroy, warm, validateSpec, DEFAULT_SPEC, VLLM_IMAGE } from '../lib/runpod.js';
import { BACKENDS, BACKEND_NOTES } from '../lib/search.js';

const admin = new Hono();
admin.use('*', requireAdmin);

/* ------------------------------- secrets -------------------------------- */
admin.get('/secrets', async (c) => {
  return c.json({ secrets: await listApiKeys(c.env) });
});

admin.post('/secrets', async (c) => {
  const { key, value } = await c.req.json().catch(() => ({}));
  if (!SECRET_KEYS.includes(key)) return c.json({ error: '未知のキーです' }, 400);
  const v = String(value || '').trim();
  if (v.length < 8) return c.json({ error: 'キーが短すぎます' }, 400);
  await setApiKey(c.env, key, v, c.get('userId'));
  await logEvent(c.env, { email: c.get('email'), kind: 'secret_set', ok: 1, detail: key, ...clientMeta(c) });
  return c.json({ ok: true, secrets: await listApiKeys(c.env) });
});

admin.delete('/secrets/:key', async (c) => {
  const key = c.req.param('key');
  if (!SECRET_KEYS.includes(key)) return c.json({ error: '未知のキーです' }, 400);
  await deleteApiKey(c.env, key);
  await logEvent(c.env, { email: c.get('email'), kind: 'secret_delete', ok: 1, detail: key, ...clientMeta(c) });
  return c.json({ ok: true, secrets: await listApiKeys(c.env) });
});

/* One test per key, in a table.
 *
 * This used to be a chain of ifs with Groq as the final else, which meant a
 * newly added key was silently tested against Groq's API and came back "401
 * Invalid API Key" — a correct key reported as broken. A missing entry is now
 * said out loud instead of guessed at. */
const KEY_TESTS = {
  async OPENROUTER_API_KEY(value) {
    const res = await fetch(OPENROUTER_BASE + '/key', {
      headers: { authorization: 'Bearer ' + value },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + (json.error?.message || '') };
    return {
      ok: true,
      detail: {
        label: json.data?.label,
        usage: json.data?.usage,
        limit: json.data?.limit,
        limitRemaining: json.data?.limit_remaining,
        isFreeTier: json.data?.is_free_tier,
      },
    };
  },

  async GROQ_API_KEY(value) {
    const res = await fetch(GROQ_BASE + '/models', {
      headers: { authorization: 'Bearer ' + value },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + (json.error?.message || '') };
    return { ok: true, detail: { models: (json.data || []).length } };
  },

  async XAI_API_KEY(value) {
    const res = await fetch(XAI_BASE + '/models', {
      headers: { authorization: 'Bearer ' + value },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + (json.error?.message || json.error || '') };
    return { ok: true, detail: { models: (json.data || []).length } };
  },

  // Listing endpoints also confirms the key has the read access provisioning
  // will need, which a plain auth check would not.
  async RUNPOD_API_KEY(value) {
    const res = await fetch('https://rest.runpod.io/v1/endpoints', {
      headers: { authorization: 'Bearer ' + value, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error:
          'HTTP ' + res.status + ' ' + text.slice(0, 200) +
          (res.status === 401 ? '（RunPod の Settings → API Keys で Read/Write のキーを作り直してください）' : ''),
      };
    }
    let list = [];
    try {
      const json = JSON.parse(text);
      list = Array.isArray(json) ? json : json.endpoints || json.data || [];
    } catch {
      list = [];
    }
    return { ok: true, detail: { endpoints: list.length } };
  },

  // Costs one search, which is the only way to know the key actually works.
  async OLLAMA_API_KEY(value) {
    const res = await fetch('https://ollama.com/api/web_search', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + value, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'test', max_results: 1 }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 200) };
    let count = 0;
    try {
      count = (JSON.parse(text).results || []).length;
    } catch {
      count = 0;
    }
    return { ok: true, detail: { results: count } };
  },

  async BRAVE_API_KEY(value) {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?count=1&q=test', {
      headers: { accept: 'application/json', 'x-subscription-token': value },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 200) };
    return { ok: true, detail: { ok: true } };
  },
};

admin.post('/secrets/test', async (c) => {
  const { key } = await c.req.json().catch(() => ({}));
  if (!SECRET_KEYS.includes(key)) return c.json({ error: '未知のキーです' }, 400);
  const value = await getApiKey(c.env, key);
  if (!value) return c.json({ ok: false, error: '未設定です' });

  const test = KEY_TESTS[key];
  if (!test) return c.json({ ok: null, error: 'このキーには接続テストがありません' });

  try {
    return c.json(await test(value));
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

/* ----------------------------- breakthrough ------------------------------
 * Provisioning is minutes, so the POST returns immediately and the console
 * polls the warm-up state kept here. */
let warming = null;

admin.get('/breakthrough', async (c) => {
  const settings = await getSettings(c.env);
  return c.json({
    on: !!settings.breakthrough,
    endpointId: settings.runpodEndpointId || null,
    model: settings.runpodModel || null,
    search: { backend: settings.searchBackend || 'ollama', searxngUrl: settings.searxngUrl || '', backends: BACKENDS, notes: BACKEND_NOTES },
    spec: DEFAULT_SPEC,
    image: VLLM_IMAGE,
    warming,
  });
});

admin.post('/breakthrough/provision', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const spec = { ...DEFAULT_SPEC, ...(body.spec || {}) };
  const problems = validateSpec(spec);
  if (problems.length) return c.json({ error: problems.join(' / ') }, 400);

  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);

  const settings = await getSettings(c.env);
  if (settings.runpodEndpointId) {
    return c.json({ error: '既にエンドポイントがあります（' + settings.runpodEndpointId + '）。作り直すなら先に破棄してください。' }, 409);
  }

  let created;
  try {
    created = await provision(key, spec);
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
  await saveSettings(c.env, {
    runpodEndpointId: created.endpointId,
    runpodTemplateId: created.templateId,
    runpodModel: created.model,
    // Remembered because context trimming needs the real window, not a guess.
    runpodMaxLen: spec.maxModelLen,
    breakthrough: true,
  });

  warming = { started: Date.now(), elapsed: 0, ready: false, error: null };
  // Survives the response, but not a Worker eviction; the console can retry.
  c.executionCtx.waitUntil(
    warm(key, created.endpointId, { onProgress: (p) => { warming = { ...warming, ...p }; } })
      .then((r) => { warming = { ...warming, ready: true, seconds: r.seconds }; })
      .catch((e) => { warming = { ...warming, error: e.message }; })
  );
  return c.json({ ...created, spec }, 202);
});

admin.post('/breakthrough/destroy', async (c) => {
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ ok: true, nothing: true });
  try {
    await destroy(key, { endpointId: settings.runpodEndpointId, templateId: settings.runpodTemplateId });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
  warming = null;
  await saveSettings(c.env, { runpodEndpointId: '', runpodTemplateId: '', runpodModel: '', runpodMaxLen: 0, breakthrough: false });
  return c.json({ ok: true });
});

/* ------------------------------- settings ------------------------------- */
admin.get('/settings', async (c) => {
  return c.json({ settings: await getSettings(c.env), defaults: DEFAULT_SETTINGS });
});

admin.post('/settings', async (c) => {
  const patch = await c.req.json().catch(() => ({}));
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const clean = {};
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k];
  const settings = await saveSettings(c.env, clean);
  return c.json({ ok: true, settings });
});

/* ---------------------------- groq price table -------------------------- */
admin.get('/groq-pricing', async (c) => {
  return c.json({ table: await getGroqPricing(c.env), shipped: GROQ_PRICING });
});

admin.post('/groq-pricing', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.table?.models || typeof body.table.models !== 'object') return c.json({ error: 'models が必要です' }, 400);
  await setJsonSetting(c.env, 'groq_pricing', body.table);
  return c.json({ ok: true, table: body.table });
});

admin.post('/groq-pricing/reset', async (c) => {
  await c.env.DB.prepare('DELETE FROM app_settings WHERE key = ?').bind('groq_pricing').run();
  return c.json({ ok: true, table: GROQ_PRICING });
});

/* -------------------------------- account ------------------------------- */
admin.get('/account', async (c) => {
  const user = await getUserById(c.env, c.get('userId'));
  const sessions = await c.env.DB.prepare(
    'SELECT id, created_at, expires_at, last_seen_at, ip, ua FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC'
  )
    .bind(user.id)
    .all();
  let recovery = [];
  try {
    recovery = JSON.parse(user.recovery_codes || '[]');
  } catch {
    recovery = [];
  }
  return c.json({
    account: {
      email: user.email,
      totpEnabled: !!user.totp_enabled,
      failedAttempts: user.failed_attempts,
      maxFailedAttempts: MAX_FAILED_ATTEMPTS,
      lockedAt: user.locked_at,
      lastLoginAt: user.last_login_at,
      pwChangedAt: user.pw_changed_at,
      pwSalt: user.pw_salt,
      pwIterations: user.pw_iter,
      recoveryCodesLeft: recovery.length,
    },
    sessions: (sessions.results || []).map((s) => ({ ...s, current: s.id === c.get('session').id })),
  });
});

admin.post('/unlock', async (c) => {
  await c.env.DB.prepare('UPDATE users SET failed_attempts = 0, locked_at = NULL, updated_at = ? WHERE id = ?')
    .bind(now(), c.get('userId'))
    .run();
  await logEvent(c.env, { email: c.get('email'), kind: 'unlock', ok: 1, detail: 'via console', ...clientMeta(c) });
  return c.json({ ok: true });
});

admin.post('/password', async (c) => {
  const { currentClientHash, newClientHash } = await c.req.json().catch(() => ({}));
  if (!currentClientHash || !newClientHash) return c.json({ error: 'パラメータが不足しています' }, 400);
  const user = await getUserById(c.env, c.get('userId'));
  const candidate = await wrapClientHash(c.env.PW_PEPPER, user.pw_salt, String(currentClientHash));
  if (!timingSafeEqual(candidate, user.pw_hash)) {
    await logEvent(c.env, { email: user.email, kind: 'pw_change', ok: 0, detail: 'wrong current', ...clientMeta(c) });
    return c.json({ error: '現在のパスワードが違います' }, 401);
  }
  const next = await wrapClientHash(c.env.PW_PEPPER, user.pw_salt, String(newClientHash));
  await c.env.DB.prepare('UPDATE users SET pw_hash = ?, pw_changed_at = ?, updated_at = ? WHERE id = ?')
    .bind(next, now(), now(), user.id)
    .run();
  await destroyAllSessions(c.env, user.id, c.get('session').id);
  await logEvent(c.env, { email: user.email, kind: 'pw_change', ok: 1, ...clientMeta(c) });
  return c.json({ ok: true });
});

admin.post('/totp/reset', async (c) => {
  const { code } = await c.req.json().catch(() => ({}));
  const user = await getUserById(c.env, c.get('userId'));
  if (user.totp_enabled) {
    const secret = await unseal(c.env.MASTER_KEY, user.totp_secret_enc);
    if (!secret || !(await totpVerify(secret, code))) return c.json({ error: '現在の認証コードが必要です' }, 401);
  }
  const secret = newTotpSecret();
  const ticket = await signTicket(c.env, { purpose: 'totp_reset', uid: user.id, secret }, 900);
  return c.json({ ticket, secret, uri: totpUri(secret, user.email) });
});

admin.post('/totp/confirm', async (c) => {
  const { ticket, code } = await c.req.json().catch(() => ({}));
  const body = await verifyTicket(c.env, ticket, 'totp_reset');
  if (!body || body.uid !== c.get('userId')) return c.json({ error: 'セッションが無効です' }, 401);
  if (!(await totpVerify(body.secret, code))) return c.json({ error: '認証コードが正しくありません' }, 401);
  const codes = newRecoveryCodes(8);
  const hashed = await Promise.all(codes.map((x) => hashRecoveryCode(c.env.PW_PEPPER, x)));
  await c.env.DB.prepare(
    'UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, recovery_codes = ?, updated_at = ? WHERE id = ?'
  )
    .bind(await seal(c.env.MASTER_KEY, body.secret), JSON.stringify(hashed), now(), c.get('userId'))
    .run();
  await logEvent(c.env, { email: c.get('email'), kind: 'totp_reset', ok: 1, ...clientMeta(c) });
  return c.json({ ok: true, recoveryCodes: codes });
});

admin.post('/recovery/regenerate', async (c) => {
  const { code } = await c.req.json().catch(() => ({}));
  const user = await getUserById(c.env, c.get('userId'));
  const secret = await unseal(c.env.MASTER_KEY, user.totp_secret_enc);
  if (!secret || !(await totpVerify(secret, code))) return c.json({ error: '認証コードが必要です' }, 401);
  const codes = newRecoveryCodes(8);
  const hashed = await Promise.all(codes.map((x) => hashRecoveryCode(c.env.PW_PEPPER, x)));
  await c.env.DB.prepare('UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(hashed), now(), user.id)
    .run();
  return c.json({ ok: true, recoveryCodes: codes });
});

admin.post('/sessions/revoke', async (c) => {
  const { id, all } = await c.req.json().catch(() => ({}));
  if (all) {
    await destroyAllSessions(c.env, c.get('userId'), c.get('session').id);
  } else if (id) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(id, c.get('userId')).run();
  }
  return c.json({ ok: true });
});

/* -------------------------------- audit --------------------------------- */
admin.get('/events', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const { results } = await c.env.DB.prepare('SELECT * FROM login_events ORDER BY at DESC LIMIT ?').bind(limit).all();
  return c.json({ events: results || [] });
});

admin.get('/usage', async (c) => {
  const days = Math.min(Number(c.req.query('days') || 30), 365);
  const since = now() - days * 86400;
  const byModel = await c.env.DB.prepare(
    'SELECT provider, model, kind, COUNT(*) AS calls, SUM(prompt_tokens) AS input_tokens, ' +
      'SUM(completion_tokens) AS output_tokens, SUM(cost) AS cost FROM usage_log WHERE at >= ? ' +
      'GROUP BY provider, model, kind ORDER BY cost DESC'
  )
    .bind(since)
    .all();
  const byDay = await c.env.DB.prepare(
    "SELECT strftime('%Y-%m-%d', at, 'unixepoch') AS day, SUM(cost) AS cost, COUNT(*) AS calls " +
      'FROM usage_log WHERE at >= ? GROUP BY day ORDER BY day DESC'
  )
    .bind(since)
    .all();
  const totals = await c.env.DB.prepare(
    'SELECT COUNT(*) AS calls, SUM(cost) AS cost, SUM(prompt_tokens) AS input_tokens, SUM(completion_tokens) AS output_tokens ' +
      'FROM usage_log WHERE at >= ?'
  )
    .bind(since)
    .first();
  return c.json({ days, totals, byModel: byModel.results || [], byDay: byDay.results || [] });
});

admin.get('/stats', async (c) => {
  const rooms = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM rooms WHERE user_id = ?').bind(c.get('userId')).first();
  const messages = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?').bind(c.get('userId')).first();
  const files = await c.env.DB.prepare('SELECT COUNT(*) AS n, SUM(size) AS bytes FROM files WHERE user_id = ?')
    .bind(c.get('userId'))
    .first();
  return c.json({ rooms: rooms.n, messages: messages.n, files: files.n, fileBytes: files.bytes || 0 });
});

export default admin;
