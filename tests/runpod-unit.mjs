import {
  templateBody,
  endpointBody,
  openaiBase,
  validateSpec,
  provision,
  destroy,
  resolveSpec,
  imageFor,
  modelReference,
  attachModel,
  workerInfo,
  describeStartup,
  fmtDuration,
  extractCompletion,
  matchModelRef,
  modelCacheResult,
  QWEN38_MEMORY,
  vramEstimate,
  describeWorkers,
  warm as warmUp,
  isAppJob,
  rememberOwnJob,
  diagnose,
  cacheEnv,
  redact,
  maskEnv,
  describeModelCache,
  GPU_MEMORY_GIB,
  applyGpuChoice,
  recoverReply,
  failedReason,
  WORKER_META_KEY,
  DEFAULT_SPEC,
  VLLM_SPEC,
  VLLM_IMAGE,
  LLAMACPP_IMAGE,
} from '../src/lib/runpod.js';
import { buildRequest, consumeChatStream } from '../src/lib/chat.js';
import { readFileSync } from 'node:fs';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

/* -------------------------------- the URL -------------------------------- */
check('OpenAI 互換のベースURL', openaiBase('abc123') === 'https://api.runpod.ai/v2/abc123/openai/v1', openaiBase('abc123'));

/* ------------------------------- defaults -------------------------------- */
check('既定は llama.cpp', DEFAULT_SPEC.engine === 'llamacpp', DEFAULT_SPEC.engine);
check('  指定のモデル', DEFAULT_SPEC.model === 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF', DEFAULT_SPEC.model);
check('  配布元推奨の IQ3_S', DEFAULT_SPEC.quantization === 'IQ3_S', DEFAULT_SPEC.quantization);
check('  1 本目のシャードを指す', /^IQ3_S\/.*-00001-of-00002\.gguf$/.test(DEFAULT_SPEC.modelFile), DEFAULT_SPEC.modelFile);
check('  A100 80GB を先に、H100 80GB を次に', /^NVIDIA A100/.test(DEFAULT_SPEC.gpu[0]) &&
  DEFAULT_SPEC.gpu.findIndex((g) => /H100/.test(g)) > DEFAULT_SPEC.gpu.findLastIndex((g) => /A100/.test(g)), DEFAULT_SPEC.gpu.join(', '));
// Cheapest Serverless tier first: A100 $2.72 < RTX PRO 6000 $3.49 < H100 $4.79 < H200 $5.93 (per hour).
const tierOf = (g) => (/A100/.test(g) ? 1 : /RTX PRO 6000/.test(g) ? 2 : /H100/.test(g) ? 3 : /H200/.test(g) ? 4 : 99);
check('  安い順（A100 → RTX PRO 6000 → H100 → H200）', DEFAULT_SPEC.gpu.every((g, i, a) => i === 0 || tierOf(a[i - 1]) <= tierOf(g)), DEFAULT_SPEC.gpu.join(', '));
check('  空きの多い RTX PRO 6000 Server を H100 より前に', DEFAULT_SPEC.gpu.indexOf('NVIDIA RTX PRO 6000 Blackwell Server Edition') < DEFAULT_SPEC.gpu.indexOf('NVIDIA H100 80GB HBM3'));
check('  高い B200 と、載らない 48GB 以下は入れない', !DEFAULT_SPEC.gpu.some((g) => /B200|A6000|A40|L40|4090/.test(g)) && DEFAULT_SPEC.gpu.every((g) => tierOf(g) < 99));
check('  どの候補でも 262K で 10 GiB 以上余る',
  DEFAULT_SPEC.gpu.every((g) => GPU_MEMORY_GIB[g] && vramEstimate({ ctx: 262144, gpu: g }).spare >= 10),
  DEFAULT_SPEC.gpu.map((g) => g.replace('NVIDIA ', '') + ' ' + vramEstimate({ ctx: 262144, gpu: g }).spare.toFixed(1)).join(', '));
check('  CUDA 12.8 以上のホストだけ（A100/H100 は PTX を読み込み時に変換する）', DEFAULT_SPEC.minCudaVersion === '12.8' && endpointBody('t').minCudaVersion === '12.8');
check('  以前の vLLM 構成には付けない', !('minCudaVersion' in endpointBody('t', VLLM_SPEC)));
check('  RunPod のキャッシュを使う', DEFAULT_SPEC.cacheModel === true);
check('  Model 欄に入れる値（使っているコミットに固定）',
  modelReference() === 'https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF:eec4e10a2c29b440a2ae85591fa11569ce752963', modelReference());
check('イメージは固定タグ', /:v\d+\.\d+/.test(VLLM_IMAGE) && !/latest/.test(VLLM_IMAGE), VLLM_IMAGE);
check('  llama.cpp はビルド番号とワーカー版で固定', /:b\d+-\d+$/.test(LLAMACPP_IMAGE), LLAMACPP_IMAGE);
// The workflow builds what the Dockerfile says; the app must name the same tag.
const dockerfile = readFileSync(new URL('../runpod-worker/llamacpp/Dockerfile', import.meta.url), 'utf8');
const dfTag = dockerfile.match(/^FROM .*:server-cuda-(b\d+)/m)?.[1] + '-' + dockerfile.match(/^ENV WORKER_VERSION=(\d+)/m)?.[1];
check('  Dockerfile と同じタグ', LLAMACPP_IMAGE.endsWith(':' + dfTag), dfTag);
check('エンジンでイメージを選ぶ', imageFor(DEFAULT_SPEC) === LLAMACPP_IMAGE && imageFor(VLLM_SPEC) === VLLM_IMAGE);
// A partial vLLM spec must not inherit llama.cpp's parsers-less defaults.
check('部分指定は同じエンジンの既定で補う', resolveSpec({ engine: 'vllm' }).toolParser === 'qwen3_coder');

/* ------------------------- template: llama.cpp --------------------------- */
const l = templateBody();
check('llama.cpp ワーカーを使う', l.imageName === LLAMACPP_IMAGE);
check('  コミットを固定して渡す', l.env.MODEL_REVISION === 'eec4e10a2c29b440a2ae85591fa11569ce752963');
check('  R2 は既定では使わない（RunPod の secret が要る）', !Object.keys(l.env).some((k) => k.startsWith('R2_')));
const withR2 = templateBody({ useR2: true });
check('  R2 を使うときは場所を渡す', withR2.env.R2_BUCKET === 'hyperai-models' &&
  withR2.env.R2_PREFIX === 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF/eec4e10a2c29b440a2ae85591fa11569ce752963', withR2.env.R2_PREFIX);
check('  認証情報は RunPod の secret の参照だけ（値は入れない）',
  withR2.env.R2_ACCESS_KEY_ID === '{{ RUNPOD_SECRET_hyperai_r2_access_key_id }}' &&
  withR2.env.R2_SECRET_ACCESS_KEY === '{{ RUNPOD_SECRET_hyperai_r2_secret_access_key }}' &&
  withR2.env.R2_ENDPOINT === '{{ RUNPOD_SECRET_hyperai_r2_endpoint }}');
check('  R2 の起動表示', describeStartup({ source: 'r2', startupSeconds: 600, readyAt: 2000 }, 1000)?.label === 'R2 の控えから起動（10分）');
check('  サーバーレス用として作る', l.isServerless === true);
check('  ボリュームを付けない', l.volumeInGb === 0, 'ストレージ課金が発生しない条件');
check('  代替のダウンロード 84GB が入るディスク', l.containerDiskInGb >= 89, l.containerDiskInGb + 'GB');
check('  リポジトリを渡す', l.env.MODEL_REPO === DEFAULT_SPEC.model);
check('  キャッシュを先に探させる', l.env.MODEL_CACHE === 'on');
check('  キャッシュ不使用も指定できる', templateBody({ cacheModel: false }).env.MODEL_CACHE === 'off');
check('  代替では選んだ量子化のフォルダだけ取得', l.env.MODEL_INCLUDE === 'IQ3_S/*', l.env.MODEL_INCLUDE);
check('  読み込むファイル', l.env.MODEL_FILE === DEFAULT_SPEC.modelFile);
check('  文脈長はモデル本来の 262K', l.env.CTX_SIZE === '262144', l.env.CTX_SIZE);

/* ---------------------------- memory: 262K fits --------------------------- */
// From the GGUF: 12 attention layers × (K 2×256 + V 2×256 + indexer 2×128), f16.
check('KV: 1 トークン 30,720 バイト（f16）', QWEN38_MEMORY.kvBytesPerToken.f16 === 12 * (2 * 256 + 2 * 256 + 2 * 128) * 2);
check('  q8_0 は 34/32 バイト/値', QWEN38_MEMORY.kvBytesPerToken.q8_0 === (12 * (2 * 256 + 2 * 256 + 2 * 128) * 34) / 32);
const at262 = vramEstimate({ ctx: 262144 });
check('262K の KV は 7.5 GiB', Math.abs(at262.kvGiB - 7.5) < 0.01, at262.kvGiB.toFixed(2));
check('  80GB に 10 GiB 以上の余裕を残して載る', at262.spare >= 10, 'spare ' + at262.spare.toFixed(1) + ' GiB / total ' + at262.total.toFixed(1));
check('  既定の文脈長がそれ', DEFAULT_SPEC.maxModelLen === 262144 && vramEstimate({ ctx: DEFAULT_SPEC.maxModelLen, seqs: DEFAULT_SPEC.maxNumSeqs }).spare >= 10);
check('  q8_0 にしなくてよい（f16 で足りる）', vramEstimate({ ctx: 262144, kv: 'q8_0' }).kvGiB < at262.kvGiB && at262.spare > 0);
check('  モデル名を短縮名に固定', l.env.SERVED_MODEL_NAME === 'breakthrough');
check('  vLLM の変数を混ぜない', !('MODEL_NAME' in l.env) && !('QUANTIZATION' in l.env));

/* --------------------------- template: vLLM ------------------------------ */
const t = templateBody(VLLM_SPEC);
check('vLLM ワーカーを使う', t.imageName === VLLM_IMAGE);
check('サーバーレス用として作る', t.isServerless === true);
check('ボリュームを付けない', t.volumeInGb === 0, 'ストレージ課金が発生しない条件');
check('モデルを環境変数で渡す', t.env.MODEL_NAME === VLLM_SPEC.model);
check('量子化を渡す', t.env.QUANTIZATION === 'awq');
check('文脈長を渡す', t.env.MAX_MODEL_LEN === '32768');

// Without these the agent receives prose where it expects tool_calls.
check('ツール呼び出しを有効化する', t.env.ENABLE_AUTO_TOOL_CHOICE === 'true');
// Verified against the running endpoint: this model emits the Qwen3-Coder
// XML shape, and the hermes parser left it in content as prose.
check('  パーサを指定する', t.env.TOOL_CALL_PARSER === 'qwen3_coder', t.env.TOOL_CALL_PARSER);
check('モデル名を短縮名に固定', t.env.OPENAI_SERVED_MODEL_NAME_OVERRIDE === 'breakthrough');

const noQuant = templateBody({ engine: 'vllm', quantization: null, model: 'a/b' });
check('量子化なしなら渡さない', !('QUANTIZATION' in noQuant.env));
const gated = templateBody({ hfToken: 'hf_x' });
check('HF トークンは渡されたときだけ', gated.env.HF_TOKEN === 'hf_x' && !('HF_TOKEN' in t.env) && !('HF_TOKEN' in l.env));

/* ------------------------------- endpoint -------------------------------- */
const e = endpointBody('tpl_1');
check('テンプレートを参照する', e.templateId === 'tpl_1');
check('最小ワーカーは 0', e.workersMin === 0, 'アイドル課金が発生しない条件');
check('  ネットワークボリュームを付けない', !('networkVolumeId' in e), '付けると月額が発生する');
check('FlashBoot を有効化', e.flashboot === true, 'コールドスタート短縮');
// 51 GiB of resident weights need an 80GB card; the order is the preference.
check('GPU は A100 80GB から', e.gpuTypeIds[0] === 'NVIDIA A100 80GB PCIe', e.gpuTypeIds.join(', '));
check('  在庫切れに備えて複数指定', e.gpuTypeIds.length > 1, String(e.gpuTypeIds.length));
check('実行タイムアウトに余裕', e.executionTimeoutMs >= 600000, String(e.executionTimeoutMs) + 'ms');
// An 80GB card waiting is the expensive part; a reload from cache is a minute.
check('アイドル待機は短く', e.idleTimeout <= 30, e.idleTimeout + '秒');
check('  ただしエージェントの検索の合間よりは長く', e.idleTimeout >= 10, e.idleTimeout + '秒');
check('  重み読み込み分を見込む', e.executionTimeoutMs / 60000 >= 10, Math.round(e.executionTimeoutMs / 60000) + '分');
const ev = endpointBody('tpl_1', VLLM_SPEC);
check('以前の構成は 48GB のまま', /A6000/.test(ev.gpuTypeIds[0]) && ev.idleTimeout === 300, ev.gpuTypeIds[0]);

/* ------------------------------ validation ------------------------------- */
check('妥当な既定は通る', validateSpec().length === 0, validateSpec().join(' / '));
check('以前の vLLM 構成も通る', validateSpec(VLLM_SPEC).length === 0, validateSpec(VLLM_SPEC).join(' / '));

const badFit = validateSpec({ engine: 'vllm', model: 'huihui-ai/Huihui-Qwen3.8-27B-abliterated', quantization: null, gpu: 'NVIDIA GeForce RTX 4090' });
check('24GB に 27B 無量子化は止める', badFit.some((p) => p.includes('24GB')), badFit.join(' / '));

check('不正なモデル名を弾く', validateSpec({ model: 'notapath' }).some((p) => p.includes('owner/name')));
check('未知の量子化を弾く', validateSpec({ engine: 'vllm', quantization: 'magic' }).some((p) => p.includes('quantization')));
check('パーサ未設定を警告', validateSpec({ engine: 'vllm', toolParser: '' }).some((p) => p.includes('ツール')));
check('未知のエンジンを弾く', validateSpec({ engine: 'tgi' }).some((p) => p.includes('engine')));
check('GGUF 以外の量子化名を弾く', validateSpec({ quantization: 'awq' }).some((p) => p.includes('GGUF')));
check('量子化とファイルの食い違いを弾く', validateSpec({ quantization: 'IQ2_XS' }).some((p) => p.includes('一致')));
check('.gguf でないファイルを弾く', validateSpec({ modelFile: 'IQ3_S/model.bin' }).some((p) => p.includes('modelFile')));
check('ディスク不足を弾く', validateSpec({ containerDiskInGb: 80 }).some((p) => p.includes('containerDiskInGb')));
check('IQ2_XS への切り替えは通る', validateSpec({
  quantization: 'IQ2_XS',
  modelFile: 'IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ2_XS-00001-of-00002.gguf',
  containerDiskInGb: 80,
}).length === 0);

/* ------------------------- the request it sends -------------------------- */
const bt = { baseUrl: openaiBase('ep_1'), model: 'breakthrough' };
const req = (reasoning) => buildRequest({ provider: 'runpod', model: 'breakthrough', messages: [], options: { reasoning }, apiKey: 'k', breakthrough: bt }).body;
check('思考は既定でオフ', req('').chat_template_kwargs.enable_thinking === false && !('reasoning_effort' in req('').chat_template_kwargs));
check('  オフなら深さを送らない', !('reasoning_effort' in req('off').chat_template_kwargs));
check('  low はそのまま', req('low').chat_template_kwargs.reasoning_effort === 'low');
check('  medium はそのまま', req('medium').chat_template_kwargs.reasoning_effort === 'medium');
check('  high はテンプレートの xhigh', req('high').chat_template_kwargs.reasoning_effort === 'xhigh');

/* ----------------------------- worker report ----------------------------- */
check('ワーカーの起動元を読む', workerInfo({ choices: [], worker: { source: 'cache' } })?.source === 'cache');
check('  ストリームの出力（配列）からも読む', workerInfo([{ worker: { source: 'download' } }])?.source === 'download');
check('  vLLM の出力では null', workerInfo([{ choices: [] }]) === null && workerInfo(null) === null);

/* ------------------------ startup, shown with replies --------------------- */
check('時間の表記: 秒', fmtDuration(42) === '42秒' && fmtDuration(0) === '0秒');
check('  分と秒', fmtDuration(125) === '2分5秒' && fmtDuration(120) === '2分', fmtDuration(125));
check('  10分を超えたら分だけ', fmtDuration(1080) === '18分' && fmtDuration(1085) === '18分', fmtDuration(1080));

const TURN = 1760000000;
const cold = describeStartup({ source: 'cache', startupSeconds: 42, readyAt: TURN + 50 }, TURN);
check('このターンで起動: 事前保存', cold?.cold === true && cold.label === '事前保存から起動（42秒）', cold?.label);
const dl = describeStartup({ source: 'download', startupSeconds: 1080, readyAt: TURN + 1100 }, TURN);
check('このターンで起動: ダウンロード', dl?.cold === true && dl.label === 'ダウンロードして起動（18分）', dl?.label);
const warm = describeStartup({ source: 'cache', startupSeconds: 42, readyAt: TURN - 600 }, TURN);
check('前から起きていたワーカー', warm?.cold === false && warm.label === '起動済みのワーカー', warm?.label);
// Clock skew between RunPod and Cloudflare must not turn a cold start warm.
check('  時計のずれ数秒は起動扱い', describeStartup({ source: 'cache', startupSeconds: 3, readyAt: TURN - 2 }, TURN)?.cold === true);
check('  時間が無くても方式は出す', describeStartup({ source: 'download', readyAt: TURN + 1 }, TURN)?.label === 'ダウンロードして起動');
check('情報が無ければ何も出さない', describeStartup(null, TURN) === null && describeStartup({ source: 'cache' }, TURN) === null);

// The stream frame the worker sends first, read the way the chat route reads it.
const sseResponse = (frames) =>
  new Response(frames.map((f) => 'data: ' + (typeof f === 'string' ? f : JSON.stringify(f)) + '\n\n').join(''));
const seen = { worker: [], text: '' };
await consumeChatStream(
  sseResponse([
    { object: 'chat.completion.chunk', choices: [], [WORKER_META_KEY]: { source: 'cache', startupSeconds: 42, readyAt: TURN + 50 } },
    { choices: [{ delta: { content: 'こんにちは' } }] },
    '[DONE]',
  ]),
  { onWorker: (w) => seen.worker.push(w), onText: (t) => (seen.text += t) }
);
check('ストリームの起動情報を拾う', seen.worker.length === 1 && seen.worker[0].source === 'cache', JSON.stringify(seen.worker));
check('  本文には混ざらない', seen.text === 'こんにちは', seen.text);

// Recovery reads the same stored stream; the extra frame must not disturb it.
const recovered = extractCompletion({
  status: 'COMPLETED',
  output: [
    'data: ' + JSON.stringify({ object: 'chat.completion.chunk', choices: [], [WORKER_META_KEY]: { source: 'cache', readyAt: TURN } }) + '\n\n',
    'data: ' + JSON.stringify({ id: 'c1', created: TURN + 3, choices: [{ delta: { content: '回収' } }] }) + '\n\n',
  ],
});
check('回収: 起動情報のフレームを無視する', recovered.text === '回収' && recovered.created === TURN + 3 && recovered.chatId === 'c1', JSON.stringify(recovered));

// The page: shown while streaming, and kept with the saved reply.
const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
check('画面: ストリーム中に表示する', /event === 'worker'[\s\S]{0,80}setStartup\(p\)/.test(appSrc));
check('  保存された返答の下にも出す', /msg\.meta\?\.startup\?\.label/.test(appSrc));
const routeSrc = readFileSync(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
check('  メッセージの meta に保存する', /base\.startup = startup/.test(routeSrc) && /emit\('worker', startup\)/.test(routeSrc));

/* ------------------------------- lifecycle ------------------------------- */
// Enough of the REST and GraphQL APIs to see the call sequence without
// spending money. GraphQL calls are recorded by operation name.
const GQL_ENDPOINT = {
  id: 'ep_9', name: 'hyperai-breakthrough', templateId: 'tpl_9', gpuIds: 'AMPERE_80,ADA_80_PRO,-NVIDIA H100 NVL',
  gpuCount: 1, instanceIds: [], workersMin: 0, workersMax: 1, locations: '', networkVolumeId: '',
  networkVolumeIds: [], idleTimeout: 15, scalerType: 'QUEUE_DELAY', scalerValue: 4, executionTimeoutMs: 1800000,
  minCudaVersion: '', flashBootType: 'FLASHBOOT',
};
function fakeFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://api.runpod.io/graphql') {
      const body = JSON.parse(options.body);
      const op = body.query.match(/(?:query|mutation) (\w+)/)[1];
      calls.push('GQL ' + op);
      calls.gql = (calls.gql || []).concat([{ op, variables: body.variables, headers: options.headers }]);
      const hit = plan['GQL ' + op];
      const payload = hit instanceof Error ? { errors: [{ message: hit.message }] } : { data: hit ?? {} };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    const path = String(url).replace('https://rest.runpod.io/v1', '');
    calls.push((options.method || 'GET') + ' ' + path);
    const hit = plan[(options.method || 'GET') + ' ' + path.split('/').slice(0, 2).join('/')];
    if (hit === undefined) return { ok: true, status: 200, text: async () => '{}' };
    if (hit instanceof Error) return { ok: false, status: 400, text: async () => hit.message };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
  };
  return calls;
}
const realFetch = globalThis.fetch;
const REF = 'https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF:eec4e10a2c29b440a2ae85591fa11569ce752963';

let calls = fakeFetch({
  'POST /templates': { id: 'tpl_9' },
  'POST /endpoints': { id: 'ep_9' },
  'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } },
  'GQL SaveEndpoint': { saveEndpoint: { id: 'ep_9', modelReferences: [REF] } },
});
const out = await provision('key');
check('テンプレート→エンドポイントの順で作る', calls[0].startsWith('POST /templates') && calls[1].startsWith('POST /endpoints'), calls.join(' → '));
check('  ベースURLを組み立てて返す', out.base === openaiBase('ep_9'), out.base);
check('  短縮モデル名を返す', out.model === 'breakthrough');
check('  そのあとキャッシュを付ける（設定と env を読んでから保存）',
  calls[2] === 'GQL EndpointConfig' && calls[3] === 'GET /endpoints/ep_9' && calls[4] === 'GQL SaveEndpoint', calls.join(' → '));
check('  付けられたと報告する', out.modelCache?.ok === true && out.modelCache.value === REF, JSON.stringify(out.modelCache));
const saved = calls.gql.find((g) => g.op === 'SaveEndpoint').variables.input;
check('  モデルの参照を送る', JSON.stringify(saved.modelReferences) === JSON.stringify([REF]));
// saveEndpoint replaces the whole config; anything not echoed would be reset.
check('  GPU の指定をそのまま戻す', saved.gpuIds === GQL_ENDPOINT.gpuIds, saved.gpuIds);
check('  ほかの設定もそのまま戻す', saved.templateId === 'tpl_9' && saved.workersMax === 1 && saved.idleTimeout === 15 &&
  saved.executionTimeoutMs === 1800000 && saved.flashBootType === 'FLASHBOOT' && saved.id === 'ep_9');
check('  GraphQL も Bearer で認証', calls.gql[0].headers.authorization === 'Bearer key');

// The endpoint works without the cache, so a failed attach must not undo it.
calls = fakeFetch({
  'POST /templates': { id: 'tpl_9' },
  'POST /endpoints': { id: 'ep_9' },
  'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } },
  'GQL SaveEndpoint': new Error('modelReferences is not allowed'),
});
const partial = await provision('key');
check('キャッシュに失敗してもエンドポイントは残す', partial.endpointId === 'ep_9' && !calls.some((c) => c.startsWith('DELETE')), calls.join(' → '));
check('  失敗と、手で入れる値を返す', partial.modelCache?.ok === false && /not allowed/.test(partial.modelCache.error) && partial.modelCache.value === REF);

calls = fakeFetch({ 'GQL EndpointConfig': { myself: { endpoint: { ...GQL_ENDPOINT, gpuIds: '' } } } });
let refused = false;
try {
  await attachModel('key', 'ep_9', [REF]);
} catch {
  refused = true;
}
check('GPU 指定が読めなければ上書きしない', refused && !calls.includes('GQL SaveEndpoint'), calls.join(' → '));

calls = fakeFetch({ 'POST /templates': { id: 'tpl_v' }, 'POST /endpoints': { id: 'ep_v' } });
const old = await provision('key', VLLM_SPEC);
check('vLLM ではキャッシュを付けない', old.modelCache === null && !calls.some((c) => c.startsWith('GQL')), calls.join(' → '));

// A template left behind with no endpoint is clutter nobody will find.
calls = fakeFetch({ 'POST /templates': { id: 'tpl_x' }, 'POST /endpoints': new Error('no GPU capacity') });
let threw = false;
try {
  await provision('key');
} catch {
  threw = true;
}
check('作成が途中で失敗したら片付ける', threw && calls.some((c) => c === 'DELETE /templates/tpl_x'), calls.join(' → '));

calls = fakeFetch({});
await destroy('key', { endpointId: 'ep_9', templateId: 'tpl_9' });
check('破棄はワーカーを 0 にしてから', calls[0] === 'PATCH /endpoints/ep_9', calls.join(' → '));
check('  エンドポイントを削除する', calls.includes('DELETE /endpoints/ep_9'));
check('  テンプレートも削除する', calls.includes('DELETE /templates/tpl_9'));

globalThis.fetch = realFetch;

/* ---------------------- cache: RunPod pins ":main" to a SHA --------------- */
// Verbatim from production: sent ":main", RunPod stored the commit.
const SHA_REF = 'https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF:eec4e10a2c29b440a2ae85591fa11569ce752963';
check('キャッシュ: SHA に解決されていても成功', matchModelRef([SHA_REF], REF) === SHA_REF);
check('  同じ値でも成功', matchModelRef([REF], REF) === REF);
check('  別のリポジトリは失敗', matchModelRef(['https://huggingface.co/other/model:main'], REF) === null);
check('  名前の一部だけ一致は失敗', matchModelRef([REF.replace('GGUF:', 'GGUF-v2:')], REF) === null);
check('  :main と送って SHA が返っても成功（以前の記録）', matchModelRef([SHA_REF], REF.replace(/:[0-9a-f]+$/, ':main')) === SHA_REF);
check('  一覧が無ければ失敗', matchModelRef(null, REF) === null && matchModelRef([], REF) === null);
const stored = modelCacheResult([SHA_REF], REF);
check('  解決後の値を残す（画面に出す）', stored.ok === true && stored.resolved === SHA_REF && stored.value === REF, JSON.stringify(stored));

/* ------------------- recovery: decisions are not replies ------------------ */
const decision = extractCompletion({
  status: 'COMPLETED',
  output: [{ choices: [{ finish_reason: 'tool_calls', message: { content: '法的な枠組みを確認しました。実務的な選択肢をもう少し調べます。', tool_calls: [{ id: 't' }] } }] }],
});
check('検索の判断（ツール呼び出し）と分かる', decision.toolCalls === true, JSON.stringify(decision).slice(0, 120));
check('  普通の返答はそう扱わない', extractCompletion({ output: [{ choices: [{ finish_reason: 'stop', message: { content: '答え' } }] }] }).toolCalls === false);

// Verbatim from the failed production job.
const FAILED_JOB = {
  status: 'FAILED',
  error: '{"error":{"code":400,"message":"request (34479 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":34479,"n_ctx":32768}}',
};
check('失敗の理由を読み出す', failedReason(FAILED_JOB).startsWith('request (34479 tokens) exceeds the available context size'), failedReason(FAILED_JOB));
check('  理由が無ければそう言う', failedReason({ status: 'FAILED' }) === '理由が記録されていません');
check('  ワーカーのログ付きの理由もそのまま', failedReason({ error: 'llama-server 500: boom\n--- llama-server log（末尾） ---\nCUDA error' }).includes('CUDA error'));

const jobs = {
  'job-decision': { status: 'COMPLETED', output: [{ created: 1000, choices: [{ finish_reason: 'tool_calls', message: { content: '調べます', tool_calls: [{}] } }] }] },
  'job-failed': FAILED_JOB,
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/requests')) {
    return { ok: true, status: 200, json: async () => ({ requests: [{ id: 'job-failed', status: 'FAILED' }, { id: 'job-decision', status: 'COMPLETED' }] }) };
  }
  const id = decodeURIComponent(u.split('/status/')[1] || '');
  return { ok: true, status: 200, json: async () => jobs[id] };
};
const rec = await recoverReply('key', 'ep', { since: 1000 });
check('回収: 判断のジョブを返答として取り込まない', rec.found === null && rec.decisions === 1, JSON.stringify(rec).slice(0, 200));
check('  失敗したジョブの理由を返す', rec.failed.length === 1 && rec.failed[0].error.includes('34479'), JSON.stringify(rec.failed));
globalThis.fetch = realFetch;

