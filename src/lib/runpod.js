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
export const RUN_BASE = RUN;

/* How long a breakthrough reply may take, all told (see runpod-jobs.js).
 *
 * The wait is queue + startup + generation, and the first can be most of it:
 * a fresh endpoint spends twenty minutes having RunPod cache the model before
 * a worker can start at all. So the two hours is the app's total wait; the
 * job's own executionTimeout (counted from pickup) is the same, so it never
 * cuts what the total still allows; and its lifespan (ttl, from submission,
 * after which RunPod deletes it in any state) has an hour more, for the
 * result to be collected. */
const HOUR_MS = 3600 * 1000;
export const JOB_WAIT_MS = 2 * HOUR_MS;
export const JOB_EXECUTION_MS = 2 * HOUR_MS;
export const JOB_TTL_MS = 3 * HOUR_MS;
const GRAPHQL = 'https://api.runpod.io/graphql';

/* The maintained vLLM worker. Pinned rather than :latest so a breaking change
 * upstream cannot alter a working setup without being asked for. */
export const VLLM_IMAGE = 'runpod/worker-v1-vllm:v2.27.1';

/* llama.cpp, for models vLLM cannot load. RunPod publishes no llama.cpp
 * worker, so this is built from runpod-worker/llamacpp in this repository by
 * .github/workflows/llamacpp-worker.yml. The tag is the llama.cpp build it is
 * based on and the handler's WORKER_VERSION, pinned for the same reason as the
 * vLLM one; the workflow refuses to build if this does not match. */
export const LLAMACPP_IMAGE = 'ghcr.io/aitaro0214/hyperai-llamacpp-worker:b11804-5';

/* The previous model, on vLLM. Kept whole so going back is passing this as the
 * spec rather than reconstructing it from git. */
export const VLLM_SPEC = {
  engine: 'vllm',
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
  containerDiskInGb: 30,
};

/* Qwen3.8-Flash-Next, abliterated: a 177B MoE (10 of 512 experts per token),
 * shipped only as GGUF for llama.cpp's qwen4exp architecture — which vLLM does
 * not load, hence the second engine.
 *
 * Each quant is two shards. The first is the transformer and has to be
 * resident in VRAM; the second is a 26.8 GiB n-gram embedding table that
 * llama.cpp reads through mmap, so it costs disk rather than VRAM. First
 * shards:
 *   Q2_0     35.4 GiB
 *   IQ2_XS   36.9 GiB  — the most a 48GB card holds with room for the KV cache
 *   IQ3_XXS  44.1 GiB
 *   IQ3_S    51.3 GiB  — the publisher's recommendation: matches the base model
 * IQ3_S on an 80GB card leaves ~28 GiB for KV cache, buffers and CUDA. */
export const LLAMACPP_SPEC = {
  engine: 'llamacpp',
  model: 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF',
  quantization: 'IQ3_S',
  /* The commit in use, pinned: RunPod's cache resolved ":main" to it, and the
   * R2 copy is of it. A later push to the repository changes nothing here. */
  revision: 'eec4e10a2c29b440a2ae85591fa11569ce752963',
  // The first shard; llama.cpp finds the second beside it.
  modelFile: 'IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00001-of-00002.gguf',
  /* The app's own copy, for when Hugging Face no longer serves the files
   * (scripts/mirror_model.py makes it; the worker falls back to it). Off
   * until the RunPod secrets it reads exist — see R2_SECRETS. */
  useR2: false,
  r2Bucket: 'hyperai-models',
  /* A100 first, H100 when no A100 is free; 48GB cards cannot hold IQ3_S. The
   * H100 NVL (94GB) is left out to keep the choice to the two 80GB parts. */
  gpu: ['NVIDIA A100 80GB PCIe', 'NVIDIA A100-SXM4-80GB', 'NVIDIA H100 80GB HBM3', 'NVIDIA H100 PCIe'],
  /* RunPod's cached models: the host keeps the repository, so a cold start
   * loads from local disk instead of downloading 78 GiB. The download is not
   * billed. It is the whole repository — 281 GiB, every quant — because
   * RunPod cannot yet select files; the worker falls back to fetching only
   * this quant itself when the cache is not there. */
  cacheModel: true,
  /* The model's own trained length, 262,144 — memory is not what limits it.
   * See QWEN38_MEMORY: at this length the KV cache is 7.5 GiB in f16, and an
   * 80GB card still has some 15 GiB to spare, so the cache stays f16 (q8_0
   * would save 3.5 GiB that is not needed, at a small cost in accuracy).
   * Beyond 262K would need RoPE scaling the model was not trained for. */
  maxModelLen: 262144,
  // Slots sharing that one pool (--kv-unified): an agent's side calls can
  // overlap a reply without either losing context.
  maxNumSeqs: 2,
  /* Only applied if the build knows the flag (the worker checks --help):
   * reads the n-gram table from disk on demand instead of holding it in RAM. */
  lazyMode: 'auto',
  workersMax: 1,
  /* Stop as soon as it is idle. A restart reloads 51 GiB from the host's disk,
   * about a minute, and that is preferred to paying for an 80GB card to wait.
   * Not the 1-second minimum: an agent turn pauses between rounds while it
   * searches, and dropping the worker inside one turn would reload it twice. */
  idleTimeout: 15,
  /* The endpoint's default, for jobs that do not set their own: the replies
   * do (JOB_EXECUTION_MS), and this matches it. */
  executionTimeoutMs: 7200000,
  // Only used by the fallback download: 78 GiB of shards, plus headroom.
  containerDiskInGb: 100,
};

