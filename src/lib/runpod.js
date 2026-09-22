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
  gpu: 'NVIDIA GeForce RTX 4090',
  maxModelLen: 32768,
  // Qwen emits Hermes-style tool calls; without a parser the agent gets prose
  // where it expects tool_calls and cannot do anything at all.
  toolParser: 'hermes',
  reasoningParser: 'qwen3',
  gpuMemoryUtilization: 0.95,
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
    gpuTypeIds: [s.gpu],
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

/** Sanity checks that would otherwise surface as a puzzling 400 minutes later. */
export function validateSpec(spec = {}) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const problems = [];
  if (!s.model || !/^[\w.-]+\/[\w.-]+$/.test(s.model)) {
    problems.push('model は Hugging Face の "owner/name" 形式で指定してください');
  }
  // The combination people get wrong: a 24GB card and an unquantized 27B.
  if (!s.quantization && /(?:2[0-9]|[3-9][0-9])b/i.test(s.model) && /4090|4080|3090/i.test(s.gpu)) {
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
