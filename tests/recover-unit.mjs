/* Reassembling a reply from a RunPod job.
 *
 * The fixtures below are the shapes a real endpoint actually stores: the
 * streaming route keeps whole `data: {...}` frames as strings, several to an
 * element, and the non-streaming one keeps the completion object. Both were
 * taken from a live job on the breakthrough endpoint.
 */
import { extractCompletion, listRequests, fetchJob, recoverReply } from '../src/lib/runpod.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const frame = (delta, extra = {}) =>
  'data: ' +
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1790070820, model: 'breakthrough', choices: [{ index: 0, delta, finish_reason: null }], ...extra }) +
  '\n\n';

/* ----------------------------- streaming job ----------------------------- */
const streamed = {
  status: 'COMPLETED',
  output: [
    // RunPod packs more than one frame into a single stored string.
    frame({ role: 'assistant', content: '' }) + frame({ content: '日本の' }),
    frame({ content: '四季' }),
    frame({ content: 'は美しい。' }),
    'data: ' +
      JSON.stringify({
        id: 'chatcmpl-1',
        created: 1790070820,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }) +
      '\n\ndata: [DONE]\n\n',
  ],
};
const s = extractCompletion(streamed);
check('ストリームのチャンクを本文に戻す', s.text === '日本の四季は美しい。', JSON.stringify(s.text));
check('  [DONE] を本文に混ぜない', !s.text.includes('DONE'));
check('  usage を拾う', s.usage?.completion_tokens === 7, JSON.stringify(s.usage));
check('  created を拾う', s.created === 1790070820, String(s.created));
check('  finish_reason を拾う', s.finishReason === 'stop', String(s.finishReason));

/* 思考は本文と分けて返す（そうしないと回答の前に独り言が挟まる）。 */
const thought = extractCompletion({
  status: 'COMPLETED',
  output: [frame({ reasoning_content: 'ふむ。' }) + frame({ content: '答えです。' })],
});
check('思考は本文と分ける', thought.text === '答えです。' && thought.reasoning === 'ふむ。', thought.text + ' / ' + thought.reasoning);

/* ---------------------------- 非ストリーミング ---------------------------- */
const whole = extractCompletion({
  status: 'COMPLETED',
  output: { id: 'chatcmpl-2', created: 1790070999, choices: [{ message: { role: 'assistant', content: 'まとめて返る形。' } }], usage: { completion_tokens: 5 } },
});
check('完了オブジェクトも読める', whole.text === 'まとめて返る形。', whole.text);

/* ワーカー独自形式。openai_route を使わない経路がこれを返す。 */
const native = extractCompletion({ status: 'COMPLETED', output: [{ choices: [{ tokens: ['ネイティブ', '形式'] }] }] });
check('ワーカー独自形式も読める', native.text === 'ネイティブ形式', native.text);

/* 壊れたフレームがあっても、読める分は返す。 */
const broken = extractCompletion({ status: 'COMPLETED', output: ['data: {"choices":[{"delta":{"content":"前半"', frame({ content: '後半' })] });
check('壊れたフレームで全滅しない', broken.text === '後半', broken.text);

check('出力なしなら空', extractCompletion({ status: 'IN_QUEUE' }).text === '');

/* ------------------------------ 突き合わせ ------------------------------- */
// The list and status endpoints, without spending GPU time.
const realFetch = globalThis.fetch;
const stub = (requests, jobs) => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/requests')) return { ok: true, status: 200, json: async () => ({ requests }) };
    const id = u.split('/status/')[1];
    return { ok: true, status: 200, json: async () => jobs[id] };
  };
};

const at = (created, content) => ({
  status: 'COMPLETED',
  output: ['data: ' + JSON.stringify({ created, choices: [{ delta: { content } }] }) + '\n\n'],
});

stub(
  [
    { id: 'new', status: 'COMPLETED' },
    { id: 'old', status: 'COMPLETED' },
  ],
  { new: at(2000, 'あとの返事'), old: at(1000, 'まえの返事') }
);
const picked = await recoverReply('key', 'ep', { since: 1990 });
check('メッセージの時刻に近いジョブを選ぶ', picked.found?.text === 'あとの返事', picked.found?.text);
check('  突き合わせできたと申告する', picked.matched === true);

// 保持期間を過ぎて何も残っていない。
stub([], {});
const none = await recoverReply('key', 'ep', { since: 1990 });
check('残っていなければ空で返す', none.found === null && none.checked === 0);

// まだ走っているジョブは「これから出る」と分かる形で返す。
stub([{ id: 'q', status: 'IN_QUEUE' }], {});
const pending = await recoverReply('key', 'ep', { since: 1990 });
check('実行中のジョブを伝える', pending.found === null && pending.pending.length === 1);

// 時刻が合うものがなければ、いちばん長い完了ジョブで妥協する。
stub([{ id: 'a', status: 'COMPLETED' }], { a: at(10, 'ずっと前の長い返事') });
const fallback = await recoverReply('key', 'ep', { since: 99999 });
check('時刻が合わなければ最長を候補にする', fallback.found?.text === 'ずっと前の長い返事' && fallback.matched === false);

globalThis.fetch = realFetch;
check('一覧と取得の関数がある', typeof listRequests === 'function' && typeof fetchJob === 'function');

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
