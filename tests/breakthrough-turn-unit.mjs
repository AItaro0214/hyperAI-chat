/* One breakthrough turn through the real chat route, with D1 and RunPod faked.
 *
 * Production, created_at 1792828078: a search decision (max_tokens 700) whose
 * model answered instead of calling a tool, cut off at 700 tokens, ended up
 * as the saved answer — no reply job, no runpodJob, no startup. Whatever the
 * decisions do, the real reply must be sent (as a /run job, recorded) and be
 * what is saved; the decision's text must never reach the screen or the row. */

import { Hono } from 'hono';
import chat from '../src/routes/chat.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};
const realFetch = globalThis.fetch;

const PROBE_TEXT = '【判断の途中の答え】これはツールを呼ばずに書かれ、700トークンで切れた文章';
const REPLY_TEXT = '本番の答えです。';
const READY_AT = Math.floor(Date.now() / 1000) - 3600; // a worker already up

const SETTINGS = {
  breakthrough: true,
  runpodEndpointId: 'ep',
  runpodModel: 'breakthrough',
  runpodMaxLen: 32768,
  searchBackend: 'ollama',
  searchRounds: 2,
  webSearchMaxResults: 3,
};

function fakeDb() {
  const rows = {};
  const db = {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM app_settings')) return args[0] === 'app' ? { value: JSON.stringify(SETTINGS) } : null;
              if (sql.includes('FROM app_secrets')) return null; // keys come from env
              if (sql.includes('FROM rooms')) return { id: 'room1', user_id: 'u1', title: 'テスト', provider: 'runpod', model: 'breakthrough' };
              return null;
            },
            async all() {
              if (sql.includes('FROM messages')) return { results: [{ id: 'm0', role: 'user', content: '質問です', attachments: '[]' }] };
              return { results: [] };
            },
            async run() {
              // The assistant row: the placeholder, then each save.
              if (sql.startsWith('INSERT INTO messages') && args[3] === 'assistant') rows[args[0]] = { content: '', meta: args[9] };
              if (sql.startsWith('UPDATE messages SET content')) {
                const id = args[args.length - 1];
                rows[id] = { content: args[0], meta: args[7], error: args[8] };
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}

/* RunPod, as the scenario has it. Decisions are the jobs whose input offers
 * tools; the reply is the one that does not. */
function fakeRunPod(decide, { decisionStaysQueued = false } = {}) {
  const log = { submits: [], cancels: [], decisionIds: [], replyId: null };
  let decisions = 0;
  let streamCalls = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://api.runpod.ai/v2/ep/run') {
      const input = JSON.parse(options.body).input.openai_input;
      const isDecision = Array.isArray(input.tools);
      const id = isDecision ? 'decision-' + ++decisions : 'reply-1';
      log.submits.push({ id, isDecision, max_tokens: input.max_tokens, stream: input.stream, tools: isDecision });
      if (isDecision) log.decisionIds.push(id);
      else log.replyId = id;
      return json({ id, status: 'IN_QUEUE' });
    }
    if (u.includes('/cancel/')) {
      log.cancels.push(u.split('/cancel/')[1]);
      return json({ status: 'CANCELLED' });
    }
    if (u.includes('/status/decision-')) {
      if (decisionStaysQueued) return json({ status: 'IN_QUEUE' });
      const n = Number(u.split('decision-')[1]);
      return json({ status: 'COMPLETED', output: [{ ...decide(n), hyperai_worker: { source: 'cache', startupSeconds: 40, readyAt: READY_AT } }] });
    }
    if (u.includes('/stream/reply-1')) {
      streamCalls++;
      return json(
        streamCalls === 1
          ? { status: 'IN_PROGRESS', stream: [{ output: 'data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY_TEXT } }] }) + '\n\n' }] }
          : { status: 'COMPLETED', stream: [{ output: 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n' }] }
      );
    }
    if (u.startsWith('https://ollama.com/api/web_search')) {
      return json({ results: [{ title: '結果', url: 'https://example.com', content: '検索結果の本文' }] });
    }
    return new Response('not found', { status: 404 });
  };
  return log;
}

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('session', { id: 's', user_id: 'u1' });
  c.set('userId', 'u1');
  await next();
});
app.route('/api', chat);

async function turn(decide, { disconnectAfterMs = null, decisionStaysQueued = false } = {}) {
  const db = fakeDb();
  const log = fakeRunPod(decide, { decisionStaysQueued });
  const waits = [];
  const env = {
    DB: db,
    KV: { get: async () => null, put: async () => {}, getWithMetadata: async () => ({ value: null }) },
    RUNPOD_API_KEY: 'rp-key',
    OLLAMA_API_KEY: 'ol-key',
    MASTER_KEY: 'master',
    APP_ORIGIN: 'https://chat.example.com',
  };
  const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
  const res = await app.request(
    '/api/chat',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: 'room1', content: '質問です', webSearchEngine: 'server' }) },
    env,
    ctx
  );
  let sse = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  if (disconnectAfterMs === null) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += dec.decode(value, { stream: true });
    }
  } else {
    // Read for a while, then go away as a closed tab does.
    const until = Date.now() + disconnectAfterMs;
    while (Date.now() < until) {
      const r = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok(null), until - Date.now()))]);
      if (!r || r.done) break;
      sse += dec.decode(r.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
  }
  await Promise.all(waits);
  const saved = Object.values(db.rows)[0];
  return { log, sse, saved, meta: JSON.parse(saved?.meta || '{}') };
}

