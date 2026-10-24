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
  getJsonSetting,
  setJsonSetting,
} from '../lib/store.js';
import { GROQ_PRICING } from '../data/groq-pricing.js';
import { getGroqPricing } from '../lib/models.js';
import { GROQ_BASE, OPENROUTER_BASE } from '../lib/chat.js';
import { XAI_BASE } from '../lib/xai.js';
import {
  provision,
  destroy,
  warm,
  health,
  purgeQueue,
  updateEndpoint,
  setActive,
  getEndpoint,
  describeWorkers,
  diagnose,
  validateSpec,
  resolveSpec,
  imageFor,
  attachModel,
  modelReference,
  modelCacheResult,
  r2Prefix,
  R2_SECRETS,
  cacheEnv,
  cachedModels,
  describeModelCache,
  applyGpuChoice,
  OWN_JOBS_KEY,
  rememberOwnJob,
  DEFAULT_SPEC,
} from '../lib/runpod.js';
import { SEARCH_MODES, BACKEND_NOTES, MODE_LABELS, availableEngines } from '../lib/search.js';
import { keyUsage, accountCredits, utcWindows } from '../lib/generation.js';

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

  // Free: who the token belongs to, and what it may do.
  async HF_TOKEN(value) {
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { authorization: 'Bearer ' + value },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + String(json.error || '').slice(0, 200) };
    return { ok: true, detail: { name: json.name, role: json.auth?.accessToken?.role || null } };
  },

  // One page through /contents, $0.001 — a search would be $0.007.
  async EXA_API_KEY(value) {
    const res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: { 'x-api-key': value, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: ['https://exa.ai'], text: { maxCharacters: 100 } }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 200) };
    let cost = null;
    try {
      cost = JSON.parse(text).costDollars?.total ?? null;
    } catch {
      cost = null;
    }
    return { ok: true, detail: { cost } };
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
 * polls for progress.
 *
 * That progress cannot live in module memory. A Worker isolate is not pinned
 * to a session: the POST that starts a warm-up and the GET that asks about it
 * routinely land on different instances, so an in-memory value reads back as
 * null and the console reports "idle" a second after starting. It goes in the
 * database, which every instance can see.
 *
 * The loop that polls RunPod can still be cut short by an eviction, and that
 * is survivable: the request it already sent is queued on RunPod's side and
 * will bring a worker up whether or not anything here is still watching. The
 * authoritative answer is RunPod's own health, read on every status call. */
const WARM_KEY = 'runpodWarming';

const readWarming = (env) => getJsonSetting(env, WARM_KEY, null);
const writeWarming = (env, value) => setJsonSetting(env, WARM_KEY, value);

/**
 * The warm-up, described from what can actually be known.
 *
 * The elapsed counter used to be the headline, and it lied in both directions:
 * the loop that maintained it lives inside waitUntil and dies within a minute,
 * so the number either froze or — computed from the start time instead — kept
 * climbing long after anything was happening, right up to the fifteen-minute
 * ceiling. Either way it described a process that was no longer running.
 *
 * RunPod knows whether a worker is starting. That is the answer; the timestamp
 * is only kept to tell "pressed and nothing happened" from "never pressed".
 */
async function describeWarming(env, live) {
  const record = await readWarming(env);
  if (!record) return null;

  const since = Math.round((Date.now() - record.started) / 1000);
  if (live?.error) return { since, unknown: true, error: live.error };

  // Still on its way: queued, preparing, or up and working through the probe.
  const pending = (live?.inQueue || 0) + (live?.inProgress || 0);
  if (pending || live?.initializing || live?.throttled) return { since, starting: true, queued: live?.inQueue || 0 };
  if (live?.running) return { since, ready: true };

  /* Done and since stopped: with a short idle timeout the worker scales down
   * seconds after the warm-up answers. It is kept for a fast restart and
   * costs nothing, which is the expected end state, not a failure. */
  if (record.ready) return { since, ready: true, stopped: true };
  if (record.error) return { since, error: record.error };
  if (live?.standby) return { since, standby: true };
  return { since, stalled: true };
}

/* Jobs the app sends for itself are written down, so "RunPod から回収"
 * never takes one of them for a reply (recoverReply's ownJobs). */
async function noteOwnJob(env, jobId) {
  if (!jobId) return;
  const list = await getJsonSetting(env, OWN_JOBS_KEY, []);
  await setJsonSetting(env, OWN_JOBS_KEY, rememberOwnJob(list, jobId));
}

/** Drives the warm-up, recording progress where any instance can read it. */
async function runWarm(env, key, endpointId) {
  const base = await readWarming(env);
  let noted = false;
  try {
    const out = await warm(key, endpointId, {
      onProgress: (p) => {
        if (p.jobId && !noted) {
          noted = true;
          noteOwnJob(env, p.jobId).catch(() => {});
        }
        return writeWarming(env, { ...base, ...p }).catch(() => {});
      },
    });
    await writeWarming(env, { ...base, ready: true, seconds: out.seconds });
  } catch (e) {
    await writeWarming(env, { ...base, error: String(e.message).slice(0, 300) });
  }
}

