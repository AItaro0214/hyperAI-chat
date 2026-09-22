import {
  templateBody,
  endpointBody,
  openaiBase,
  validateSpec,
  provision,
  destroy,
  DEFAULT_SPEC,
  VLLM_IMAGE,
} from '../src/lib/runpod.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

/* -------------------------------- the URL -------------------------------- */
check('OpenAI 互換のベースURL', openaiBase('abc123') === 'https://api.runpod.ai/v2/abc123/openai/v1', openaiBase('abc123'));

/* ------------------------------- defaults -------------------------------- */
check('既定は量子化版を指す', DEFAULT_SPEC.quantization === 'awq', DEFAULT_SPEC.quantization);
check('  bf16 を既定にしていない', /awq/i.test(DEFAULT_SPEC.model), DEFAULT_SPEC.model);
check('イメージは固定タグ', /:v\d+\.\d+/.test(VLLM_IMAGE) && !/latest/.test(VLLM_IMAGE), VLLM_IMAGE);

/* ------------------------------- template -------------------------------- */
const t = templateBody();
check('vLLM ワーカーを使う', t.imageName === VLLM_IMAGE);
check('サーバーレス用として作る', t.isServerless === true);
check('ボリュームを付けない', t.volumeInGb === 0, 'ストレージ課金が発生しない条件');
check('モデルを環境変数で渡す', t.env.MODEL_NAME === DEFAULT_SPEC.model);
check('量子化を渡す', t.env.QUANTIZATION === 'awq');
check('文脈長を渡す', t.env.MAX_MODEL_LEN === '32768');

// Without these the agent receives prose where it expects tool_calls.
check('ツール呼び出しを有効化する', t.env.ENABLE_AUTO_TOOL_CHOICE === 'true');
check('  パーサを指定する', t.env.TOOL_CALL_PARSER === 'hermes', t.env.TOOL_CALL_PARSER);
check('モデル名を短縮名に固定', t.env.OPENAI_SERVED_MODEL_NAME_OVERRIDE === 'breakthrough');

const noQuant = templateBody({ quantization: null, model: 'a/b' });
check('量子化なしなら渡さない', !('QUANTIZATION' in noQuant.env));
const gated = templateBody({ hfToken: 'hf_x' });
check('HF トークンは渡されたときだけ', gated.env.HF_TOKEN === 'hf_x' && !('HF_TOKEN' in t.env));

/* ------------------------------- endpoint -------------------------------- */
const e = endpointBody('tpl_1');
check('テンプレートを参照する', e.templateId === 'tpl_1');
check('最小ワーカーは 0', e.workersMin === 0, 'アイドル課金が発生しない条件');
check('  ネットワークボリュームを付けない', !('networkVolumeId' in e), '付けると月額が発生する');
check('FlashBoot を有効化', e.flashboot === true, 'コールドスタート短縮');
check('GPU を指定', e.gpuTypeIds[0] === 'NVIDIA GeForce RTX 4090');
check('実行タイムアウトに余裕', e.executionTimeoutMs >= 600000, String(e.executionTimeoutMs) + 'ms');
// A short idle timeout spends minutes of GPU re-loading 16GB to save cents.
check('アイドル待機が短すぎない', e.idleTimeout >= 120, e.idleTimeout + '秒');
check('  重み読み込み分を見込む', e.executionTimeoutMs / 60000 >= 10, Math.round(e.executionTimeoutMs / 60000) + '分');

/* ------------------------------ validation ------------------------------- */
check('妥当な既定は通る', validateSpec().length === 0, validateSpec().join(' / '));

const badFit = validateSpec({ model: 'huihui-ai/Huihui-Qwen3.8-27B-abliterated', quantization: null, gpu: 'NVIDIA GeForce RTX 4090' });
check('24GB に 27B 無量子化は止める', badFit.some((p) => p.includes('24GB')), badFit.join(' / '));

check('不正なモデル名を弾く', validateSpec({ model: 'notapath' }).some((p) => p.includes('owner/name')));
check('未知の量子化を弾く', validateSpec({ quantization: 'magic' }).some((p) => p.includes('quantization')));
check('パーサ未設定を警告', validateSpec({ toolParser: '' }).some((p) => p.includes('ツール')));

/* ------------------------------- lifecycle ------------------------------- */
// Enough of the REST API to see the call sequence without spending money.
function fakeFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
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

let calls = fakeFetch({ 'POST /templates': { id: 'tpl_9' }, 'POST /endpoints': { id: 'ep_9' } });
const out = await provision('key');
check('テンプレート→エンドポイントの順で作る', calls[0].startsWith('POST /templates') && calls[1].startsWith('POST /endpoints'), calls.join(' → '));
check('  ベースURLを組み立てて返す', out.base === openaiBase('ep_9'), out.base);
check('  短縮モデル名を返す', out.model === 'breakthrough');

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

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
