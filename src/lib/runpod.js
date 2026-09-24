/* Breakthrough mode: an open-weight model on a rented GPU.
 *
 * RunPod Serverless is used rather than a Pod, which removes the problem that
 * prompted this: a stopped Pod keeps billing for its volume — at twice the
 * running rate, per RunPod's own docs — so it has to be destroyed rather than
 * stopped, and destroying means re-downloading the weights on every start.
 *
 * A Serverless endpoint with workersMin: 0 and no network volume scales to
 * nothing between requests, so there is no idle cost and nothing to remember to
 * tear down. The endpoint itself is just a configuration record; leaving one in
 * place is what makes the next session start warm.
 *
 * Once a worker is up it speaks the OpenAI API, so everything downstream — the
 * chat path, the agent loop, tool calling — works unchanged against a
 * different base URL. */

const REST = 'https://rest.runpod.io/v1';
const RUN = 'https://api.runpod.ai/v2';

/* The maintained vLLM worker. Pinned rather than :latest so a breaking change
 * upstream cannot alter a working setup without being asked for. */
export const VLLM_IMAGE = 'runpod/worker-v1-vllm:v2.27.1';

export const DEFAULT_SPEC = {
  // 27B at bf16 is ~54GB and will not fit a 24GB card; the AWQ build is ~16GB.
  model: 'shawnw3i/Huihui-Qwen3.8-27B-abliterated-AWQ-MTP',
  quantization: 'awq',
  /* 48GB, and cheaper per hour than the 24GB 4090 — $0.33 against $0.34 at
   * the time of writing. The 27B weights are 20GB, which simply does not fit
   * a 4090 once the KV cache and activations are accounted for; this was
   * established the hard way, by watching it run out of memory during
   * startup. Ampere generates more slowly than Ada, which is the trade for
   * the model loading at all.
   *
   * Listed in order, so a stock-out on the first falls through rather than
   * failing. */
  gpu: ['NVIDIA RTX A6000', 'NVIDIA A40', 'NVIDIA L40S'],
  /* 23.52 GiB, and the weights are about 16 of it. What is left has to hold
   * the KV cache, peak activations and CUDA graphs, and the first attempt at
   * these numbers died with "ran out of GPU memory during startup".
   *
   * 16K context rather than 32K halves the KV cache. Eight sequences rather
   * than the default 256 is right for one user anyway. Eager mode gives up
   * CUDA graph capture — some throughput for a couple of gigabytes. And
   * vLLM 0.28 doubled MAX_NUM_BATCHED_TOKENS to 16384, which doubled peak
   * activation memory with it, so it is put back. */
  maxModelLen: 32768,
  maxNumSeqs: 16,
  maxNumBatchedTokens: 16384,
  // CUDA graphs are worth their memory on a card that has it to spare.
  enforceEager: false,
  /* Not hermes. Asked for a tool, this model emits
   *   <tool_call><function=name><parameter=q>…</parameter></function></tool_call>
   * which is the Qwen3-Coder XML shape, not Hermes' JSON — so the hermes
   * parser left it all sitting in content as prose and nothing ever saw a
   * tool_call. Verified against the running endpoint. */
  toolParser: 'qwen3_coder',
  reasoningParser: 'qwen3',
  gpuMemoryUtilization: 0.92,
  workersMax: 1,
  /* Five minutes, not thirty seconds.
   *
   * A short idle timeout is right when a worker restarts in seconds. This one
   * loads 16GB, so scaling down between two messages of the same conversation
   * buys a few cents of idle and spends minutes of GPU re-initialising — and
   * the endpoint visibly flaps between "ready" and "running" while a queue
   * builds behind it. Holding the worker through a conversation is both faster
   * and cheaper; it still scales to zero once the conversation is actually
   * over. */
  idleTimeout: 300,
  executionTimeoutMs: 900000,
};

/** The OpenAI-compatible base URL for a deployed endpoint. */
export const openaiBase = (endpointId) => RUN + '/' + endpointId + '/openai/v1';