/* The spec the settings call for: where to fetch the model from (your own
 * copy, R2) is chosen in the admin tab, the rest is LLAMACPP_SPEC. */
const appSpec = (settings, extra = {}) =>
  resolveSpec({
    useR2: !!settings.runpodUseR2,
    ownRepo: String(settings.runpodOwnRepo || '').trim(),
    ...extra,
  });

admin.get('/breakthrough', async (c) => {
  const settings = await getSettings(c.env);
  const spec = appSpec(settings);

  /* The warm-up progress above lives in module memory, which does not survive
   * a Worker eviction — so on its own it will happily report "idle" while a
   * worker is in fact starting. RunPod knows the truth; ask it. */
  let live = null;
  let out_workersMax = null;
  let liveRefs = null;
  if (settings.runpodEndpointId) {
    const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
    if (key) {
      const ep = await getEndpoint(key, settings.runpodEndpointId).catch(() => null);
      out_workersMax = ep?.workersMax ?? null;
      // What RunPod is caching now, rather than what was recorded at creation.
      liveRefs = await cachedModels(key, settings.runpodEndpointId).catch(() => null);
      /* Sorted by what bills: only "running" does. "ready" also counts a
       * stopped worker kept for a fast restart, so it is not shown as one
       * that is up (see describeWorkers). */
      live = await health(key, settings.runpodEndpointId)
        .then((h) => ({ workers: h.workers || null, jobs: h.jobs || null, ...describeWorkers(h) }))
        .catch((e) => ({ error: String(e.message).slice(0, 200) }));
    }
  }

  return c.json({
    live,
    on: !!settings.breakthrough,
    active: Number(out_workersMax) > 0,
    workersMax: out_workersMax,
    endpointId: settings.runpodEndpointId || null,
    model: settings.runpodModel || null,
    search: {
      backend: settings.searchBackend || 'ollama',
      rounds: Number(settings.searchRounds) || 2,
      searxngUrl: settings.searxngUrl || '',
      backends: SEARCH_MODES,
      notes: BACKEND_NOTES,
      labels: MODE_LABELS,
      // Which of Brave and Exa "let the model choose" can actually offer.
      engines: await availableEngines(c.env).catch(() => []),
    },
    spec,
    image: imageFor(spec),
    // What RunPod's console takes in the Model field, for setting it by hand.
    modelReference: spec.cacheModel ? modelReference(spec) : null,
    // Your own HF copy, if set, and whether a token to read it is registered
    // (whether, never what).
    own: spec.engine === 'llamacpp'
      ? { repo: spec.ownRepo || '', tokenSet: !!(await getApiKey(c.env, 'HF_TOKEN')), source: spec.model }
      : null,
    // The R2 copy: where it is, which RunPod secrets it needs, whether new
    // endpoints use it.
    r2: spec.engine === 'llamacpp'
      ? { enabled: !!settings.runpodUseR2, bucket: spec.r2Bucket, prefix: r2Prefix(spec), secrets: Object.values(R2_SECRETS) }
      : null,
    modelCache: describeModelCache({ liveRefs, stored: settings.runpodModelCache, expected: modelReference(spec) }),
    warming: await describeWarming(c.env, live),
  });
});

admin.post('/breakthrough/provision', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = await getSettings(c.env);
  // Your own copy and the R2 fallback are settings, applied when an endpoint is made.
  const spec = appSpec(settings, body.spec || {});
  const problems = validateSpec(spec);
  if (problems.length) return c.json({ error: problems.join(' / ') }, 400);

  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);

  if (settings.runpodEndpointId) {
    return c.json({ error: '既にエンドポイントがあります（' + settings.runpodEndpointId + '）。作り直すなら先に破棄してください。' }, 409);
  }

  let created;
  try {
    // The token goes to RunPod with the cached model, never into the spec
    // (which this route echoes back).
    created = await provision(key, spec, { hfToken: await getApiKey(c.env, 'HF_TOKEN') });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
  await saveSettings(c.env, {
    runpodEndpointId: created.endpointId,
    runpodTemplateId: created.templateId,
    runpodModel: created.model,
    // Remembered because context trimming needs the real window, not a guess.
    runpodMaxLen: spec.maxModelLen,
    // Kept so the tab can still say, after it re-renders, whether it took.
    runpodModelCache: created.modelCache ? { ...created.modelCache, at: Date.now() } : null,
    breakthrough: true,
  });

  await writeWarming(c.env, { started: Date.now(), elapsed: 0, ready: false, error: null });
  c.executionCtx.waitUntil(runWarm(c.env, key, created.endpointId));
  return c.json({ ...created, spec }, 202);
});

