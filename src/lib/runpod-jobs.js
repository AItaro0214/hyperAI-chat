/* Breakthrough replies as RunPod jobs that can take two hours and still land.
 *
 * The OpenAI-compatible route is a sync job: the connection is the only thing
 * holding the answer, and RunPod keeps a sync result for about a minute. A
 * cold start that spends twenty minutes preparing the cached model, or a
 * Worker that is evicted when the tab closes, and the reply is gone.
 *
 * So the request goes in through /run instead — the same handler input the
 * OpenAI route builds ({openai_route, openai_input}) — with its own execution
 * limit and lifespan, and the job id is written to the message before
 * anything else happens. From then on there are four ways for the answer to
 * reach the database, and any one of them is enough:
 *
 *   1. the turn itself (a Workflow, lib/breakthrough-turn.js) follows
 *      /stream and writes as it goes;
 *   2. RunPod calls the webhook when the job ends, and the app reads the job;
 *   3. opening the room reads any job its replies are still waiting on;
 *   4. the hourly cron does the same for every waiting reply.
 *
 * /run results are kept for 30 minutes after the job ends; 2 alone covers
 * that, and 3 and 4 are there for when it does not arrive. */

import {
  RUN_BASE,
  JOB_WAIT_MS,
  JOB_EXECUTION_MS,
  JOB_TTL_MS,
  OWN_JOBS_KEY,
  extractCompletion,
  failedReason,
  rememberOwnJob,
} from './runpod.js';
import { getApiKey, getJsonSetting, setJsonSetting } from './store.js';

/* A job the app sent for itself — a search decision, the warm-up, the
 * diagnosis — written down so recovery by time never takes it for a reply. */
export async function noteAppJob(env, jobId) {
  if (!jobId) return;
  const list = await getJsonSetting(env, OWN_JOBS_KEY, []);
  await setJsonSetting(env, OWN_JOBS_KEY, rememberOwnJob(list, jobId));
}
import { hmacSha256, b64url, timingSafeEqual } from './crypto.js';

export { JOB_WAIT_MS, JOB_EXECUTION_MS, JOB_TTL_MS };
const HOUR = 3600 * 1000;

const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
export const isFinal = (status) => FINAL.has(String(status || '').toUpperCase());

/* Following a job costs one request per poll, and a Worker invocation or a
 * Workflow instance may make 10,000 (Workers Paid). Fast while text is
 * arriving, slower while nothing is: 2,500 is some forty minutes of text at
 * one poll a second, or hours of waiting at fifteen. Past it the following
 * goes on at fifteen seconds, which leaves room for the decisions, the
 * searches and the row's writes in the same turn. */
export const POLL = { minMs: 1000, maxMs: 15000, budget: 2500 };