/* -------------------------------------------------------------------------
 * How much of an 80GB card Qwen3.8-Flash-Next takes, and why the context can
 * be the model's full 262K.
 *
 * From the IQ3_S GGUF's own metadata (qwen4exp.*): 48 blocks, of which only
 * every fourth (full_attention_interval = 4: blocks 3, 7, …, 47) is attention
 * and keeps a KV cache; the other 36 are Gated DeltaNet, whose state is a
 * fixed size per sequence however long it runs. The attention layers have
 * head_count_kv = 2 and key_length = value_length = 256.
 *
 * llama.cpp's qwen4exp graph (src/models/qwen4exp.cpp) caches, per token and
 * per attention layer: K (2 × 256), V (2 × 256), and one indexer row for the
 * sparse attention (raw key + pooled key, 2 × 128). compress_ratio = 4 picks
 * which blocks are attended; it does not shrink what is stored.
 *
 *   f16: (512 + 512 + 256) × 2 bytes × 12 layers = 30,720 bytes per token
 *
 * The DeltaNet state is 128² × 48 heads in f32 per layer — 3 MiB × 36 layers,
 * about 110 MiB a sequence. Compute buffers are an estimate: sparse attention
 * reads at most 2,048 cells per query, so the large one is the indexer's
 * scores over ctx/4 pooled keys (0.5 GiB at 262K); 4 GiB covers that and the
 * MoE matmuls with room over.
 * ---------------------------------------------------------------------- */
export const QWEN38_MEMORY = {
  // The smaller of the two cards: H100 80GB HBM3 reports 81,559 MiB.
  cardGiB: 81559 / 1024,
  weightsGiB: 55063448064 / 2 ** 30, // the IQ3_S first shard, all of it resident
  kvBytesPerToken: { f16: 30720, q8_0: 16320 },
  recurrentGiBPerSeq: 0.11,
  computeGiB: 4,
  cudaGiB: 1,
};

/** Estimated VRAM, in GiB, for a context and KV type. */
export function vramEstimate({ ctx, seqs = 2, kv = 'f16' } = {}) {
  const m = QWEN38_MEMORY;
  const kvGiB = (ctx * m.kvBytesPerToken[kv]) / 2 ** 30;
  const total = m.weightsGiB + kvGiB + m.recurrentGiBPerSeq * seqs + m.computeGiB + m.cudaGiB;
  return { kvGiB, total, spare: m.cardGiB - total };
}

/* What each quant's two shards add up to, in GB as RunPod sizes disks. */
const QUANT_DISK_GB = { Q2_0: 67, IQ2_XS: 69, IQ3_XXS: 77, IQ3_S: 84 };

/** The value RunPod's console takes in an endpoint's Model field: pinned to
 * the commit in use, as the download and the R2 copy are. */
export const modelReference = (spec = {}) => {
  const s = resolveSpec(spec);
  return 'https://huggingface.co/' + s.model + ':' + (s.revision || 'main');
};