/* --------------------- workers: only "running" bills ---------------------- */
// Seen in production ~90 s after the last job, idleTimeout 15: a stopped
// FlashBoot worker, counted as both idle and ready.
const after = describeWorkers({ workers: { idle: 1, ready: 1, running: 0, initializing: 0 }, jobs: { completed: 7, failed: 2 } });
check('ready だけのワーカーは待機（課金なし）', after.billed === false && after.running === 0 && after.standby === 1, JSON.stringify(after));
check('  idle と ready の二重計上をしない', after.standby === 1);
const busy = describeWorkers({ workers: { idle: 0, ready: 1, running: 1 }, jobs: { inProgress: 1 } });
check('running があれば課金中', busy.billed === true && busy.running === 1 && busy.standby === 0, JSON.stringify(busy));
const prep = describeWorkers({ workers: { initializing: 1 }, jobs: { inQueue: 1 } });
check('準備中は課金なし', prep.billed === false && prep.initializing === 1 && prep.inQueue === 1);
check('health が無くても壊れない', describeWorkers(null).billed === false && describeWorkers(undefined).standby === 0);

// A warm-up is done when its job is, not when a stopped worker shows as ready.
// It goes in through /run, so a long queue does not drop it.
const jobSeq = ['IN_QUEUE', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];
let statusCalls = 0;
let warmSubmit = null;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.endsWith('/run')) {
    warmSubmit = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ id: 'warm-1', status: 'IN_QUEUE' }) };
  }
  if (u.includes('/status/')) {
    const status = jobSeq[Math.min(statusCalls++, jobSeq.length - 1)];
    return { ok: true, status: 200, json: async () => ({ id: 'warm-1', status }) };
  }
  // health: a stopped FlashBoot worker counted as ready from the start
  return { ok: true, status: 200, json: async () => ({ workers: { idle: 1, ready: 1 }, jobs: { inQueue: 1 } }) };
};
const warmed = await warmUp('key', 'ep', { timeoutMs: 5000, pollMs: 5 });
check('ウォームアップ: /run のジョブで起こす', warmSubmit?.input?.openai_route === '/v1/chat/completions' && warmSubmit.input.openai_input.max_tokens === 1);
check('  ジョブに 2 時間の実行上限と寿命を付ける', warmSubmit.policy.executionTimeout === 7200000 && warmSubmit.policy.ttl === 10800000, JSON.stringify(warmSubmit.policy));
check('  ready では完了にしない', statusCalls === 4, 'status calls ' + statusCalls);
check('  ジョブの完了で完了にする', warmed.ready === true && warmed.jobId === 'warm-1');
globalThis.fetch = async (url) =>
  String(url).endsWith('/run')
    ? { ok: true, status: 200, json: async () => ({ id: 'warm-2' }) }
    : String(url).includes('/status/')
      ? { ok: true, status: 200, json: async () => ({ status: 'FAILED', error: 'llama-server 500: boom' }) }
      : { ok: true, status: 200, json: async () => ({}) };
