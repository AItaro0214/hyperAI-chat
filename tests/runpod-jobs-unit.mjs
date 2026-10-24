import {
  submitChatJob,
  runpodChatFetch,
  itemToSse,
  queueNotice,
  webhookUrl,
  verifyWebhook,
  settleMessage,
  pendingReplies,
  isFinal,
  JOB_WAIT_MS,
  JOB_EXECUTION_MS,
  JOB_TTL_MS,
} from '../src/lib/runpod-jobs.js';
import { consumeChatStream, buildRequest, BREAKTHROUGH_MAX_TOKENS } from '../src/lib/chat.js';
import { errorText } from '../src/lib/chat-tools.js';
import hook from '../src/routes/runpod-hook.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};
const realFetch = globalThis.fetch;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const FAST = { minMs: 1, maxMs: 2, budget: 50 };

/* -------------------------------- limits -------------------------------- */
check('合計の待ち時間は 2 時間', JOB_WAIT_MS === 7200000);
check('  実行の上限も 2 時間（待ち行列の後から数える）', JOB_EXECUTION_MS === JOB_WAIT_MS);
check('  ジョブの寿命は回収の余裕を足して 3 時間', JOB_TTL_MS === 3 * 3600000 && JOB_TTL_MS > JOB_WAIT_MS);
check('終わった状態の判定', isFinal('COMPLETED') && isFinal('timed_out') && !isFinal('IN_QUEUE') && !isFinal('IN_PROGRESS'));

/* ------------------------------ submission ------------------------------ */
let sent = null;
globalThis.fetch = async (url, o) => {
  sent = { url: String(url), body: JSON.parse(o.body), headers: o.headers };
  return json({ id: 'job-1', status: 'IN_QUEUE' });
};
const id = await submitChatJob('k', 'ep', { model: 'breakthrough', messages: [], stream: true }, { webhook: 'https://x/hook' });
check('/run に送る', sent.url === 'https://api.runpod.ai/v2/ep/run' && id === 'job-1', sent.url);
check('  OpenAI ルートと同じ入力の形', sent.body.input.openai_route === '/v1/chat/completions' && sent.body.input.openai_input.stream === true);
check('  ジョブごとに実行上限と寿命を付ける', sent.body.policy.executionTimeout === JOB_EXECUTION_MS && sent.body.policy.ttl === JOB_TTL_MS);
check('  webhook を付ける', sent.body.webhook === 'https://x/hook');
globalThis.fetch = async () => json({ error: 'bad' }, 400);
let err = '';
try {
  await submitChatJob('k', 'ep', {});
} catch (e) {
  err = e.message;
}
check('  送れなければ理由つきで失敗', err.includes('/run 400'), err);

/* ---------------------- fetch drop-in: no streaming ---------------------- */
const fakeRunPod = (plan) => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u.replace('https://api.runpod.ai/v2/ep', ''));
    if (u.endsWith('/run')) return json({ id: 'job-9' });
    if (u.includes('/cancel/')) return json({ status: 'CANCELLED' });
    const kind = u.includes('/stream/') ? 'stream' : 'status';
    const list = plan[kind];
    const i = calls.filter((c) => c.startsWith('/' + kind)).length - 1;
    return json(list[Math.min(i, list.length - 1)]);
  };
  return calls;
};

let calls = fakeRunPod({
  status: [
    { status: 'IN_QUEUE' },
    { status: 'IN_PROGRESS' },
    { status: 'COMPLETED', output: [{ choices: [{ message: { content: '判断' } }], hyperai_worker: { source: 'cache' } }] },
  ],
});
const order = [];
let res = await runpodChatFetch('k', 'ep', {
  poll: FAST,
  onJob: (j) => order.push('job:' + j),
  onStatus: (s) => order.push(s.status),
})('u', { body: JSON.stringify({ stream: false }) });
const body = await res.json();
check('非ストリーム: 終わったら完了の JSON を返す', res.ok && body.choices[0].message.content === '判断' && body.hyperai_worker.source === 'cache');
check('  ジョブ ID は待つ前に渡す', order[0] === 'job:job-9', order.join(','));
check('  待っている間の状態を知らせる', order.includes('IN_QUEUE') && order.includes('IN_PROGRESS'));