async function call(apiKey, path, { method = 'GET', body } = {}) {
  const res = await fetch(REST + path, {
    method,
    headers: {
      authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json?.error || json?.message || text || '';
    throw new Error('RunPod ' + method + ' ' + path + ' → ' + res.status + (detail ? ': ' + String(detail).slice(0, 300) : ''));
  }
  return json;
}

/* --------------------------- the vLLM template --------------------------- */

/**
 * The worker reads its whole configuration from the environment, and any
 * variable named after a `vllm serve` flag is passed straight through — which
 * is how the tool-call parser gets set.
 */
export function templateBody(spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const env = {
    MODEL_NAME: s.model,
    MAX_MODEL_LEN: String(s.maxModelLen),
    MAX_NUM_SEQS: String(s.maxNumSeqs),
    MAX_NUM_BATCHED_TOKENS: String(s.maxNumBatchedTokens),
    ENFORCE_EAGER: String(!!s.enforceEager),
    GPU_MEMORY_UTILIZATION: String(s.gpuMemoryUtilization),
    // Tool calling is what makes agent mode possible at all.
    ENABLE_AUTO_TOOL_CHOICE: 'true',
    TOOL_CALL_PARSER: s.toolParser,
    // Separates the thinking from the answer instead of inlining <think> tags.
    REASONING_PARSER: s.reasoningParser,
    // A stable name, so the app does not have to send a long HF path as `model`.
    OPENAI_SERVED_MODEL_NAME_OVERRIDE: 'breakthrough',
  };
  if (s.quantization) env.QUANTIZATION = s.quantization;
  if (s.hfToken) env.HF_TOKEN = s.hfToken;

  return {
    name: 'hyperai-breakthrough-' + Date.now().toString(36),
    imageName: VLLM_IMAGE,
    containerDiskInGb: 30,
    volumeInGb: 0,
    isServerless: true,
    env,
  };
}

export function endpointBody(templateId, spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  return {
    templateId,
    name: 'hyperai-breakthrough',
    computeType: 'GPU',
    gpuTypeIds: Array.isArray(s.gpu) ? s.gpu : [s.gpu],
    gpuCount: 1,
    // Zero minimum is the whole point: nothing runs, nothing is billed.
    workersMin: 0,
    workersMax: s.workersMax,
    idleTimeout: s.idleTimeout,
    // Generous, because the first request also pays for loading the weights.
    executionTimeoutMs: s.executionTimeoutMs,
    flashboot: true,
    scalerType: 'QUEUE_DELAY',
    scalerValue: 4,
  };
}

/* ------------------------------ lifecycle ------------------------------- */

/**
 * Creates the template and the endpoint.
 * @returns {Promise<{endpointId: string, templateId: string, base: string, model: string}>}
 */
export async function provision(apiKey, spec = {}) {
  const template = await call(apiKey, '/templates', { method: 'POST', body: templateBody(spec) });
  const templateId = template?.id;
  if (!templateId) throw new Error('テンプレートの作成に失敗しました（id が返りません）');

  try {
    const endpoint = await call(apiKey, '/endpoints', { method: 'POST', body: endpointBody(templateId, spec) });
    const endpointId = endpoint?.id;
    if (!endpointId) throw new Error('エンドポイントの作成に失敗しました（id が返りません）');
    return { endpointId, templateId, base: openaiBase(endpointId), model: 'breakthrough' };
  } catch (e) {
    // A template with no endpoint is invisible clutter; take it back out.
    await call(apiKey, '/templates/' + templateId, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

/** Removes both, so nothing is left behind in the account. */
export async function destroy(apiKey, { endpointId, templateId } = {}) {
  const removed = { endpoint: false, template: false };
  if (endpointId) {
    // An endpoint with workers still allowed cannot be deleted, so it is
    // scaled to nothing first.
    await call(apiKey, '/endpoints/' + endpointId, { method: 'PATCH', body: { workersMin: 0, workersMax: 0 } }).catch(() => {});
    await call(apiKey, '/endpoints/' + endpointId, { method: 'DELETE' });
    removed.endpoint = true;
  }
  if (templateId) {
    await call(apiKey, '/templates/' + templateId, { method: 'DELETE' }).catch(() => {});
    removed.template = true;
  }
  return removed;
}

/**
 * Turns the endpoint on and off by allowing or forbidding workers.
 *
 * Scaling to zero is not the same as costing nothing *now*: a worker inside
 * its idle window is still running and still billed. Setting workersMax to 0
 * ends that immediately rather than waiting out the timeout, and the cached
 * image means switching back on is far cheaper than the first start was.
 *
 * The endpoint itself is only a configuration record either way, so nothing is
 * lost by leaving it in place.
 */
export async function setActive(apiKey, endpointId, on) {
  const patched = await call(apiKey, '/endpoints/' + endpointId, {
    method: 'PATCH',
    body: { workersMin: 0, workersMax: on ? 1 : 0 },
  });
  return { active: Number(patched?.workersMax) > 0, workersMax: patched?.workersMax };
}

/** Drops queued jobs. Used to clear a backlog that is only costing GPU time. */
export async function purgeQueue(apiKey, endpointId) {
  const res = await fetch(RUN + '/' + endpointId + '/purge-queue', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('RunPod purge-queue → ' + res.status + ': ' + text.slice(0, 200));
  try {
    return JSON.parse(text);
  } catch {
    return { status: 'ok' };
  }
}

/** Changes a live endpoint's settings without recreating it. */
export async function updateEndpoint(apiKey, endpointId, patch) {
  return call(apiKey, '/endpoints/' + endpointId, { method: 'PATCH', body: patch });
}

/** The endpoint record, for reading its current scale. */
export const getEndpoint = (apiKey, endpointId) => call(apiKey, '/endpoints/' + endpointId);

/** Worker counts, as the platform sees them. */
export async function health(apiKey, endpointId) {
  const res = await fetch(RUN + '/' + endpointId + '/health', {
    headers: { authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('RunPod health → ' + res.status);
  return res.json();
}

/**
 * Brings a worker up, once.
 *
 * The obvious loop — send a request, give up, send another — piles jobs onto
 * the queue: aborting the fetch does not cancel the job RunPod already
 * accepted, and with one worker allowed each redundant "hi" is served in turn,
 * spending GPU time on nothing. Loading 16GB takes minutes, which is longer
 * than any sensible client timeout, so a retry is always the wrong move here.
 *
 * So exactly one request is sent and left to finish, and progress is reported
 * from RunPod's health in parallel. Whichever settles first decides: the reply
 * arriving means it is warm, and a worker reaching ready means the same.
 */
export async function warm(apiKey, endpointId, { onProgress, timeoutMs = 900000 } = {}) {
  const started = Date.now();
  const base = openaiBase(endpointId);
  let done = false;

  const probe = fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'breakthrough', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => '');
    // A 4xx that is not a queue problem is a configuration error; waiting
    // cannot fix it, so it is raised rather than retried.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new Error('エンドポイントが ' + res.status + ' を返しました。設定を確認してください: ' + detail.slice(0, 300));
    }
    return { ok: false, status: res.status, detail };
  });

  const watch = (async () => {
    while (!done && Date.now() - started < timeoutMs) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const h = await health(apiKey, endpointId).catch(() => null);
      onProgress?.({ elapsed, workers: h?.workers || null, jobs: h?.jobs || null });
      if (Number(h?.workers?.ready) > 0) return { ok: true };
      await new Promise((r) => setTimeout(r, 10000));
    }
    return { ok: false, timedOut: true };
  })();

  try {
    const result = await Promise.race([probe, watch]);
    if (result.ok) return { ready: true, seconds: Math.round((Date.now() - started) / 1000) };
    if (result.timedOut) {
      throw new Error(
        '起動が ' + Math.round(timeoutMs / 60000) + ' 分以内に完了しませんでした。GPU の在庫切れか、モデルが大きすぎる可能性があります。'
      );
    }
    throw new Error('エンドポイントが ' + result.status + ' を返しました: ' + String(result.detail).slice(0, 300));
  } finally {
    done = true;
  }
}

/**
 * Submits one job and follows it to a verdict.
 *
 * The synchronous path cannot report a startup failure: it holds the socket
 * while the worker tries to load, and the caller gives up first — Node's fetch
 * at its 300-second header timeout, a Worker with a bare 500. Neither carries
 * the reason. The job API keeps the verdict on the server, so "ran out of GPU
 * memory during startup" is actually readable.
 */
export async function probeJob(apiKey, endpointId, { onProgress, timeoutMs = 900000 } = {}) {
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };
  const submit = await fetch(RUN + '/' + endpointId + '/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: { prompt: 'ping', sampling_params: { max_tokens: 8 } } }),
    signal: AbortSignal.timeout(60000),
  });
  const queued = await submit.json().catch(() => null);
  if (!queued?.id) {
    return { ok: false, stage: 'submit', status: submit.status, detail: JSON.stringify(queued || {}).slice(0, 500) };
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10000));
    const state = await fetch(RUN + '/' + endpointId + '/status/' + queued.id, { headers })
      .then((r) => r.json())
      .catch((e) => ({ status: 'UNKNOWN', error: e.message }));
    const elapsed = Math.round((Date.now() - started) / 1000);
    onProgress?.({ elapsed, status: state.status });
    if (['IN_QUEUE', 'IN_PROGRESS'].includes(state.status)) continue;
    return {
      ok: state.status === 'COMPLETED',
      stage: 'job',
      jobId: queued.id,
      seconds: elapsed,
      status: state.status,
      // The whole thing: the useful part is whatever was not expected.
      detail: JSON.stringify(state).slice(0, 2000),
    };
  }
  // Not a failure: it is still starting, and the id says where to look.
  return {
    ok: false,
    stage: 'job',
    jobId: queued.id,
    status: 'STILL_RUNNING',
    seconds: Math.round(timeoutMs / 1000),
    note: 'まだ起動中です。数分後にもう一度診断してください。',
  };
}