const answerWithoutTools = (finish) => () => ({
  choices: [{ message: { content: PROBE_TEXT }, finish_reason: finish }],
  usage: { completion_tokens: finish === 'length' ? 700 : 40 },
});

for (const [label, decide] of [
  ['判断がツールを呼ばず 700 トークンで切れた（本番の事故）', answerWithoutTools('length')],
  ['判断がツールを呼ばず短く完結した', answerWithoutTools('stop')],
  [
    '判断がツールを呼んだ',
    (n) =>
      n === 1
        ? { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"q"}' } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { content: PROBE_TEXT }, finish_reason: 'stop' }] },
  ],
]) {
  const t = await turn(decide);
  const reply = t.log.submits.find((s) => !s.isDecision);
  check(label + ': 本番の返答を /run で送る', !!reply && reply.stream === true && reply.max_tokens === 16384 && !reply.tools, JSON.stringify(t.log.submits));
  check('  保存されるのは本番の答え', t.saved?.content === REPLY_TEXT, JSON.stringify(t.saved?.content));
  check('  判断の文章は保存も表示もしない', !String(t.saved?.content).includes('判断の途中') && !t.sse.includes('判断の途中'));
  check('  runpodJob を記録する', t.meta.runpodJob?.id === 'reply-1' && t.meta.runpodJob.status === 'COMPLETED', JSON.stringify(t.meta.runpodJob));
  check('  起動情報を記録する', !!t.meta.startup?.label, JSON.stringify(t.meta.startup));
  check('  判断のジョブを記録する（回収で取り違えないため）', t.log.decisionIds.every((id) => t.meta.decisionJobs?.includes(id)), JSON.stringify(t.meta.decisionJobs));
  check('  完了として保存（途中のまま残さない）', t.meta.partial === false && !t.meta.phase);
}

/* The browser goes away while a decision waits in the queue: the decision is
 * cancelled and the reply job is still sent and recorded, within the 30
 * seconds a Worker has after a disconnect — so the webhook or the sweep can
 * bring the answer in. */
{
  const started = Date.now();
  const t = await turn(() => ({}), { disconnectAfterMs: 300, decisionStaysQueued: true });
  const took = Math.round((Date.now() - started) / 1000);
  check('接続が切れたら: 判断のジョブを取り消す', t.log.cancels.includes('decision-1'), JSON.stringify(t.log.cancels));
  check('  それでも本番の返答を送り、runpodJob を残す', t.log.replyId === 'reply-1' && t.meta.runpodJob?.id === 'reply-1');
  check('  Worker に残る 30 秒の内に送る', took < 25, took + '秒');
  check('  理由を残す', (t.meta.notices || []).some((n) => n.includes('接続が切れた')), JSON.stringify(t.meta.notices));
}

globalThis.fetch = realFetch;
const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