const authHeaders = (apiKey) => ({ authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' });

/** Submits one chat completion as an async job. @returns {Promise<string>} the job id */
export async function submitChatJob(apiKey, endpointId, body, { webhook } = {}) {
  const res = await fetch(RUN_BASE + '/' + endpointId + '/run', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      input: { openai_route: '/v1/chat/completions', openai_input: body },
      policy: { executionTimeout: JOB_EXECUTION_MS, ttl: JOB_TTL_MS },
      ...(webhook ? { webhook } : {}),
    }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.id) {
    throw new Error('RunPod /run ' + res.status + ': ' + JSON.stringify(json || {}).slice(0, 300));
  }
  return json.id;
}

export async function cancelJob(apiKey, endpointId, jobId) {
  await fetch(RUN_BASE + '/' + endpointId + '/cancel/' + encodeURIComponent(jobId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(20000),
  }).catch(() => {});
}

/* ---------------- following a job by its id (for workflows) ----------------
 * A Workflow step can be run again after the instance is evicted. Following
 * by id — never by submitting — makes that harmless: the job is submitted in
 * one step, and these read it in the next, as often as they are run. */

async function readJob(apiKey, endpointId, path, jobId) {
  const res = await fetch(RUN_BASE + '/' + endpointId + path + '/' + encodeURIComponent(jobId), {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  return (await res?.json().catch(() => null)) || { status: 'UNKNOWN' };
}

/**
 * Waits for a non-streamed job (a search decision) to end.
 * @param {number} deadline  epoch ms; past it the job is cancelled
 * @returns {Promise<{ok: boolean, status: string, httpStatus: number, body: object}>}
 */
export async function waitForJob(apiKey, endpointId, jobId, { deadline, onStatus, poll = POLL } = {}) {
  let delay = poll.minMs;
  for (let calls = 0; ; calls++) {
    const job = await readJob(apiKey, endpointId, '/status', jobId);
    await onStatus?.({ status: job.status });
    if (job.status === 'COMPLETED') {
      const out = Array.isArray(job.output) ? job.output.find((o) => o && typeof o === 'object') : job.output;
      if (out?.error) return { ok: false, status: 'FAILED', httpStatus: 500, body: { error: { message: failedReason({ error: out.error }) } } };
      return { ok: true, status: 'COMPLETED', httpStatus: 200, body: out || {} };
    }
    if (isFinal(job.status)) {
      return { ok: false, status: job.status, httpStatus: job.status === 'TIMED_OUT' ? 504 : 500, body: { error: { message: failedReason(job) } } };
    }
    if (deadline && Date.now() > deadline) {
      await cancelJob(apiKey, endpointId, jobId);
      return { ok: false, status: 'TIMED_OUT', httpStatus: 504, body: { error: { message: '2時間以内に終わらなかったため、ジョブを止めました' } } };
    }
    await sleep(delay);
    delay = Math.min(poll.maxMs, Math.ceil(delay * 1.5));
  }
}

/* The frames of a stream item, as parsed chunks. */
function framesOf(output) {
  const chunks = [];
  for (const line of itemToSse(output).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const body = t.slice(5).trim();
    if (!body || body === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(body));
    } catch {
      /* a frame split across items: the final text comes from /status anyway */
    }
  }
  return chunks;
}

/**
 * Follows a streamed reply job to its end, reporting text as it arrives.
 *
 * What is streamed is for showing; what is returned comes from the finished
 * job's stored output (/status), so a follow that is run again after an
 * eviction — and so missed the increments /stream already handed out —
 * still returns the whole reply.
 *
 * @param {(p: {text?: string, reasoning?: string, worker?: object, status?: string}) => Promise<void>} [onProgress]
 * @returns {Promise<{status: string, text?: string, reasoning?: string, usage?: object, worker?: object, error?: string}>}
 */
export async function followReply(apiKey, endpointId, jobId, { deadline, onProgress, poll = POLL } = {}) {
  let text = '';
  let reasoning = '';
  let worker = null;
  let usage = null;
  let delay = poll.minMs;
  for (let calls = 0; ; calls++) {
    const s = await readJob(apiKey, endpointId, '/stream', jobId);
    const items = Array.isArray(s.stream) ? s.stream : [];
    let streamError = null;
    for (const item of items) {
      for (const chunk of framesOf(item?.output)) {
        if (chunk.hyperai_worker && !worker) worker = chunk.hyperai_worker;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.error) streamError = chunk.error.message || JSON.stringify(chunk.error);
        const delta = chunk.choices?.[0]?.delta || {};
        if (typeof delta.content === 'string') text += delta.content;
        const r = delta.reasoning ?? delta.reasoning_content;
        if (typeof r === 'string') reasoning += r;
      }
    }
    await onProgress?.({ text, reasoning, worker, status: s.status, fresh: items.length > 0 });

    if (isFinal(s.status)) {
      const job = await readJob(apiKey, endpointId, '/status', jobId);
      if (s.status !== 'COMPLETED') return { status: s.status, error: streamError || failedReason(job), text, reasoning, worker };
      const done = extractCompletion(job);
      // The worker's startup details travel as their own frame.
      const stored = (Array.isArray(job.output) ? job.output : [job.output]).flatMap((o) => framesOf(o));
      const storedWorker = stored.find((c) => c?.hyperai_worker)?.hyperai_worker || null;
      return {
        status: 'COMPLETED',
        text: done.text.length >= text.length ? done.text : text,
        reasoning: done.reasoning || reasoning,
        usage: done.usage || usage,
        worker: worker || storedWorker,
        finishReason: done.finishReason,
      };
    }
    if (deadline && Date.now() > deadline) {
      await cancelJob(apiKey, endpointId, jobId);
      return { status: 'TIMED_OUT', error: '2時間以内に終わらなかったため、ジョブを止めました（待ち行列・起動・生成の合計）', text, reasoning, worker };
    }
    await sleep(delay);
    /* Past the budget, slow: an instance may make 10,000 subrequests, and
     * the row's writes and the decisions share them. */
    delay = calls >= poll.budget ? poll.maxMs : items.length ? poll.minMs : Math.min(poll.maxMs, Math.ceil(delay * 1.5));
  }
}

/* One stream item, as the SSE text consumeChatStream reads. The handler
 * yields SSE strings for a stream and objects otherwise; a failure is an
 * object with `error`. */
export function itemToSse(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output.endsWith('\n') ? output : output + '\n\n';
  if (output.error) return 'data: ' + JSON.stringify({ error: { message: failedReason({ error: output.error }) } }) + '\n\n';
  return 'data: ' + JSON.stringify(output) + '\n\n';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* What a reply waiting on RunPod looks like on the screen. */
export function queueNotice({ status, waitedMs }) {
  const secs = Math.round(waitedMs / 1000);
  const t = secs < 60 ? secs + '秒' : Math.floor(secs / 60) + '分' + (secs % 60) + '秒';
  if (status === 'IN_QUEUE') return 'RunPod の待ち行列で待機中… ' + t + '（GPU の確保・準備を待っています。最大2時間）';
  if (status === 'IN_PROGRESS') return '起動・読み込み中… ' + t + '（重みの読み込みに数分かかります）';
  return 'GPU の応答を待っています… ' + t;
}

/* ------------------------------- webhook -------------------------------- */

/* The webhook names a message, and is signed so that nobody else can make the
 * app go and look at a job. It carries nothing else that is trusted: the app
 * reads the job from RunPod itself, by the id it stored. */
export async function webhookSignature(env, messageId) {
  return b64url(await hmacSha256(env.MASTER_KEY || '', 'runpod-webhook:' + messageId));
}

export async function webhookUrl(env, messageId) {
  const origin = String(env.APP_ORIGIN || '').replace(/\/+$/, '');
  if (!origin || !env.MASTER_KEY) return null;
  return origin + '/api/runpod/webhook/' + encodeURIComponent(messageId) + '?sig=' + (await webhookSignature(env, messageId));
}

export async function verifyWebhook(env, messageId, sig) {
  if (!env.MASTER_KEY || !sig) return false;
  return timingSafeEqual(await webhookSignature(env, messageId), String(sig));
}

/* --------------------------- settling a reply --------------------------- */

const parse = (v) => {
  try {
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
};

/**
 * Brings a message up to date with the job it is waiting on.
 *
 * Only ever adds: a reply the Worker already wrote in full is left alone, and
 * a longer text is never replaced by a shorter one.
 *
 * @returns {Promise<{state: string, status?: string}>} 'settled' | 'pending' | 'skipped' | 'lost'
 */
export async function settleMessage(env, row, { apiKey } = {}) {
  const meta = parse(row.meta);
  const job = meta.runpodJob;
  if (!job?.id || !job.endpointId) return { state: 'skipped' };
  if (job.status && isFinal(job.status) && !meta.partial) return { state: 'skipped' };

  const key = apiKey || (await getApiKey(env, 'RUNPOD_API_KEY'));
  if (!key) return { state: 'skipped' };
  const res = await fetch(RUN_BASE + '/' + job.endpointId + '/status/' + encodeURIComponent(job.id), {
    headers: authHeaders(key),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);

  const save = (patch, extra = {}) => {
    const nextMeta = { ...meta, ...patch, runpodJob: { ...job, ...(patch.runpodJob || {}), checkedAt: Date.now() } };
    const sets = ['meta = ?'];
    const binds = [JSON.stringify(nextMeta)];
    for (const [col, val] of Object.entries(extra)) {
      sets.push(col + ' = ?');
      binds.push(val);
    }
    return env.DB.prepare('UPDATE messages SET ' + sets.join(', ') + ' WHERE id = ?')
      .bind(...binds, row.id)
      .run();
  };

  // Gone: past RunPod's retention, or the job's lifespan.
  if (res && res.status === 404) {
    await save(
      { partial: false, runpodJob: { status: 'LOST' } },
      row.content ? {} : { error: 'RunPod にジョブが残っていません（保持期間を過ぎました）。もう一度送ってください。' }
    );
    return { state: 'lost' };
  }
  const state = res?.ok ? await res.json().catch(() => null) : null;
  if (!state?.status) return { state: 'pending', status: 'UNKNOWN' };
  if (!isFinal(state.status)) {
    await save({ runpodJob: { status: state.status } });
    return { state: 'pending', status: state.status };
  }

  if (state.status !== 'COMPLETED') {
    await save(
      { partial: false, runpodJob: { status: state.status } },
      row.error ? {} : { error: 'RunPod のジョブが終了しました（' + state.status + '）: ' + failedReason(state) }
    );
    return { state: 'settled', status: state.status };
  }

  const reply = extractCompletion(state);
  const current = String(row.content || '');
  const extra = {};
  if (reply.text.length > current.length) extra.content = reply.text;
  if (reply.reasoning && !row.reasoning) extra.reasoning = reply.reasoning;
  if (reply.usage?.prompt_tokens && !row.prompt_tokens) {
    extra.prompt_tokens = reply.usage.prompt_tokens;
    extra.completion_tokens = reply.usage.completion_tokens ?? null;
  }
  if (extra.content || current) extra.error = null;
  await save({ partial: false, abandoned: false, runpodJob: { status: 'COMPLETED', settledAt: Date.now() } }, extra);
  return { state: 'settled', status: 'COMPLETED' };
}

/** Replies still waiting on a job, newest first, within the job's lifespan. */
export async function pendingReplies(env, { roomId, limit = 10 } = {}) {
  const since = Math.floor((Date.now() - JOB_TTL_MS - HOUR) / 1000);
  const sql =
    'SELECT * FROM messages WHERE role = ? AND created_at > ? AND meta LIKE ? AND meta LIKE ?' +
    (roomId ? ' AND room_id = ?' : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  const binds = ['assistant', since, '%"runpodJob"%', '%"partial":true%', ...(roomId ? [roomId] : []), limit];
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results || [];
}

/** The hourly sweep: settles every reply still waiting on RunPod. */
export async function sweepPendingJobs(env) {
  const rows = await pendingReplies(env, { limit: 20 });
  if (!rows.length) return { checked: 0, settled: 0 };
  const apiKey = await getApiKey(env, 'RUNPOD_API_KEY');
  let settled = 0;
  for (const row of rows) {
    const out = await settleMessage(env, row, { apiKey }).catch(() => ({ state: 'error' }));
    if (out.state === 'settled' || out.state === 'lost') settled++;
  }
  return { checked: rows.length, settled };
}