/**
 * Everything knowable about an endpoint from outside it.
 *
 * A 500 from the OpenAI path says nothing about why, and the reason is almost
 * always that vLLM refused to start — a parser name it does not recognise, a
 * quantisation that does not match the weights. What that leaves behind is an
 * unhealthy worker count and, usually, a detail string in the raw body. Both
 * are collected here rather than guessed at.
 */
export async function diagnose(apiKey, endpointId) {
  const out = { endpointId };

  out.endpoint = await call(apiKey, '/endpoints/' + endpointId).catch((e) => ({ error: e.message }));
  if (out.endpoint?.templateId) {
    const t = await call(apiKey, '/templates/' + out.endpoint.templateId).catch((e) => ({ error: e.message }));
    out.template = t?.error
      ? t
      : {
          imageName: t?.imageName,
          // A token would be a secret; the rest is configuration.
          env: Object.fromEntries(
            Object.entries(t?.env || {}).map(([k, v]) => [k, /TOKEN|KEY/i.test(k) ? '（設定あり）' : v])
          ),
        };
    if (out.template.env) {
      const expected = templateBody().env;
      out.drift = Object.keys(expected).filter((k) => String(out.template.env[k]) !== String(expected[k]));
    }
  }

  out.health = await health(apiKey, endpointId).catch((e) => ({ error: e.message }));

  /* Bounded well under any browser's patience.
   *
   * A cold start takes minutes, and waiting for one here meant the request
   * never returned — the console showed "Load failed" while the server was
   * still politely holding on. A startup failure, which is what this is for,
   * surfaces in seconds once the image is cached; anything still queued after
   * the cap is reported as such, with its job id so it can be checked later. */
  out.probe = await probeJob(apiKey, endpointId, { timeoutMs: 40000 }).catch((e) => ({ error: e.message }));

  out.expected = DEFAULT_SPEC;
  return out;
}