let warmErr = '';
try {
  await warmUp('key', 'ep', { timeoutMs: 5000, pollMs: 5 });
} catch (e) {
  warmErr = e.message;
}
check('  失敗したら理由を言う', warmErr.includes('FAILED') && warmErr.includes('boom'), warmErr);
globalThis.fetch = realFetch;

/* ------------- recovery: the app's own jobs are never a reply ------------- */
// Production, 2026-10-24: "RunPod から回収" took the diagnosis probe's eight
// tokens of "ping" for a reply. Its output, as the worker returns it:
const PROBE_OUT = {
  status: 'COMPLETED',
  output: [{
    id: 'cmpl-1', object: 'text_completion', created: 1792821600,
    choices: [{ index: 0, text: '") > 0\n\n\ndef test_d', finish_reason: 'length' }],
    usage: { prompt_tokens: 2, completion_tokens: 8 },
    worker: { source: 'cache', version: '5' },
  }],
};
const WARM_OUT = {
  status: 'COMPLETED',
  output: [{ id: 'chatcmpl-w', object: 'chat.completion', created: 1792821590, choices: [{ message: { content: 'H' }, finish_reason: 'length' }], usage: { completion_tokens: 1 } }],
};
const SHORT_REPLY = {
  status: 'COMPLETED',
  output: ['data: ' + JSON.stringify({ id: 'chatcmpl-r', created: 1792821620, choices: [{ delta: { content: 'はい。' }, finish_reason: 'stop' }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [], usage: { completion_tokens: 3 } }) + '\n\n'],
};
check('診断の probe は答えではない', isAppJob(extractCompletion(PROBE_OUT)) === true, JSON.stringify(extractCompletion(PROBE_OUT)).slice(0, 100));
check('  起動の warm（1 トークンで打ち切り）も答えではない', isAppJob(extractCompletion(WARM_OUT)) === true);
check('  短くても普通に終わった返答は答え', isAppJob(extractCompletion(SHORT_REPLY)) === false);
check('  記録した ID は形に関係なく除く', isAppJob(extractCompletion(SHORT_REPLY), 'j1', new Set(['j1'])) === true);
check('ID の記録: 新しい順に 40 件まで、重複なし',
  rememberOwnJob(['a', 'b'], 'b').join() === 'b,a' && rememberOwnJob(Array.from({ length: 50 }, (_, i) => 'x' + i), 'n').length === 40);

const jobBoard = (jobs) => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/requests')) {
      return { ok: true, status: 200, json: async () => ({ requests: Object.keys(jobs).map((id) => ({ id, status: 'COMPLETED' })) }) };
    }
    return { ok: true, status: 200, json: async () => jobs[decodeURIComponent(u.split('/status/')[1])] };
  };
};
const SINCE = 1792821587; // the message's created_at
jobBoard({ probe: PROBE_OUT, warm: WARM_OUT, reply: { ...SHORT_REPLY } });
let rr = await recoverReply('k', 'ep', { since: SINCE });
check('回収: 時刻が近い probe・warm より、返答を選ぶ', rr.found?.jobId === 'reply' && rr.appJobs === 2, JSON.stringify({ found: rr.found?.jobId, appJobs: rr.appJobs }));