/* The R2 copy's credentials, as RunPod secrets the template refers to — so
 * they are never in the template, the app or the repository. RunPod fills
 * {{ RUNPOD_SECRET_<name> }} in when a worker starts. A template referring to
 * a secret that does not exist may not start, which is why useR2 is opt-in.
 * The token needs only read access to the bucket. */
export const R2_SECRETS = {
  R2_ENDPOINT: 'hyperai_r2_endpoint',
  R2_ACCESS_KEY_ID: 'hyperai_r2_access_key_id',
  R2_SECRET_ACCESS_KEY: 'hyperai_r2_secret_access_key',
};

/** Where the copy of a spec's files is kept in R2. */
export const r2Prefix = (spec = {}) => {
  const s = resolveSpec(spec);
  return s.model + '/' + s.revision;
};

/* "https://huggingface.co/<org>/<model>:<revision>" without the revision. */
const refRepo = (ref) => String(ref || '').replace(/:[^:/]*$/, '').toLowerCase();

/**
 * Whether the references an endpoint reports include the one asked for.
 *
 * RunPod resolves a branch to the commit it points at, so ":main" comes back
 * as ":<sha>". The repository is what has to match; the revision may be
 * either. Returns the reference as RunPod holds it, or null.
 */
export function matchModelRef(refs, wanted) {
  if (!Array.isArray(refs)) return null;
  return refs.find((r) => refRepo(r) === refRepo(wanted)) || null;
}

/** A cache attempt's outcome, from the references RunPod reports back. */
export function modelCacheResult(refs, value, extra = {}) {
  const resolved = matchModelRef(refs, value);
  return { ok: !!resolved, refs, value, resolved, ...extra };
}

export const DEFAULT_SPEC = LLAMACPP_SPEC;

export const imageFor = (spec = {}) => ((spec.engine || DEFAULT_SPEC.engine) === 'llamacpp' ? LLAMACPP_IMAGE : VLLM_IMAGE);

/* GGUF quant names llama.cpp understands, plus the new Q2_0. */
const GGUF_QUANTS = /^(?:I?Q[1-8]_(?:0|1|K)(?:_[SMLX]{1,2})?|IQ[1-4]_(?:XXS|XS|S|M|NL)|F16|BF16|F32)$/i;

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

/* GraphQL, for the one thing REST cannot do: REST's endpoint has no field for
 * cached models, which only the saveEndpoint mutation takes. This follows
 * runpodctl's own implementation (internal/api/endpoints.go), which is how the
 * console and `runpodctl serverless update --model-reference` set it. */
async function graphql(apiKey, query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors?.length) {
    const detail = json?.errors?.[0]?.message || res.status;
    throw new Error('RunPod GraphQL → ' + String(detail).slice(0, 300));
  }
  return json.data;
}

/* saveEndpoint is a full replace, so everything it takes is read back and
 * sent again unchanged — gpuIds especially, which GraphQL holds as a pool
 * string with exclusions rather than the type ids REST was given. */
const ENDPOINT_FIELDS =
  'id name templateId gpuIds gpuCount instanceIds workersMin workersMax locations networkVolumeId ' +
  'networkVolumeIds { networkVolumeId } idleTimeout scalerType scalerValue executionTimeoutMs ' +
  'minCudaVersion flashBootType';

/**
 * Points an endpoint at a Hugging Face repository for RunPod to cache on its
 * hosts. Pass an empty list to detach.
 * @returns {Promise<string[]>} the references the endpoint now has
 */