/** Sanity checks that would otherwise surface as a puzzling 400 minutes later. */
export function validateSpec(spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const problems = [];
  if (!s.model || !/^[\w.-]+\/[\w.-]+$/.test(s.model)) {
    problems.push('model は Hugging Face の "owner/name" 形式で指定してください');
  }
  // The combination people get wrong: a 24GB card and an unquantized 27B.
  const firstGpu = Array.isArray(s.gpu) ? s.gpu[0] : s.gpu;
  if (!s.quantization && /(?:2[0-9]|[3-9][0-9])b/i.test(s.model) && /4090|4080|3090/i.test(firstGpu)) {
    problems.push('24GB のカードに 20B 超を無量子化で載せることはできません。AWQ / GPTQ 版を指定してください');
  }
  if (s.quantization && !['awq', 'gptq', 'squeezellm', 'bitsandbytes'].includes(s.quantization)) {
    problems.push('quantization は awq / gptq / squeezellm / bitsandbytes のいずれかです');
  }
  if (!s.toolParser) {
    problems.push('toolParser が未設定です。エージェントはツール呼び出しができません');
  }
  return problems;
}

/* ---------------------------------------------------------------------------
 * Picking a reply back up off RunPod.
 *
 * RunPod keeps every job — including the ones the OpenAI-compatible route
 * creates behind the scenes — for roughly half an hour after it finishes, with
 * the entire SSE stream stored as the job's output. The Cloudflare Worker that
 * was transcribing that stream into D1 has no such staying power: waitUntil
 * outlives the response by seconds, so a closed tab or an evicted isolate can
 * lose a reply the GPU actually produced and billed for.
 *
 * Nothing in the OpenAI route's response names the job — no header, no field —
 * so the id cannot be written down in advance. What the stored chunks do carry
 * is `created`, and that is enough to line a finished job up with the message
 * that was waiting for one.
 * ------------------------------------------------------------------------- */