calls = fakeRunPod({ status: [{ status: 'FAILED', error: '{"error":{"message":"request (34479 tokens) exceeds the available context size"}}' }] });
res = await runpodChatFetch('k', 'ep', { poll: FAST })('u', { body: JSON.stringify({ stream: false }) });
const failBody = await res.text();
check('  失敗は エラーの状態コードと理由', res.status === 500 && errorText(failBody).startsWith('request (34479 tokens)'), errorText(failBody));

/* ------------------------ fetch drop-in: streaming ----------------------- */
const frame = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
calls = fakeRunPod({
  stream: [
    { status: 'IN_QUEUE', stream: [] },
    { status: 'IN_PROGRESS', stream: [{ output: frame({ choices: [], hyperai_worker: { source: 'cache', readyAt: 1 } }) }, { output: frame({ choices: [{ delta: { content: 'こん' } }] }) }] },
    { status: 'IN_PROGRESS', stream: [] },
    { status: 'COMPLETED', stream: [{ output: frame({ choices: [{ delta: { content: 'にちは' } }] }) }] },
  ],
});
res = await runpodChatFetch('k', 'ep', { poll: FAST })('u', { body: JSON.stringify({ stream: true }) });
let text = '';
const workers = [];
await consumeChatStream(res, { onText: (t) => (text += t), onWorker: (w) => workers.push(w.source) });
check('ストリーム: /stream の出力を順につなぐ', text === 'こんにちは', text);
check('  起動情報のフレームも通る', workers.join() === 'cache');
check('  /status ではなく /stream を読む', calls.filter((c) => c.startsWith('/stream/')).length === 4, calls.join(' '));

calls = fakeRunPod({
  stream: [{ status: 'FAILED', stream: [] }],
  status: [{ status: 'FAILED', error: 'llama-server 500: CUDA error' }],
});
res = await runpodChatFetch('k', 'ep', { poll: FAST })('u', { body: JSON.stringify({ stream: true }) });
check('  何も書かずに失敗したら、エラーの状態コードで返す（再試行の判定が効く）', res.status === 500 && (await res.text()).includes('CUDA error'));

calls = fakeRunPod({
  stream: [
    { status: 'IN_PROGRESS', stream: [{ output: frame({ choices: [{ delta: { content: '途中' } }] }) }] },
    { status: 'FAILED', stream: [] },
  ],
  status: [{ status: 'FAILED', error: 'worker died' }],
});
res = await runpodChatFetch('k', 'ep', { poll: FAST })('u', { body: JSON.stringify({ stream: true }) });
text = '';
let streamErr = '';
await consumeChatStream(res, { onText: (t) => (text += t), onError: (m) => (streamErr = m) });
check('  途中で失敗したら、書いた分と理由を返す', text === '途中' && streamErr.includes('worker died'), streamErr);

check('ハンドラのエラー出力も SSE のエラーにする', itemToSse({ error: 'boom' }).includes('"error"') && itemToSse('data: x\n\n') === 'data: x\n\n');

// Two hours: the job is cancelled, not left running on the GPU.
calls = fakeRunPod({ stream: [{ status: 'IN_QUEUE', stream: [] }] });
res = await runpodChatFetch('k', 'ep', { poll: FAST, waitMs: 20 })('u', { body: JSON.stringify({ stream: true }) });
check('2 時間を過ぎたらジョブを止めて失敗にする', res.status === 504 && calls.some((c) => c.startsWith('/cancel/job-9')), calls.slice(-2).join(' '));