export async function attachModel(apiKey, endpointId, refs) {
  const read = await graphql(
    apiKey,
    'query EndpointConfig($id: String!) { myself { endpoint(id: $id) { ' + ENDPOINT_FIELDS + ' } } }',
    { id: endpointId }
  );
  const e = read?.myself?.endpoint;
  if (!e) throw new Error('エンドポイント ' + endpointId + ' が見つかりません');
  // An empty gpuIds would be written back as "no GPU" — refuse rather than guess.
  if (!e.gpuIds && !(e.instanceIds || []).length) throw new Error('gpuIds が読めないため、設定を上書きしません');

  const input = {
    id: endpointId,
    name: e.name,
    templateId: e.templateId,
    gpuIds: e.gpuIds,
    gpuCount: e.gpuCount,
    instanceIds: e.instanceIds,
    workersMin: e.workersMin,
    workersMax: e.workersMax,
    locations: e.locations,
    networkVolumeId: e.networkVolumeId,
    networkVolumeIds: (e.networkVolumeIds || []).map((v) => ({ networkVolumeId: v.networkVolumeId })),
    idleTimeout: e.idleTimeout,
    scalerType: e.scalerType,
    scalerValue: e.scalerValue,
    executionTimeoutMs: e.executionTimeoutMs,
    minCudaVersion: e.minCudaVersion,
    // The enum rejects an empty string.
    flashBootType: e.flashBootType || 'OFF',
    modelReferences: refs,
  };
  const saved = await graphql(
    apiKey,
    'mutation SaveEndpoint($input: EndpointInput!) { saveEndpoint(input: $input) { id modelReferences } }',
    { input }
  );
  return saved?.saveEndpoint?.modelReferences || [];
}

/** What the endpoint is set to cache, or null if that cannot be read. */
export async function cachedModels(apiKey, endpointId) {
  const data = await graphql(
    apiKey,
    'query EndpointModels($id: String!) { myself { endpoint(id: $id) { id modelReferences } } }',
    { id: endpointId }
  );
  return data?.myself?.endpoint?.modelReferences ?? null;
}

/** A spec filled in from the defaults of its own engine, not the other one's. */
export function resolveSpec(spec = {}) {
  const engine = spec.engine || DEFAULT_SPEC.engine;
  return { ...(engine === 'vllm' ? VLLM_SPEC : LLAMACPP_SPEC), ...spec, engine };
}

/* --------------------------- the vLLM template --------------------------- */

/**
 * The worker reads its whole configuration from the environment, and any
 * variable named after a `vllm serve` flag is passed straight through — which
 * is how the tool-call parser gets set.
 */
export function templateBody(spec = {}) {
  const s = resolveSpec(spec);
  if (s.engine === 'llamacpp') return llamacppTemplate(s);
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
    containerDiskInGb: s.containerDiskInGb,
    volumeInGb: 0,
    isServerless: true,
    env,
  };
}

/* The llama.cpp worker's variables are its own (see runpod-worker/llamacpp):
 * which files to load or fetch, and the handful of llama-server flags that
 * vary. The rest — --jinja for the model's own template and tool calls,
 * reasoning split out as reasoning_content — is fixed in the worker, because
 * the app depends on it. */
function llamacppTemplate(s) {
  const env = {
    MODEL_REPO: s.model,
    MODEL_FILE: s.modelFile,
    MODEL_REVISION: s.revision || '',
    // Looked for under /runpod-volume/huggingface-cache first; off skips it.
    MODEL_CACHE: s.cacheModel ? 'on' : 'off',
    // For the fallback: both shards of the chosen quant, not the 281 GiB repo.
    MODEL_INCLUDE: s.modelFile.split('/')[0] + '/*',
    CTX_SIZE: String(s.maxModelLen),
    PARALLEL: String(s.maxNumSeqs),
    LAZY_MODE: s.lazyMode || '',
    SERVED_MODEL_NAME: 'breakthrough',
  };
  if (s.hfToken) env.HF_TOKEN = s.hfToken;
  if (s.useR2) {
    env.R2_BUCKET = s.r2Bucket;
    env.R2_PREFIX = r2Prefix(s);
    for (const [name, secret] of Object.entries(R2_SECRETS)) env[name] = '{{ RUNPOD_SECRET_' + secret + ' }}';
  }

  return {
    name: 'hyperai-breakthrough-' + Date.now().toString(36),
    imageName: LLAMACPP_IMAGE,
    containerDiskInGb: s.containerDiskInGb,
    volumeInGb: 0,
    isServerless: true,
    env,
  };
}

