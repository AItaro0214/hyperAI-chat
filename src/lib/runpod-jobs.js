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
 *   1. the Worker that sent it follows /stream and writes as it goes;
 *   2. RunPod calls the webhook when the job ends, and the app reads the job;
 *   3. opening the room reads any job its replies are still waiting on;
 *   4. the hourly cron does the same for every waiting reply.
 *
 * /run results are kept for 30 minutes after the job ends; 2 alone covers
 * that, and 3 and 4 are there for when it does not arrive. */

import { RUN_BASE, JOB_WAIT_MS, JOB_EXECUTION_MS, JOB_TTL_MS, extractCompletion, failedReason } from './runpod.js';
import { getApiKey } from './store.js';
import { hmacSha256, b64url, timingSafeEqual } from './crypto.js';

export { JOB_WAIT_MS, JOB_EXECUTION_MS, JOB_TTL_MS };
const HOUR = 3600 * 1000;

const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
export const isFinal = (status) => FINAL.has(String(status || '').toUpperCase());

/* Following a job costs one request per poll, and a Worker invocation may
 * make 10,000 (Workers Paid). Fast while text is arriving, slower while
 * nothing is: 2,500 is some forty minutes of text at one poll a second, or
 * hours of waiting at fifteen, and leaves room for the search decisions in
 * the same turn. Past it the Worker stops following and leaves the job to
 * the webhook and the sweeps — it does not cancel it. */
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

/* One stream item, as the SSE text consumeChatStream reads. The handler
 * yields SSE strings for a stream and objects otherwise; a failure is an
 * object with `error`. */
export function itemToSse(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output.endsWith('\n') ? output : output + '\n\n';
  if (output.error) return 'data: ' + JSON.stringify({ error: { message: failedReason({ error: output.error }) } }) + '\n\n';
  return 'data: ' + JSON.stringify(output) + '\n\n';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A drop-in for fetch(url, {body}) that runs the chat completion as a /run
 * job instead of a sync request, and hands back an ordinary Response:
 *
 *   stream: an SSE body fed from /stream, opened once the first output (or
 *           the job's end) arrives — so a job that fails before writing
 *           anything comes back as an error status, as a sync request would;
 *   else:   the completion as JSON once the job ends, or an error status.
 *
 * @param {object} o
 * @param {(jobId: string) => Promise<void>|void} [o.onJob]   called once, before any waiting
 * @param {(s: {status: string, waitedMs: number, output: boolean}) => void} [o.onStatus]
 * @param {() => void} [o.onDetach]  the poll budget ran out; the job carries on unfollowed
 */
export function runpodChatFetch(apiKey, endpointId, { webhook, onJob, onStatus, onDetach, waitMs = JOB_WAIT_MS, poll = POLL } = {}) {
  return async (_url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body || {};
    const jobId = await submitChatJob(apiKey, endpointId, body, { webhook });
    await onJob?.(jobId);
    const started = Date.now();
    let calls = 0;
    let delay = poll.minMs;

    const get = async (path) => {
      calls++;
      const res = await fetch(RUN_BASE + '/' + endpointId + path + '/' + encodeURIComponent(jobId), {
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(30000),
      }).catch(() => null);
      return (await res?.json().catch(() => null)) || { status: 'UNKNOWN' };
    };
    const overTime = () => Date.now() - started > waitMs;
    const outOfBudget = () => calls >= poll.budget;
    const failure = (status, job) =>
      new Response(JSON.stringify({ error: { message: failedReason(job) || status } }), {
        status: status === 'TIMED_OUT' ? 504 : 500,
        headers: { 'content-type': 'application/json', 'x-runpod-job': jobId },
      });
    const timedOut = async () => {
      await cancelJob(apiKey, endpointId, jobId);
      return failure('TIMED_OUT', { error: '2時間以内に終わらなかったため、ジョブを止めました（待ち行列・起動・生成の合計）' });
    };

    if (!body.stream) {
      for (;;) {
        const job = await get('/status');
        onStatus?.({ status: job.status, waitedMs: Date.now() - started, output: false });
        if (job.status === 'COMPLETED') {
          const out = Array.isArray(job.output) ? job.output.find((o) => o && typeof o === 'object') : job.output;
          if (out?.error) return failure('FAILED', { error: out.error });
          return new Response(JSON.stringify(out || {}), { status: 200, headers: { 'content-type': 'application/json', 'x-runpod-job': jobId } });
        }
        if (isFinal(job.status)) return failure(job.status, job);
        if (overTime()) return timedOut();
        if (outOfBudget()) {
          onDetach?.();
          return failure('DETACHED', { error: '応答の追跡を打ち切りました（ジョブは RunPod で続いています）' });
        }
        await sleep(delay);
        delay = Math.min(poll.maxMs, Math.ceil(delay * 1.5));
      }
    }

    // Wait for the first output or the end, so a job that never wrote a word
    // still comes back as an error status rather than an empty stream.
    let first = null;
    for (;;) {
      const s = await get('/stream');
      const items = Array.isArray(s.stream) ? s.stream : [];
      onStatus?.({ status: s.status, waitedMs: Date.now() - started, output: items.length > 0 });
      if (items.length) {
        first = { items, status: s.status };
        break;
      }
      if (isFinal(s.status)) {
        if (s.status !== 'COMPLETED') return failure(s.status, await get('/status'));
        first = { items: [], status: s.status };
        break;
      }
      if (overTime()) return timedOut();
      if (outOfBudget()) {
        onDetach?.();
        return failure('DETACHED', { error: '応答の追跡を打ち切りました（ジョブは RunPod で続いています）' });
      }
      await sleep(delay);
      delay = Math.min(poll.maxMs, Math.ceil(delay * 1.5));
    }

    const enc = new TextEncoder();
    let pending = first;
    let ended = false;
    const stream = new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (pending) {
            const { items, status } = pending;
            pending = null;
            const text = items.map((i) => itemToSse(i?.output)).join('');
            if (isFinal(status)) {
              if (status !== 'COMPLETED') {
                const job = await get('/status');
                controller.enqueue(enc.encode(text + 'data: ' + JSON.stringify({ error: { message: failedReason(job) } }) + '\n\n'));
              } else if (text) {
                controller.enqueue(enc.encode(text));
              }
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              ended = true;
              controller.close();
              return;
            }
            if (text) {
              controller.enqueue(enc.encode(text));
              return;
            }
          }
          if (ended) return;
          if (overTime()) {
            await cancelJob(apiKey, endpointId, jobId);
            controller.enqueue(enc.encode('data: ' + JSON.stringify({ error: { message: '2時間以内に終わらなかったため、ジョブを止めました' } }) + '\n\ndata: [DONE]\n\n'));
            controller.close();
            return;
          }
          if (outOfBudget()) {
            onDetach?.();
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          await sleep(delay);
          const s = await get('/stream');
          const items = Array.isArray(s.stream) ? s.stream : [];
          onStatus?.({ status: s.status, waitedMs: Date.now() - started, output: items.length > 0 });
          delay = items.length ? poll.minMs : Math.min(poll.maxMs, Math.ceil(delay * 1.5));
          pending = { items, status: s.status };
        }
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-runpod-job': jobId } });
  };
}

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