// Out of poll budget: stop following, but leave the job to finish.
calls = fakeRunPod({ stream: [{ status: 'IN_QUEUE', stream: [] }] });
let detached = false;
res = await runpodChatFetch('k', 'ep', { poll: { minMs: 1, maxMs: 1, budget: 3 }, onDetach: () => (detached = true) })('u', {
  body: JSON.stringify({ stream: true }),
});
check('追跡の上限: 切り離すがジョブは止めない', detached && !calls.some((c) => c.startsWith('/cancel/')), calls.join(' '));

// The caller gives up (the browser went away during a decision): the wait
// ends at once and the job is cancelled, not left holding the queue.
calls = fakeRunPod({ status: [{ status: 'IN_QUEUE' }] });
const stop = new AbortController();
setTimeout(() => stop.abort(), 30);
const abortStarted = Date.now();
res = await runpodChatFetch('k', 'ep', { poll: { minMs: 10000, maxMs: 10000, budget: 50 }, signal: stop.signal })('u', {
  body: JSON.stringify({ stream: false }),
});
check('打ち切り: 待たずに返し、ジョブを取り消す', res.status === 499 && Date.now() - abortStarted < 2000 && calls.some((c) => c.startsWith('/cancel/job-9')),
  (Date.now() - abortStarted) + 'ms ' + calls.join(' '));

check('待ち行列の表示', queueNotice({ status: 'IN_QUEUE', waitedMs: 754000 }).includes('待ち行列') && queueNotice({ status: 'IN_QUEUE', waitedMs: 754000 }).includes('12分34秒'));
check('  起動中の表示', queueNotice({ status: 'IN_PROGRESS', waitedMs: 30000 }).includes('起動・読み込み中'));

/* -------------------------------- webhook -------------------------------- */
const env0 = { MASTER_KEY: 'master-secret', APP_ORIGIN: 'https://chat.example.com/' };
const url = await webhookUrl(env0, 'msg_1');
const sig = new URL(url).searchParams.get('sig');
check('webhook: アプリの URL とメッセージ ID', url.startsWith('https://chat.example.com/api/runpod/webhook/msg_1?sig='), url);
check('  署名が通る', await verifyWebhook(env0, 'msg_1', sig));
check('  別のメッセージには通らない', !(await verifyWebhook(env0, 'msg_2', sig)));
check('  署名なし・鍵なしは通らない', !(await verifyWebhook(env0, 'msg_1', '')) && !(await verifyWebhook({}, 'msg_1', sig)));
check('  設定が無ければ webhook を付けない', (await webhookUrl({}, 'm')) === null);

/* ---------------------------- settling a reply --------------------------- */
const fakeDb = (rows = {}) => {
  const updates = [];
  return {
    updates,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            run: async () => updates.push({ sql, args }),
            first: async () => rows[args[0]] || null,
            all: async () => ({ results: Object.values(rows) }),
          };
        },
      };
    },
  };
};
const waitingRow = (extra = {}) => ({
  id: 'msg_1',
  content: '途中まで',
  reasoning: null,
  prompt_tokens: null,
  error: null,
  meta: JSON.stringify({ partial: true, runpodJob: { id: 'job-9', endpointId: 'ep', submittedAt: 1, status: 'IN_QUEUE' } }),
  ...extra,
});
const lastUpdate = (db) => {
  const u = db.updates.at(-1);
  const cols = u.sql.replace(/^UPDATE messages SET /, '').replace(/ WHERE id = \?$/, '').split(', ').map((s) => s.split(' = ')[0]);
  return Object.fromEntries(cols.map((c, i) => [c, u.args[i]]));
};
const env = (db) => ({ DB: db, RUNPOD_API_KEY: 'k', MASTER_KEY: null });

globalThis.fetch = async () =>
  json({ id: 'job-9', status: 'COMPLETED', output: [frame({ choices: [{ delta: { content: '完成した長い答え' } }] }), frame({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] })] });
let db = fakeDb();
let out = await settleMessage(env(db), waitingRow());
let up = lastUpdate(db);
check('回収: 終わったジョブの本文を入れる', out.state === 'settled' && up.content === '完成した長い答え' && up.prompt_tokens === 10, JSON.stringify(up).slice(0, 160));
check('  途中ではなくなる', JSON.parse(up.meta).partial === false && JSON.parse(up.meta).runpodJob.status === 'COMPLETED');