export function endpointBody(templateId, spec = {}) {
  const s = resolveSpec(spec);
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
 * Creates the template and the endpoint, and asks RunPod to cache the model.
 *
 * The endpoint is created over REST, as before, so it keeps the GPU types in
 * their order of preference; the cache is attached afterwards. A failure there
 * does not undo the endpoint — the worker downloads for itself instead — and is
 * returned so the console's Model field can be filled in by hand.
 *
 * @returns {Promise<{endpointId: string, templateId: string, base: string, model: string, modelCache: object|null}>}
 */
export async function provision(apiKey, spec = {}) {
  const s = resolveSpec(spec);
  const template = await call(apiKey, '/templates', { method: 'POST', body: templateBody(s) });
  const templateId = template?.id;
  if (!templateId) throw new Error('テンプレートの作成に失敗しました（id が返りません）');

  let endpointId;
  try {
    const endpoint = await call(apiKey, '/endpoints', { method: 'POST', body: endpointBody(templateId, s) });
    endpointId = endpoint?.id;
    if (!endpointId) throw new Error('エンドポイントの作成に失敗しました（id が返りません）');
  } catch (e) {
    // A template with no endpoint is invisible clutter; take it back out.
    await call(apiKey, '/templates/' + templateId, { method: 'DELETE' }).catch(() => {});
    throw e;
  }

  let modelCache = null;
  if (s.engine === 'llamacpp' && s.cacheModel) {
    const ref = modelReference(s);
    modelCache = await attachModel(apiKey, endpointId, [ref])
      .then((refs) => modelCacheResult(refs, ref))
      .catch((e) => ({ ok: false, error: e.message, value: ref }));
  }
  return { endpointId, templateId, base: openaiBase(endpointId), model: 'breakthrough', modelCache };
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
 * RunPod's /health worker counts, sorted by what they cost.
 *
 * "ready" is not "running". Per RunPod's docs only Running is billed — the
 * cold start, the jobs and the idle timeout. A worker that has scaled down
 * but is kept on the host for a fast restart (FlashBoot) is "idle", and
 * /health counts it as "ready" too (runpodctl's source notes endpoints with
 * running 0 reporting ready 1–5). So "応答可能" on ready read as "a GPU is up
 * and billing" when it was a stopped worker costing nothing. Initializing
 * (pulling the image or the cached model), throttled and unhealthy workers
 * are unbilled as well.
 */
export function describeWorkers(health) {
  const w = health?.workers || {};
  const j = health?.jobs || {};
  const n = (v) => Number(v) || 0;
  const running = n(w.running);
  // The same stopped worker can appear as both idle and ready.
  const standby = Math.max(0, Math.max(n(w.idle), n(w.ready)) - running);
  return {
    running,
    standby,
    initializing: n(w.initializing),
    throttled: n(w.throttled),
    unhealthy: n(w.unhealthy),
    inQueue: n(j.inQueue),
    inProgress: n(j.inProgress),
    completed: n(j.completed),
    billed: running > 0,
  };
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
 * So exactly one job is sent and followed by its id. It goes in through /run,
 * not the OpenAI route: a sync request is dropped long before a fresh
 * endpoint's twenty minutes of model caching is over, and its job with it.
 * The job ending is the answer — "ready" is not, since it also counts a
 * stopped FlashBoot worker, which appears before the job has even started
 * (see describeWorkers).
 */
export async function warm(apiKey, endpointId, { onProgress, timeoutMs = JOB_WAIT_MS, pollMs = 10000 } = {}) {
  const started = Date.now();
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };
  const submit = await fetch(RUN + '/' + endpointId + '/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: {
        openai_route: '/v1/chat/completions',
        openai_input: { model: 'breakthrough', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
      },
      policy: { executionTimeout: JOB_EXECUTION_MS, ttl: JOB_TTL_MS },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const queued = await submit.json().catch(() => null);
  if (!queued?.id) {
    throw new Error('起動用のジョブを送れませんでした（' + submit.status + '）: ' + JSON.stringify(queued || {}).slice(0, 300));
  }

  while (Date.now() - started < timeoutMs) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const [job, h] = await Promise.all([
      fetch(RUN + '/' + endpointId + '/status/' + encodeURIComponent(queued.id), { headers, signal: AbortSignal.timeout(30000) })
        .then((r) => r.json())
        .catch(() => null),
      health(apiKey, endpointId).catch(() => null),
    ]);
    onProgress?.({ elapsed, workers: h?.workers || null, jobs: h?.jobs || null, jobId: queued.id, jobStatus: job?.status || null });
    if (job?.status === 'COMPLETED') return { ready: true, seconds: elapsed, jobId: queued.id };
    if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job?.status)) {
      throw new Error('起動用のジョブが ' + job.status + ' で終わりました: ' + failedReason(job));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    '起動が ' + Math.round(timeoutMs / 60000) + ' 分以内に完了しませんでした（待ち行列・準備・読み込みの合計）。GPU の在庫切れか、モデルの準備に時間がかかっています。'
  );
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
/* ---------------------------------------------------------------------------
 * How the worker that answered had started, shown under the reply.
 *
 * The llama.cpp worker puts this on every reply under WORKER_META_KEY — as
 * the first frame of a stream, as a field of a single completion. It cannot
 * tell for itself whether a reply woke it: the turn may have begun with a
 * search round, or the admin tab may have warmed it a minute earlier. So it
 * says when it became ready, and the turn compares that with its own start.
 * ------------------------------------------------------------------------- */

export const WORKER_META_KEY = 'hyperai_worker';

/* RunPod's clock and Cloudflare's are both NTP-synced; this is slack for the
 * difference, and for the moment between the turn starting and the request
 * reaching RunPod. */
const STARTUP_SKEW_SEC = 5;

/** 42 → "42秒", 125 → "2分5秒", 1080 → "18分". */
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  // Past ten minutes the seconds are noise.
  if (m >= 10) return Math.round(s / 60) + '分';
  return m + '分' + (s % 60 ? (s % 60) + '秒' : '');
}

/**
 * The line shown with a breakthrough reply.
 * @param {object} worker      what the worker reported (WORKER_META_KEY)
 * @param {number} turnStarted the turn's start, in epoch seconds
 * @returns {{cold: boolean, source: string|null, seconds: number|null, label: string}|null}
 */
export function describeStartup(worker, turnStarted) {
  if (!worker || typeof worker !== 'object') return null;
  const readyAt = Number(worker.readyAt);
  // A worker that never said when it was ready cannot be placed either way.
  if (!(readyAt > 0) || !(Number(turnStarted) > 0)) return null;
  const source = ['cache', 'download', 'r2'].includes(worker.source) ? worker.source : null;
  const seconds = Number.isFinite(Number(worker.startupSeconds)) && worker.startupSeconds !== null ? Number(worker.startupSeconds) : null;

  if (readyAt < Number(turnStarted) - STARTUP_SKEW_SEC) {
    return { cold: false, source, seconds, label: '起動済みのワーカー' };
  }
  const how = { cache: '事前保存から起動', download: 'ダウンロードして起動', r2: 'R2 の控えから起動' }[source] || '起動';
  return { cold: true, source, seconds, label: how + (seconds !== null ? '（' + fmtDuration(seconds) + '）' : '') };
}

/* Where the llama.cpp worker got its weights — RunPod's cache or its own
 * download — as it reported it. A streamed job's output is a list. */
export function workerInfo(output) {
  const items = Array.isArray(output) ? output : [output];
  const found = items.find((o) => o && typeof o === 'object' && o.worker);
  return found ? found.worker : null;
}

export async function probeJob(apiKey, endpointId, { onProgress, timeoutMs = 900000 } = {}) {
  const headers = { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' };
  const submit = await fetch(RUN + '/' + endpointId + '/run', {
    method: 'POST',
    headers,
    // worker_info asks the llama.cpp worker how it started; vLLM ignores it.
    body: JSON.stringify({ input: { prompt: 'ping', sampling_params: { max_tokens: 8 }, worker_info: true } }),
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
      worker: workerInfo(state.output),
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
      const expected = templateBody();
      out.drift = Object.keys(expected.env).filter((k) => String(out.template.env[k]) !== String(expected.env[k]));
      // An endpoint still on the other engine differs in everything; say so once.
      if (out.template.imageName !== expected.imageName) out.drift.unshift('imageName');
    }
  }

  out.health = await health(apiKey, endpointId).catch((e) => ({ error: e.message }));

  // Whether RunPod was asked to cache the model, and the value to enter in
  // the console's Model field if it was not.
  if (DEFAULT_SPEC.engine === 'llamacpp' && DEFAULT_SPEC.cacheModel) {
    const value = modelReference(DEFAULT_SPEC);
    out.modelCache = await cachedModels(apiKey, endpointId)
      .then((refs) => ({ attached: !!matchModelRef(refs, value), resolved: matchModelRef(refs, value), refs, value }))
      .catch((e) => ({ attached: null, error: e.message, value }));
  }

  /* Bounded well under any browser's patience.
   *
   * A cold start takes minutes, and waiting for one here meant the request
   * never returned — the console showed "Load failed" while the server was
   * still politely holding on. A startup failure, which is what this is for,
   * surfaces in seconds once the image is cached; anything still queued after
   * the cap is reported as such, with its job id so it can be checked later. */
  out.probe = await probeJob(apiKey, endpointId, { timeoutMs: 40000 }).catch((e) => ({ error: e.message }));
  // Only a worker that answered can say how it started; a cold one is still
  // loading, and the next diagnosis will have it.
  out.weightsFrom = out.probe?.worker?.source || null;

  out.expected = DEFAULT_SPEC;
  return out;
}

/** Sanity checks that would otherwise surface as a puzzling 400 minutes later. */
export function validateSpec(spec = {}) {
  const s = resolveSpec(spec);
  const problems = [];
  if (!['vllm', 'llamacpp'].includes(s.engine)) {
    problems.push('engine は vllm / llamacpp のいずれかです');
    return problems;
  }
  if (!s.model || !/^[\w.-]+\/[\w.-]+$/.test(s.model)) {
    problems.push('model は Hugging Face の "owner/name" 形式で指定してください');
  }
  if (s.engine === 'llamacpp') {
    if (!s.modelFile || !/\.gguf$/i.test(s.modelFile) || !s.modelFile.includes('/')) {
      problems.push('modelFile は量子化フォルダ内の 1 本目の .gguf を指定してください（例: IQ2_XS/…-00001-of-00002.gguf）');
    }
    if (!s.quantization || !GGUF_QUANTS.test(s.quantization)) {
      problems.push('quantization は GGUF の量子化名（IQ2_XS / Q4_K_M など）です');
    } else if (s.modelFile && !s.modelFile.startsWith(s.quantization + '/')) {
      problems.push('quantization と modelFile のフォルダが一致しません');
    }
    // The fallback download lands on container disk, so it has to fit there.
    const needed = (QUANT_DISK_GB[String(s.quantization).toUpperCase()] || 80) + 5;
    if (!(Number(s.containerDiskInGb) >= needed)) {
      problems.push('containerDiskInGb が小さすぎます。' + s.quantization + ' には ' + needed + 'GB 以上が必要です');
    }
    return problems;
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
  let toolCalls = false;
  let textCompletion = false;
  let workerInfo = false;

  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    /* The diagnosis probe: a plain /v1/completions call ("ping") whose output
     * the worker tags with `worker`. A chat reply is neither — its worker
     * details travel as hyperai_worker. */
    if (chunk.object === 'text_completion') textCompletion = true;
    if (chunk.worker && typeof chunk.worker === 'object') workerInfo = true;
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
    if (Array.isArray(part.tool_calls) && part.tool_calls.length) toolCalls = true;
    if (typeof part.content === 'string') text += part.content;
    else if (Array.isArray(part.content)) {
      text += part.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    if (typeof part.reasoning_content === 'string') reasoning += part.reasoning_content;
    else if (typeof part.reasoning === 'string') reasoning += part.reasoning;
    if (typeof choice.text === 'string') text += choice.text;
    if (Array.isArray(choice.tokens)) text += choice.tokens.join('');
  }

  /* A completion that asks for a tool is one of the search decisions, not a
   * reply: its text is the preamble to a search ("もう少し調べます"). */
  if (finishReason === 'tool_calls') toolCalls = true;
  /* Cut off after a handful of tokens: the warm-up asks for 1 and the probe
   * for 8, where a reply is allowed 16,384. */
  const capped = finishReason === 'length' && Number(usage?.completion_tokens ?? Infinity) <= APP_JOB_MAX_TOKENS;
  return {
    text,
    reasoning,
    usage,
    created,
    chatId,
    finishReason,
    toolCalls,
    textCompletion,
    workerInfo,
    capped,
    status: job?.status || null,
  };
}

/* The most tokens a job of the app's own (warm-up, diagnosis) asks for. */
const APP_JOB_MAX_TOKENS = 16;

/**
 * Whether a finished job is one the app sent for itself — the diagnosis
 * probe or the warm-up — rather than a reply to anyone. Their output can sit
 * closer in time to a message than its real reply does, and was once taken
 * for it ('") > 0\n\n\ndef test_d', eight tokens of a "ping").
 */
export function isAppJob(reply, jobId, ownJobs) {
  if (jobId && ownJobs?.has?.(jobId)) return true;
  return !!(reply.textCompletion || reply.workerInfo || reply.capped);
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
 * Only replies are candidates: search decisions and the app's own jobs are
 * set aside (isAppJob), and so is any job outside the message's time window —
 * a reply from another turn is not this one's, and taking the longest job
 * on the endpoint, as this once did, could hand a message someone else's.
 *
 * @param {number} since  the message row's created_at, in epoch seconds
 * @param {Set<string>} [ownJobs]  ids of jobs the app sent for itself
 * @returns {Promise<{found: object|null, pending: object[], checked: number}>}
 */
export async function recoverReply(apiKey, endpointId, { since = 0, limit = 8, ownJobs = new Set() } = {}) {
  const requests = await listRequests(apiKey, endpointId);
  const pending = requests.filter((r) => r.status === 'IN_QUEUE' || r.status === 'IN_PROGRESS');
  const done = requests.filter((r) => r.status === 'COMPLETED').slice(0, limit);
  /* Failed jobs carry the reason — "request (34479 tokens) exceeds the
   * available context size", say — which is often the whole answer to why a
   * reply is missing. */
  const failed = [];
  for (const row of requests.filter((r) => r.status === 'FAILED').slice(0, 4)) {
    const job = await fetchJob(apiKey, endpointId, row.id).catch(() => null);
    failed.push({ jobId: row.id, error: failedReason(job) });
  }

  const candidates = [];
  let decisions = 0;
  let appJobs = 0;
  for (const row of done) {
    if (ownJobs.has(row.id)) {
      appJobs++;
      continue;
    }
    const job = await fetchJob(apiKey, endpointId, row.id).catch(() => null);
    if (!job) continue;
    const reply = extractCompletion(job);
    if (!reply.text.trim() && !reply.reasoning) continue;
    // A search decision is not the reply, however well its time matches.
    if (reply.toolCalls) {
      decisions++;
      continue;
    }
    // Nor is the diagnosis probe or the warm-up.
    if (isAppJob(reply, row.id, ownJobs)) {
      appJobs++;
      continue;
    }
    candidates.push({ ...reply, jobId: row.id, executionTime: row.executionTime ?? null });
  }
  const none = { found: null, pending, failed, decisions, appJobs, checked: done.length };
  if (!candidates.length) return none;

  /* Which job is this message's? The one closest in time, among those that
   * fall in the message's window. With no time to go by (since = 0) the
   * longest is the best guess; with a time and nothing near it, there is no
   * reply here for this message, and saying so beats importing another's. */
  if (!since) return { ...none, found: candidates.reduce((best, c) => (c.text.length > best.text.length ? c : best)), matched: false };
  const inWindow = candidates.filter((c) => c.created && c.created >= since - MATCH_BEFORE_SEC && c.created <= since + MATCH_AFTER_SEC);
  if (!inWindow.length) return { ...none, outOfWindow: candidates.length };
  const found = inWindow.reduce((best, c) => (Math.abs(c.created - since) < Math.abs(best.created - since) ? c : best));
  return { ...none, found, matched: true };
}

/* The ids of jobs the app sends for itself (diagnosis, warm-up), kept so the
 * recovery above can tell them from replies by id as well as by shape. */
export const OWN_JOBS_KEY = 'runpodOwnJobs';
const OWN_JOBS_KEEP = 40;

export function rememberOwnJob(list, jobId) {
  const ids = Array.isArray(list) ? list.filter((x) => x !== jobId) : [];
  return [jobId, ...ids].slice(0, OWN_JOBS_KEEP);
}

/** The reason a failed job gives, as plain text. */
export function failedReason(job) {
  let raw = job?.error ?? job?.output?.error ?? '';
  if (typeof raw !== 'string') raw = JSON.stringify(raw);
  // llama-server's error arrives as JSON inside the string.
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(raw);
      const inner = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
      if (inner === undefined || inner === null) break;
      raw = typeof inner === 'string' ? inner : JSON.stringify(inner);
    } catch {
      break;
    }
  }
  return String(raw || '理由が記録されていません').slice(0, 600);
}
