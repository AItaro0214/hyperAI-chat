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
check('  80GB 以外を含めない', DEFAULT_SPEC.gpu.every((g) => /A100.*80GB|H100 (80GB|PCIe)/.test(g)), DEFAULT_SPEC.gpu.join(', '));
check('  RunPod のキャッシュを使う', DEFAULT_SPEC.cacheModel === true);
check('  Model 欄に入れる値', modelReference() === 'https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF:main', modelReference());
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
const REF = 'https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF:main';

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
check('  そのあとキャッシュを付ける', calls[2] === 'GQL EndpointConfig' && calls[3] === 'GQL SaveEndpoint', calls.join(' → '));
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
check('  名前の一部だけ一致は失敗', matchModelRef([REF.replace('GGUF:main', 'GGUF-v2:main')], REF) === null);
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

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