db = fakeDb();
await settleMessage(env(db), waitingRow({ content: 'すでに書かれているずっと長い完成済みの本文です。' }));
check('  長い本文を短い本文で上書きしない', !('content' in lastUpdate(db)));

globalThis.fetch = async () => json({ id: 'job-9', status: 'IN_PROGRESS' });
db = fakeDb();
out = await settleMessage(env(db), waitingRow());
check('  まだなら状態だけ記録する', out.state === 'pending' && JSON.parse(lastUpdate(db).meta).runpodJob.status === 'IN_PROGRESS' && JSON.parse(lastUpdate(db).meta).partial === true);

globalThis.fetch = async () => json({ id: 'job-9', status: 'FAILED', error: 'llama-server 500: out of memory' });
db = fakeDb();
await settleMessage(env(db), waitingRow());
check('  失敗は理由をエラーに残す', /FAILED.*out of memory/.test(lastUpdate(db).error), lastUpdate(db).error);

globalThis.fetch = async () => json({ error: 'not found' }, 404);
db = fakeDb();
out = await settleMessage(env(db), waitingRow({ content: '' }));
check('  RunPod から消えていたら、そう書く', out.state === 'lost' && /保持期間/.test(lastUpdate(db).error));

db = fakeDb();
out = await settleMessage(env(db), { id: 'm', meta: JSON.stringify({ partial: false }) });
check('  ジョブの無い返答には触らない', out.state === 'skipped' && db.updates.length === 0);

// The job-id path reads the message's own job and nothing else: no job list,
// so a diagnosis probe or another turn's reply can never be picked up.
const seenUrls = [];
globalThis.fetch = async (u) => {
  seenUrls.push(String(u));
  return json({ id: 'job-9', status: 'COMPLETED', output: [frame({ choices: [{ delta: { content: '答え' } }] })] });
};
db = fakeDb();
await settleMessage(env(db), waitingRow());
check('ID で追う経路は自分のジョブしか読まない',
  seenUrls.length === 1 && seenUrls[0] === 'https://api.runpod.ai/v2/ep/status/job-9' && !seenUrls.some((x) => x.includes('/requests')), seenUrls.join(' '));

db = fakeDb();
await pendingReplies(env(db), { roomId: 'r1', limit: 3 });

/* ------------------------------- the route ------------------------------- */
const routeEnv = { ...env0, DB: fakeDb({ msg_1: waitingRow() }), RUNPOD_API_KEY: 'k' };
globalThis.fetch = async () => json({ id: 'job-9', status: 'COMPLETED', output: [frame({ choices: [{ delta: { content: '答え' } }] })] });
let r = await hook.request('/webhook/msg_1?sig=wrong', { method: 'POST', body: '{}' }, routeEnv);
check('webhook の経路: 署名が違えば 403', r.status === 403);
r = await hook.request('/webhook/msg_1?sig=' + encodeURIComponent(sig), { method: 'POST', body: 'anything' }, routeEnv);
const rj = await r.json();
check('  正しければ RunPod からジョブを読んで回収する（本文は信用しない）', r.status === 200 && rj.state === 'settled' && routeEnv.DB.updates.length === 1, JSON.stringify(rj));

/* ------------------------------ token guard ------------------------------ */
const bt = { baseUrl: 'https://api.runpod.ai/v2/ep/openai/v1', model: 'breakthrough' };
const mt = (maxTokens) => buildRequest({ provider: 'runpod', model: 'breakthrough', messages: [], options: { maxTokens }, apiKey: 'k', breakthrough: bt }).body.max_tokens;
check('生成の上限: 既定 16K', mt(0) === 16384);
check('  設定で大きくしても 32K まで', mt(200000) === BREAKTHROUGH_MAX_TOKENS && BREAKTHROUGH_MAX_TOKENS === 32768);

globalThis.fetch = realFetch;
const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