jobBoard({ probe: PROBE_OUT, warm: WARM_OUT });
rr = await recoverReply('k', 'ep', { since: SINCE });
check('  返答が消えていて probe だけなら、何も取り込まない（今回の事故）', rr.found === null && rr.appJobs === 2);

const OTHER_TURN = { status: 'COMPLETED', output: ['data: ' + JSON.stringify({ created: SINCE + 7200, choices: [{ delta: { content: '別の発言への長い返答' } }] }) + '\n\n'] };
jobBoard({ other: OTHER_TURN });
rr = await recoverReply('k', 'ep', { since: SINCE });
check('  時刻の合わない返答は、長くても取り込まない', rr.found === null && rr.outOfWindow === 1, JSON.stringify(rr).slice(0, 120));

jobBoard({ ownlooking: { ...SHORT_REPLY } });
rr = await recoverReply('k', 'ep', { since: SINCE, ownJobs: new Set(['ownlooking']) });
check('  記録したアプリのジョブは除く', rr.found === null && rr.appJobs === 1);
globalThis.fetch = realFetch;

/* --------------------- your own Hugging Face copy ------------------------ */
const OWN = 'someone/qwen38-flash-next-abliterated-iq3s';
check('自分のリポジトリ: 未設定なら元のリポジトリをコミット固定で', modelReference({}) === REF);
check('  設定すると事前保存の参照は自分のリポジトリ（main）', modelReference({ ownRepo: OWN }) === 'https://huggingface.co/' + OWN + ':main');
const ownT = templateBody({ ownRepo: OWN });
check('  ワーカーに自分のリポジトリを渡し、元も残す', ownT.env.OWN_MODEL_REPO === OWN && ownT.env.MODEL_REPO === DEFAULT_SPEC.model && ownT.env.MODEL_REVISION === DEFAULT_SPEC.revision);
// RunPod validates a private cached model with the endpoint's env, and does
// not expand secret references there: the token goes on the endpoint, not here.
check('  テンプレートにはトークンを入れない', !('HF_TOKEN' in ownT.env));
check('  エンドポイントの env に入れるのは、自分のリポジトリでトークンがあるときだけ',
  cacheEnv({ ownRepo: OWN }, 'hf_x').HF_TOKEN === 'hf_x' && Object.keys(cacheEnv({}, 'hf_x')).length === 0 && Object.keys(cacheEnv({ ownRepo: OWN }, null)).length === 0);