admin.post('/breakthrough/warm', async (c) => {
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ error: 'エンドポイントがありません' }, 400);
  /* Only an actually-running worker blocks a retry. A time window would also
   * block the case this exists for: a warm-up whose loop was evicted, where
   * the record looks in-progress and nothing is. */
  const live = await health(key, settings.runpodEndpointId).catch(() => null);
  const busy = (Number(live?.workers?.initializing) || 0) + (Number(live?.workers?.running) || 0);
  if (busy) return c.json({ ok: true, already: true, workers: live.workers });

  const started = { started: Date.now(), elapsed: 0, ready: false, error: null };
  await writeWarming(c.env, started);
  c.executionCtx.waitUntil(runWarm(c.env, key, settings.runpodEndpointId));
  return c.json({ ok: true, warming: started }, 202);
});

/* The queue outlives the thing that filled it, so it needs a way out. Also
 * applies the current idleTimeout, so an endpoint created with the old
 * thirty-second value can be corrected without being rebuilt. */
admin.post('/breakthrough/reset', async (c) => {
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ error: 'エンドポイントがありません' }, 400);

  const done = {};
  try {
    done.purged = await purgeQueue(key, settings.runpodEndpointId);
  } catch (e) {
    done.purgeError = e.message;
  }
  try {
    // The endpoint's own defaults; replies set their execution limit per job.
    await updateEndpoint(key, settings.runpodEndpointId, {
      idleTimeout: DEFAULT_SPEC.idleTimeout,
      executionTimeoutMs: DEFAULT_SPEC.executionTimeoutMs,
    });
    done.idleTimeout = DEFAULT_SPEC.idleTimeout;
    done.executionTimeoutMs = DEFAULT_SPEC.executionTimeoutMs;
  } catch (e) {
    done.patchError = e.message;
  }
  await writeWarming(c.env, null);
  return c.json({ ok: true, ...done });
});

/* Attaches the cached model to the endpoint that exists — for one created
 * before this was automatic, or when the attempt during creation failed. */
admin.post('/breakthrough/cache', async (c) => {
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ error: 'エンドポイントがありません' }, 400);
  const spec = appSpec(settings);
  const value = modelReference(spec);
  const env = cacheEnv(spec, await getApiKey(c.env, 'HF_TOKEN'));
  const result = await attachModel(key, settings.runpodEndpointId, [value], { env })
    .then((refs) => modelCacheResult(refs, value))
    .catch((e) => ({ ok: false, error: e.message, value }));
  await saveSettings(c.env, { runpodModelCache: { ...result, at: Date.now() } });
  return c.json(result, result.ok ? 200 : 502);
});

/* The spec's GPU candidates and minimum CUDA version, put on the existing
 * endpoint — no recreating, so the model cache is not waited for again.
 * Anything the update drops (cached model, endpoint env) is put back. */
admin.post('/breakthrough/gpus', async (c) => {
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ error: 'エンドポイントがありません' }, 400);
  try {
    return c.json({ ok: true, ...(await applyGpuChoice(key, settings.runpodEndpointId, appSpec(settings))) });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

admin.post('/breakthrough/diagnose', async (c) => {
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ error: 'エンドポイントがありません' }, 400);
  try {
    const out = await diagnose(key, settings.runpodEndpointId, appSpec(settings));
    await noteOwnJob(c.env, out.probe?.jobId).catch(() => {});
    return c.json(out);
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

admin.post('/breakthrough/active', async (c) => {
  const { on } = await c.req.json().catch(() => ({}));
  const settings = await getSettings(c.env);
  const key = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!key) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);
  if (!settings.runpodEndpointId) return c.json({ error: 'エンドポイントがありません' }, 400);
  try {
    const out = await setActive(key, settings.runpodEndpointId, !!on);
    if (!on) await writeWarming(c.env, null);
    return c.json({ ok: true, ...out });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
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
  await writeWarming(c.env, null);
  await saveSettings(c.env, {
    runpodEndpointId: '',
    runpodTemplateId: '',
    runpodModel: '',
    runpodMaxLen: 0,
    runpodModelCache: null,
    breakthrough: false,
  });
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

/* What OpenRouter billed this app's key, against what the app recorded, over
 * the same UTC windows OpenRouter's own counters use. The gap is spending the
 * ledger never saw — a reply whose Worker was gone before the final usage
 * chunk arrived, say — and the account line shows how much went through other
 * keys entirely. */
admin.get('/spend', async (c) => {
  const key = await getApiKey(c.env, 'OPENROUTER_API_KEY');
  if (!key) return c.json({ error: 'OPENROUTER_API_KEY が未登録です' }, 400);
  let billed;
  try {
    billed = await keyUsage(key);
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 502);
  }
  const account = await accountCredits(key).catch(() => null);
  const w = utcWindows(now());
  const sum = (since) =>
    c.env.DB.prepare(
      "SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls, SUM(cost IS NULL) AS unpriced FROM usage_log " +
        "WHERE provider = 'openrouter' AND at >= ?"
    )
      .bind(since)
      .first();
  const [day, week, month, total] = await Promise.all([sum(w.day), sum(w.week), sum(w.month), sum(0)]);
  const first = await c.env.DB.prepare("SELECT MIN(at) AS at FROM usage_log WHERE provider = 'openrouter'").first();
  return c.json({
    billed,
    recorded: { day, week, month, total },
    account,
    windows: w,
    ledgerSince: first?.at || null,
  });
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