/** Recent jobs on the endpoint, newest first, as RunPod still remembers them. */
export async function listRequests(apiKey, endpointId) {
  const res = await fetch(RUN + '/' + endpointId + '/requests', {
    headers: { authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('RunPod requests → ' + res.status);
  const json = await res.json().catch(() => null);
  return Array.isArray(json?.requests) ? json.requests : [];
}

/** One job, with its output if it has finished. */
export async function fetchJob(apiKey, endpointId, jobId) {
  const res = await fetch(RUN + '/' + endpointId + '/status/' + encodeURIComponent(jobId), {
    headers: { authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('RunPod status → ' + res.status);
  return res.json();
}

/* A job's output is whatever the worker wrote, which is not one shape: the
 * streaming route stores strings holding several `data: {...}` frames apiece,
 * the non-streaming one stores the completion object, and the worker's native
 * handler stores something else again. All three are flattened to chunks. */
function chunksOf(output) {
  const out = [];
  const take = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(take);
      return;
    }
    if (typeof value === 'object') {
      out.push(value);
      return;
    }
    for (const line of String(value).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const body = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      // [DONE] is a terminator, and a frame split across two stored strings is
      // unparseable — neither is worth failing the whole recovery over.
      if (!body || body === '[DONE]') continue;
      try {
        out.push(JSON.parse(body));
      } catch {
        /* ignore */
      }
    }
  };
  take(output);
  return out;
}

/** The reply a finished job holds, reassembled. */
export function extractCompletion(job) {
  const chunks = chunksOf(job?.output);
  let text = '';
  let reasoning = '';
  let usage = null;
  let created = null;
  let chatId = null;
  let finishReason = null;

  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    if (!created && Number(chunk.created)) created = Number(chunk.created);
    if (!chatId && typeof chunk.id === 'string') chatId = chunk.id;

    const choice = chunk.choices?.[0];
    if (!choice) {
      if (typeof chunk.text === 'string') text += chunk.text;
      continue;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    // delta for a stream, message for a single completion; tokens is the
    // worker's own format.
    const part = choice.delta || choice.message || {};
    if (typeof part.content === 'string') text += part.content;
    else if (Array.isArray(part.content)) {
      text += part.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    if (typeof part.reasoning_content === 'string') reasoning += part.reasoning_content;
    else if (typeof part.reasoning === 'string') reasoning += part.reasoning;
    if (typeof choice.text === 'string') text += choice.text;
    if (Array.isArray(choice.tokens)) text += choice.tokens.join('');
  }

  return { text, reasoning, usage, created, chatId, finishReason, status: job?.status || null };
}

/* How far from the message's own timestamp a job may sit and still be its
 * reply. Generous on the late side because the job is finished after the
 * message row was created, and only slightly tolerant on the early side for
 * clock skew between RunPod and the Worker. */
const MATCH_BEFORE_SEC = 120;
const MATCH_AFTER_SEC = 3600;

/**
 * Finds the finished job that belongs to a message and returns its reply.
 *
 * @param {number} since  the message row's created_at, in epoch seconds
 * @returns {Promise<{found: object|null, pending: object[], checked: number}>}
 */
export async function recoverReply(apiKey, endpointId, { since = 0, limit = 8 } = {}) {
  const requests = await listRequests(apiKey, endpointId);
  const pending = requests.filter((r) => r.status === 'IN_QUEUE' || r.status === 'IN_PROGRESS');
  const done = requests.filter((r) => r.status === 'COMPLETED').slice(0, limit);

  const candidates = [];
  for (const row of done) {
    const job = await fetchJob(apiKey, endpointId, row.id).catch(() => null);
    if (!job) continue;
    const reply = extractCompletion(job);
    if (!reply.text && !reply.reasoning) continue;
    candidates.push({ ...reply, jobId: row.id, executionTime: row.executionTime ?? null });
  }
  if (!candidates.length) return { found: null, pending, checked: done.length };

  /* Which job is this message's? The timestamps inside the chunks decide when
   * they are usable, and length breaks the tie when they are not — a job with
   * no `created` at all is better than telling someone their reply is gone. */
  const inWindow = since
    ? candidates.filter((c) => c.created && c.created >= since - MATCH_BEFORE_SEC && c.created <= since + MATCH_AFTER_SEC)
    : [];
  const pool = inWindow.length ? inWindow : candidates;
  const found = since && inWindow.length
    ? pool.reduce((best, c) => (Math.abs(c.created - since) < Math.abs(best.created - since) ? c : best))
    : pool.reduce((best, c) => (c.text.length > best.text.length ? c : best));

  return { found, pending, checked: done.length, matched: inWindow.length > 0 };
}