check('  未設定なら HF_TOKEN を付けない（元は公開）', !('HF_TOKEN' in templateBody().env) && !('OWN_MODEL_REPO' in templateBody().env));
check('  形の誤りを弾く', validateSpec({ ownRepo: 'no-slash' }).some((p) => p.includes('owner/name')) && validateSpec({ ownRepo: OWN }).length === 0);
// Switching the cache to your own copy: a reference to the original no longer counts.
check('  元のリポジトリの事前保存は、自分のリポジトリの設定とは一致しない', modelCacheResult([SHA_REF], modelReference({ ownRepo: OWN })).ok === false);

// Diagnosis: secret references are compared raw, not as their masked display.
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes('/endpoints/')) return { ok: true, status: 200, text: async () => JSON.stringify({ templateId: 'tpl' }) };
  if (u.includes('/templates/')) return { ok: true, status: 200, text: async () => JSON.stringify({ imageName: LLAMACPP_IMAGE, env: ownT.env }) };
  if (u.includes('graphql')) return { ok: true, status: 200, json: async () => ({ data: { myself: { endpoint: { modelReferences: [] } } } }) };
  if (u.endsWith('/run')) return { ok: true, status: 200, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({}) };
};
const dg = await diagnose('k', 'ep', { ownRepo: OWN });
check('診断: secret を参照する設定でも、ずれと誤判定しない', Array.isArray(dg.drift) && dg.drift.length === 0, JSON.stringify(dg.drift));
check('  テンプレートの env にトークンは無い', !('HF_TOKEN' in dg.template.env));
globalThis.fetch = realFetch;

/* ------------- private copy: the token goes on the endpoint -------------- */
const TOKEN = 'hf_SECRETvalue1234';
const OWN_REF = 'https://huggingface.co/' + OWN + ':main';
// What the console left on the production endpoint: MODEL_NAME and a token.
const CONSOLE_ENV = { MODEL_NAME: 'AItaro0214/qwen38-flash-next-abliterated-iq3s', OTHER: '1' };

calls = fakeFetch({
  'GET /endpoints': { id: 'ep_9', env: CONSOLE_ENV },
  'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } },
  'GQL SaveEndpoint': { saveEndpoint: { id: 'ep_9', modelReferences: [OWN_REF.replace(':main', ':ec130c79fed1986f1b79866e31a283968f117c87')] } },
});
let got = await attachModel('key', 'ep_9', [OWN_REF], { env: { HF_TOKEN: TOKEN } });
let sentInput = calls.gql.find((g) => g.op === 'SaveEndpoint').variables.input;
const asMap = (list) => Object.fromEntries((list || []).map((v) => [v.key, v.value]));
check('非公開: エンドポイントの env に HF_TOKEN の実値を足す', asMap(sentInput.env).HF_TOKEN === TOKEN, JSON.stringify(Object.keys(asMap(sentInput.env))));
check('  既存の env（MODEL_NAME など）は消さない', asMap(sentInput.env).MODEL_NAME === CONSOLE_ENV.MODEL_NAME && asMap(sentInput.env).OTHER === '1');
check('  形は [{key, value}]', Array.isArray(sentInput.env) && sentInput.env.every((v) => 'key' in v && 'value' in v));
check('  SHA に解決された参照で成功と分かる', modelCacheResult(got, OWN_REF).ok === true);

// Without a token to add, the env still goes back unchanged (saveEndpoint replaces everything).
calls = fakeFetch({
  'GET /endpoints': { id: 'ep_9', env: { ...CONSOLE_ENV, HF_TOKEN: TOKEN } },
  'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } },
  'GQL SaveEndpoint': { saveEndpoint: { id: 'ep_9', modelReferences: [REF] } },
});
await attachModel('key', 'ep_9', [REF]);
sentInput = calls.gql.find((g) => g.op === 'SaveEndpoint').variables.input;
check('  足すものが無くても env をそのまま送り返す', JSON.stringify(asMap(sentInput.env)) === JSON.stringify({ ...CONSOLE_ENV, HF_TOKEN: TOKEN }));

// Unreadable env: adding a token would mean guessing the rest — refuse.
calls = fakeFetch({ 'GET /endpoints': new Error('boom'), 'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } } });
let attachErr = '';
try {
  await attachModel('key', 'ep_9', [OWN_REF], { env: { HF_TOKEN: TOKEN } });
} catch (e) {
  attachErr = e.message;
}
check('  env が読めなければ上書きしない', /環境変数が読めない/.test(attachErr) && !calls.includes('GQL SaveEndpoint'), attachErr);

// GraphQL echoes rejected input values in its errors; the token must not survive that.
calls = fakeFetch({
  'GET /endpoints': { id: 'ep_9', env: {} },
  'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } },
  'GQL SaveEndpoint': new Error('Variable "$input" got invalid value { key: "HF_TOKEN", value: "' + TOKEN + '" }'),
});
attachErr = '';
try {
  await attachModel('key', 'ep_9', [OWN_REF], { env: { HF_TOKEN: TOKEN } });
} catch (e) {
  attachErr = e.message;
}
check('  エラーにトークンの値を残さない', attachErr.includes('***') && !attachErr.includes(TOKEN), attachErr);
check('値を伏せる', redact('a ' + TOKEN + ' b ' + TOKEN, [TOKEN]) === 'a *** b ***' && redact('x', ['']) === 'x');

// Provisioning: the token reaches RunPod, and nothing the route echoes back.
calls = fakeFetch({
  'POST /templates': { id: 'tpl_o' },
  'POST /endpoints': { id: 'ep_o' },
  'GET /endpoints': { id: 'ep_o', env: {} },
  'GQL EndpointConfig': { myself: { endpoint: GQL_ENDPOINT } },
  'GQL SaveEndpoint': { saveEndpoint: { id: 'ep_o', modelReferences: [OWN_REF] } },
});
const createdOwn = await provision('key', { ownRepo: OWN }, { hfToken: TOKEN });
sentInput = calls.gql.find((g) => g.op === 'SaveEndpoint').variables.input;
check('作成時: 事前保存と一緒にトークンを渡す', asMap(sentInput.env).HF_TOKEN === TOKEN && createdOwn.modelCache.ok === true);
check('  返す値にトークンが入らない', !JSON.stringify(createdOwn).includes(TOKEN));
check('  テンプレートにも入れない', !JSON.stringify(templateBody({ ownRepo: OWN })).includes(TOKEN));

// Display: credentials show as set, never as values.
check('表示: トークン類は伏せる', JSON.stringify(maskEnv({ HF_TOKEN: TOKEN, R2_SECRET_ACCESS_KEY: 'x', MODEL_NAME: 'm' })) ===
  JSON.stringify({ HF_TOKEN: '（設定あり）', R2_SECRET_ACCESS_KEY: '（設定あり）', MODEL_NAME: 'm' }));
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/endpoints/')) return { ok: true, status: 200, text: async () => JSON.stringify({ templateId: 'tpl', env: { HF_TOKEN: TOKEN, MODEL_NAME: 'm' } }) };
  if (u.includes('/templates/')) return { ok: true, status: 200, text: async () => JSON.stringify({ imageName: LLAMACPP_IMAGE, env: {} }) };
  if (u.includes('graphql')) return { ok: true, status: 200, json: async () => ({ data: { myself: { endpoint: { modelReferences: [] } } } }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
const dg2 = await diagnose('k', 'ep', { ownRepo: OWN });
check('  診断の結果にエンドポイントの HF_TOKEN を出さない', !JSON.stringify(dg2).includes(TOKEN) && dg2.endpoint.env.HF_TOKEN === '（設定あり）');
globalThis.fetch = realFetch;

/* ------------- the cache status follows RunPod, not a record ------------- */
const staleFailure = { ok: false, error: 'Failed to validate model reference … Unable to access model', value: OWN_REF, at: 1 };
const liveOk = describeModelCache({
  liveRefs: [OWN_REF.replace(':main', ':ec130c79fed1986f1b79866e31a283968f117c87')],
  stored: staleFailure,
  expected: OWN_REF,
});
check('キャッシュ表示: 今の RunPod の設定に従う（古い失敗の記録より優先）', liveOk.ok === true && liveOk.live === true && !liveOk.error, JSON.stringify(liveOk));
check('  RunPod が読めなければ記録を出す', describeModelCache({ liveRefs: null, stored: staleFailure, expected: OWN_REF }).ok === false &&
  describeModelCache({ liveRefs: null, stored: staleFailure, expected: OWN_REF }).live === false);
check('  別のリポジトリなら、そう分かる', describeModelCache({ liveRefs: [SHA_REF], stored: null, expected: OWN_REF }).otherRepo === true);
check('  何も無ければ未設定', describeModelCache({ liveRefs: [], stored: null, expected: OWN_REF }).ok === false &&
  describeModelCache({ liveRefs: null, stored: null, expected: OWN_REF }) === null);

/* ------------- GPU choice on an existing endpoint (no recreate) ------------- */
// A REST fake whose endpoint env and cache can be dropped by the PATCH, as
// the docs leave possible.
const gpuFake = ({ dropEnv = false, dropRefs = false, unreadable = false } = {}) => {
  const state = { env: { MODEL_NAME: 'm', HF_TOKEN: TOKEN }, refs: [OWN_REF] };
  const log = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://api.runpod.io/graphql') {
      const b = JSON.parse(options.body);
      const op = b.query.match(/(?:query|mutation) (\w+)/)[1];
      log.push('GQL ' + op);
      if (op === 'EndpointModels') return { ok: true, status: 200, json: async () => ({ data: { myself: { endpoint: { modelReferences: state.refs } } } }) };
      if (op === 'EndpointConfig') return { ok: true, status: 200, json: async () => ({ data: { myself: { endpoint: GQL_ENDPOINT } } }) };
      if (op === 'SaveEndpoint') {
        log.saved = b.variables.input;
        state.refs = b.variables.input.modelReferences;
        state.env = asMap(b.variables.input.env);
        return { ok: true, status: 200, json: async () => ({ data: { saveEndpoint: { id: 'ep_9', modelReferences: state.refs } } }) };
      }
    }
    const method = options.method || 'GET';
    log.push(method + ' ' + u.replace('https://rest.runpod.io/v1', ''));
    if (method === 'PATCH') {
      log.patch = JSON.parse(options.body);
      if (dropEnv) state.env = {};
      if (dropRefs) state.refs = [];
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (unreadable) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'ep_9', env: state.env }) };
  };
  return { state, log };
};

let g = gpuFake();
let applied = await applyGpuChoice('key', 'ep_9', { ownRepo: OWN });
check('GPU の反映: 候補と CUDA の下限を PATCH する', JSON.stringify(g.log.patch.gpuTypeIds) === JSON.stringify(DEFAULT_SPEC.gpu) && g.log.patch.minCudaVersion === '12.8');
check('  何も消えなければ、それ以上は触らない', !g.log.includes('GQL SaveEndpoint') && applied.restored === false, g.log.join(' → '));

g = gpuFake({ dropEnv: true, dropRefs: true });
applied = await applyGpuChoice('key', 'ep_9', { ownRepo: OWN });
check('  消えた事前保存と env を戻す', g.state.refs[0] === OWN_REF && g.state.env.HF_TOKEN === TOKEN && g.state.env.MODEL_NAME === 'm' && applied.restored === true);
check('  返す値に env の値を入れない', !JSON.stringify(applied).includes(TOKEN) && applied.lostEnvKeys.includes('HF_TOKEN'));

g = gpuFake({ unreadable: true });
let gpuErr = '';
try {
  await applyGpuChoice('key', 'ep_9', { ownRepo: OWN });
} catch (e) {
  gpuErr = e.message;
}
check('  今の設定が読めなければ変更しない', /変更しません/.test(gpuErr) && !g.log.some((x) => x.startsWith('PATCH')), g.log.join(' → '));
globalThis.fetch = realFetch;

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
