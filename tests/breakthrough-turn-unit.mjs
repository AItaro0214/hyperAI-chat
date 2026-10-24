/* One breakthrough turn — the chat route, the turn as a Workflow, the row it
 * writes and the SSE read back from it — with D1, KV and RunPod faked.
 *
 * Production, created_at 1792828078: a search decision (max_tokens 700) whose
 * model answered instead of calling a tool, cut off at 700 tokens, ended up
 * as the saved answer. Whatever the decisions do, the real reply must be sent
 * (as a /run job, recorded) and be what is saved.
 *
 * And since the turn now runs as a Workflow: it must finish with nobody
 * watching, and a run that is evicted and replayed must not send any
 * decision, search or reply twice. */

import { Hono } from 'hono';
import chat, { relayTurn } from '../src/routes/chat.js';
import { runTurn, loadTurn } from '../src/lib/breakthrough-turn.js';
import { shapeMessage } from '../src/routes/rooms.js';
import { readFileSync } from 'node:fs';

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

/* The assistant row as D1 holds it, and every meta written to it. */
function fakeDb() {
  const rows = {};
  const metas = [];
  const db = {
    rows,
    metas,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM app_settings')) return args[0] === 'app' ? { value: JSON.stringify(SETTINGS) } : null;
              if (sql.includes('FROM app_secrets')) return null; // keys come from env
              if (sql.includes('FROM rooms')) return { id: 'room1', user_id: 'u1', title: 'テスト', provider: 'runpod', model: 'breakthrough' };
              if (sql.includes('FROM messages WHERE id = ?')) return rows[args[0]] ? { ...rows[args[0]] } : null;
              return null;
            },
            async all() {
              if (sql.includes('FROM messages')) return { results: [{ id: 'm0', role: 'user', content: '質問です', attachments: '[]' }] };
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO messages') && args[3] === 'assistant') {
                rows[args[0]] = { content: '', reasoning: null, meta: args[9], error: null, prompt_tokens: null, completion_tokens: null };
                metas.push(JSON.parse(args[9]));
              }
              if (sql.startsWith('UPDATE messages SET content = ?, reasoning = ?')) {
                const [content, reasoning, pt, ct, meta, error, id] = args;
                rows[id] = { content, reasoning, prompt_tokens: pt, completion_tokens: ct, meta, error };
                metas.push(JSON.parse(meta));
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

function fakeKv() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    getWithMetadata: async (k) => ({ value: m.get(k) ?? null }),
  };
}

/* RunPod, as the scenario has it. Decisions are the jobs whose input offers
 * tools; the reply is the one that does not. */
function fakeRunPod(decide, { decisionQueuedPolls = 0 } = {}) {
  const log = { submits: [], cancels: [], decisionIds: [], replyIds: [], searches: 0 };
  let decisions = 0;
  let replies = 0;
  const polls = {};
  const streamCalls = {};
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const frame = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://api.runpod.ai/v2/ep/run') {
      const input = JSON.parse(options.body).input.openai_input;
      const isDecision = Array.isArray(input.tools);
      const id = isDecision ? 'decision-' + ++decisions : 'reply-' + ++replies;
      log.submits.push({ id, isDecision, max_tokens: input.max_tokens, stream: input.stream, tools: isDecision, webhook: JSON.parse(options.body).webhook });
      (isDecision ? log.decisionIds : log.replyIds).push(id);
      return json({ id, status: 'IN_QUEUE' });
    }
    if (u.includes('/cancel/')) {
      log.cancels.push(u.split('/cancel/')[1]);
      return json({ status: 'CANCELLED' });
    }
    if (u.includes('/status/decision-')) {
      const id = u.split('/status/')[1];
      polls[id] = (polls[id] || 0) + 1;
      if (polls[id] <= decisionQueuedPolls) return json({ status: 'IN_QUEUE' });
      const n = Number(id.split('decision-')[1]);
      return json({ status: 'COMPLETED', output: [{ ...decide(n), hyperai_worker: { source: 'cache', startupSeconds: 40, readyAt: READY_AT } }] });
    }
    if (u.includes('/stream/reply-')) {
      const id = u.split('/stream/')[1];
      streamCalls[id] = (streamCalls[id] || 0) + 1;
      return json(
        streamCalls[id] === 1
          ? { status: 'IN_PROGRESS', stream: [{ output: frame({ choices: [{ delta: { content: REPLY_TEXT } }] }) }] }
          : { status: 'COMPLETED', stream: [{ output: frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }] }
      );
    }
    if (u.includes('/status/reply-')) {
      return json({
        status: 'COMPLETED',
        output: [frame({ choices: [{ delta: { content: REPLY_TEXT } }] }), frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })],
      });
    }
    if (u.startsWith('https://ollama.com/api/web_search')) {
      log.searches++;
      return json({ results: [{ title: '結果', url: 'https://example.com', content: '検索結果の本文' }] });
    }
    return new Response('not found', { status: 404 });
  };
  return log;
}

/* Workflow steps as Workflows runs them: a finished step's result is stored
 * (serialised) and handed back on a replay instead of running it again.
 * `evictAt` names a step at which the first run is evicted: it never returns. */
function workflowSteps(store, { evictAt = null } = {}) {
  const ran = [];
  let evicted = false;
  return {
    ran,
    step: {
      async do(name, configOrFn, maybeFn) {
        const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn;
        if (store.has(name)) return JSON.parse(store.get(name));
        if (evictAt === name && !evicted) {
          evicted = true;
          return new Promise(() => {}); // the instance is gone
        }
        ran.push(name);
        const out = await fn();
        store.set(name, JSON.stringify(out ?? null));
        return out;
      },
    },
  };
}

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('session', { id: 's', user_id: 'u1' });
  c.set('userId', 'u1');
  await next();
});
app.route('/api', chat);

function makeEnv({ workflow = true } = {}) {
  const env = {
    DB: fakeDb(),
    KV: fakeKv(),
    RUNPOD_API_KEY: 'rp-key',
    OLLAMA_API_KEY: 'ol-key',
    MASTER_KEY: 'master',
    APP_ORIGIN: 'https://chat.example.com',
  };
  const wf = { created: [], runs: [], stores: {} };
  if (workflow) {
    env.BREAKTHROUGH = {
      // Starts the instance, as Workflows does, independently of the request.
      create: async ({ id, params }) => {
        wf.created.push({ id, params });
        const store = (wf.stores[id] = new Map());
        wf.runs.push(runTurn({ env, messageId: params.messageId, step: workflowSteps(store).step }));
        return { id };
      },
    };
  }
  return { env, wf };
}

async function turn(decide, { disconnectAfterMs = null, decisionQueuedPolls = 0, workflow = true } = {}) {
  const { env, wf } = makeEnv({ workflow });
  const log = fakeRunPod(decide, { decisionQueuedPolls });
  const waits = [];
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
  const turnResults = await Promise.all(wf.runs);
  await Promise.all(waits);
  const [id, saved] = Object.entries(env.DB.rows)[0] || [];
  return { env, wf, log, sse, id, saved, meta: JSON.parse(saved?.meta || '{}'), turnResults, waits };
}

const answerWithoutTools = (finish) => () => ({
  choices: [{ message: { content: PROBE_TEXT }, finish_reason: finish }],
  usage: { completion_tokens: finish === 'length' ? 700 : 40 },
});
const searchThenAnswer = (n) =>
  n === 1
    ? { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"今日の天気"}' } }] }, finish_reason: 'tool_calls' }] }
    : { choices: [{ message: { content: PROBE_TEXT }, finish_reason: 'stop' }] };

/* ------------------------- the turn, as a Workflow ------------------------- */
for (const [label, decide] of [
  ['判断がツールを呼ばず 700 トークンで切れた（本番の事故）', answerWithoutTools('length')],
  ['判断がツールを呼ばず短く完結した', answerWithoutTools('stop')],
  ['判断がツールを呼んだ', searchThenAnswer],
]) {
  const t = await turn(decide);
  const reply = t.log.submits.find((s) => !s.isDecision);
  check(label + ': Workflow で動かす（メッセージ ID をインスタンス ID に）', t.wf.created.length === 1 && t.wf.created[0].id === t.id && t.meta.workflow === t.id);
  check('  本番の返答を /run で送る（webhook 付き）', !!reply && reply.stream === true && reply.max_tokens === 16384 && !reply.tools && /webhook/.test(reply.webhook || ''),
    JSON.stringify(t.log.submits));
  check('  保存されるのは本番の答え', t.saved?.content === REPLY_TEXT, JSON.stringify(t.saved?.content));
  check('  判断の文章は保存も表示もしない', !String(t.saved?.content).includes('判断の途中') && !t.sse.includes('判断の途中'));
  check('  runpodJob を記録する', t.meta.runpodJob?.id === 'reply-1' && t.meta.runpodJob.status === 'COMPLETED', JSON.stringify(t.meta.runpodJob));
  check('  起動情報を記録する', !!t.meta.startup?.label, JSON.stringify(t.meta.startup));
  check('  判断のジョブを記録する（回収で取り違えないため）', t.log.decisionIds.every((id) => t.meta.decisionJobs?.includes(id)), JSON.stringify(t.meta.decisionJobs));
  check('  完了として保存（途中のまま・進み具合を残さない）', t.meta.partial === false && !t.meta.progress && !t.saved.error);
  check('  使用量を残す', t.saved.prompt_tokens === 10 && t.saved.completion_tokens === 5);
  check('  画面へは行から読んで送る（本文・起動・完了）',
    t.sse.includes('event: delta') && t.sse.includes(REPLY_TEXT) && t.sse.includes('event: worker') && t.sse.includes('event: done'));
  check('  入力の控えは終わったら消す', t.env.KV.m.size === 0, [...t.env.KV.m.keys()].join(','));
}

/* ----------------------- what the row says as it goes ----------------------- */
{
  const t = await turn(searchThenAnswer, { decisionQueuedPolls: 1 });
  const phases = [...new Set(t.env.DB.metas.map((m) => m.progress?.phase).filter(Boolean))];
  check('進み具合を D1 に書く（判断中→検索中→返答待ち）',
    ['deciding', 'searching', 'waiting'].every((p) => phases.includes(p)), phases.join(' → '));
  const searching = t.env.DB.metas.find((m) => m.progress?.phase === 'searching' && /今日の天気/.test(m.progress.text));
  check('  何を検索しているかも書く', !!searching, JSON.stringify(searching?.progress));
  check('  途中の行は partial のまま', t.env.DB.metas.filter((m) => m.progress).every((m) => m.partial === true));
  check('  画面へ: 段階を status で', /event: status\ndata: \{"phase":"searching"\}/.test(t.sse) && /"phase":"writing"/.test(t.sse));
  // The relay reads every second; what it shows is whatever the row says then.
  check('  画面へ: 何をしているかを meta で', /event: meta\ndata: \{"notices":\["検索が必要か判断しています（\d\/2）"\]\}/.test(t.sse));
  check('  検索の記録を残す', t.meta.searches?.length === 1 && t.meta.searches[0].query === '今日の天気', JSON.stringify(t.meta.searches));
}

/* ------------------- the browser goes away: the turn goes on ------------------- */
{
  const t = await turn(searchThenAnswer, { disconnectAfterMs: 300, decisionQueuedPolls: 2 });
  check('接続が切れても: 判断のジョブを取り消さない', t.log.cancels.length === 0, JSON.stringify(t.log.cancels));
  check('  画面には途中までしか届いていない', !t.sse.includes('event: done'));
  check('  検索を続ける', t.log.searches === 1);
  check('  本番の返答を送り、保存まで終える', t.log.replyIds.length === 1 && t.saved?.content === REPLY_TEXT && t.meta.partial === false,
    JSON.stringify({ replies: t.log.replyIds, content: t.saved?.content }));
  check('  打ち切りの注記は出ない', !(t.meta.notices || []).some((n) => n.includes('接続が切れた')), JSON.stringify(t.meta.notices));
}

/* ------------------ evicted and replayed: nothing is sent twice ------------------ */
for (const evictAt of ['decision 2: result', 'tool 1: web_search', 'reply 1: follow', 'save']) {
  const { env } = makeEnv({ workflow: false });
  const log = fakeRunPod(searchThenAnswer);
  // The turn as the route stores it, then run without the route.
  const messageId = 'msg_replay';
  env.DB.rows[messageId] = { content: '', meta: JSON.stringify({ partial: true }) };
  await env.KV.put(
    'bt-turn:' + messageId,
    JSON.stringify({
      messageId, roomId: 'room1', userId: 'u1', startedAt: Math.floor(Date.now() / 1000), endpointId: 'ep', model: 'breakthrough',
      body: { model: 'breakthrough', messages: [{ role: 'user', content: '質問です' }], stream: true, max_tokens: 16384 },
      notices: [], webSearch: true, searchMode: 'ollama', searchRounds: 2, webSearchMaxResults: 3, contextTokens: 32768, metaBase: {}, workflowId: messageId,
    })
  );
  const store = new Map();
  const first = workflowSteps(store, { evictAt });
  // The first run stops dead at evictAt; its promise is simply abandoned.
  runTurn({ env, messageId, step: first.step });
  await new Promise((r) => setTimeout(r, 1500));
  const second = workflowSteps(store);
  const out = await runTurn({ env, messageId, step: second.step });
  const meta = JSON.parse(env.DB.rows[messageId].meta);
  check('追い出されて再実行（' + evictAt + ' で）: 判断は 2 回だけ', log.decisionIds.length === 2, log.decisionIds.join(','));
  check('  検索は 1 回だけ', log.searches === 1, String(log.searches));
  check('  本番の返答のジョブは 1 つだけ', log.replyIds.length === 1, log.replyIds.join(','));
  check('  終わった段階はやり直さない', !second.ran.some((n) => first.ran.includes(n)), second.ran.join(', '));
  check('  最後まで保存する', out.state === 'done' && env.DB.rows[messageId].content === REPLY_TEXT && meta.partial === false && meta.runpodJob?.id === 'reply-1');
}

/* ---------------- no Workflow binding: the same turn, in waitUntil ---------------- */
{
  const t = await turn(answerWithoutTools('stop'), { workflow: false });
  check('Workflow が無ければこのリクエストの中で動かす', t.wf.created.length === 0 && t.saved?.content === REPLY_TEXT && t.meta.partial === false && !t.meta.workflow);
  check('  そのときも行から画面へ送る', t.sse.includes(REPLY_TEXT) && t.sse.includes('event: done'));
}

/* ------------------------ the relay on its own (from D1) ------------------------ */
{
  const row = { content: '', reasoning: null, meta: JSON.stringify({ partial: true, progress: { phase: 'waiting', text: 'RunPod に回答を依頼しました' } }), error: null };
  const steps = [
    () => (row.meta = JSON.stringify({ partial: true, progress: { phase: 'writing', text: '回答を書いています' }, startup: { label: 'キャッシュから起動（40秒）' } })),
    () => (row.content = 'あ'),
    () => (row.content = 'あい'),
    () => Object.assign(row, { meta: JSON.stringify({ partial: false, notices: ['ウェブを 1 回調べました'] }), prompt_tokens: 3, completion_tokens: 2 }),
  ];
  let reads = 0;
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => (steps[reads - 1]?.(), reads++, { ...row }) }) }) },
  };
  const chunks = [];
  const writer = { write: async (b) => chunks.push(new TextDecoder().decode(b)), close: async () => {} };
  await relayTurn(env, writer, { messageId: 'm', roomId: 'r', provider: 'runpod', model: 'breakthrough', notices: [], metaBase: {}, roomTitle: 't', everyMs: 1 });
  const sse = chunks.join('');
  const deltas = [...sse.matchAll(/event: delta\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).text);
  check('中継: 増えた分だけ delta で送る', deltas.join('|') === 'あ|い', deltas.join('|'));
  check('  起動情報を worker で送る', /event: worker\ndata: \{"label":"キャッシュから起動（40秒）"\}/.test(sse));
  check('  終わったら usage と done', /event: usage\ndata: \{"usage":\{"prompt_tokens":3,"completion_tokens":2\}/.test(sse) && sse.trim().endsWith('"notices":["ウェブを 1 回調べました"]}'));

  // Past the read cap: stops relaying, and says the turn is still going.
  let n = 0;
  const env2 = { DB: { prepare: () => ({ bind: () => ({ first: async () => (n++, { content: '', meta: '{"partial":true}' }) }) }) } };
  const chunks2 = [];
  await relayTurn(env2, { write: async (b) => chunks2.push(new TextDecoder().decode(b)), close: async () => {} },
    { messageId: 'm', roomId: 'r', notices: [], metaBase: {}, everyMs: 1, maxReads: 5 });
  check('  読む回数の上限で止め、続きは画面に任せる', n === 5 && /"pending":true/.test(chunks2.join('')), String(n));
}

/* ----------------------- a page that comes back reads D1 ----------------------- */
{
  const old = Math.floor(Date.now() / 1000) - 3600; // an hour into a long turn
  const shaped = shapeMessage({ id: 'm', role: 'assistant', content: '', meta: JSON.stringify({ partial: true, progress: { phase: 'waiting', text: '待ち行列' } }), created_at: old });
  check('開き直し: 走っているターンの行は 15 分を過ぎても途中扱い', shaped.meta.partial === true && !shaped.meta.abandoned);
  const stale = shapeMessage({ id: 'm', role: 'assistant', content: '', meta: JSON.stringify({ partial: true, progress: {} }), created_at: old - 3 * 3600 });
  check('  2 時間を大きく過ぎたら止まったものとして扱う', stale.meta.partial === false && stale.meta.abandoned === true);
  const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  check('  画面は開いたときに走っているターンを追う', /const running = \[\.\.\.res\.messages\]\.reverse\(\)\.find\(runningTurn\)/.test(appSrc) && /followUnfinished\(id, running\.id/.test(appSrc));
  check('  途中の行に進み具合を出す', /msg\.meta\.progress\.text/.test(appSrc));
}

/* ------------------------- the old disconnect logic is gone ------------------------- */
{
  const src = ['../src/routes/chat.js', '../src/lib/chat-tools.js', '../src/lib/runpod-jobs.js']
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))
    .join('\n');
  check('「切れたら検索を打ち切る」仕組みは外した', !/接続が切れた/.test(src) && !/runpodChatFetch/.test(src) && !/heartbeat/.test(src));
  check('入力の控えは KV から読む（ステップの結果の上限 1MiB を避ける）', (await loadTurn({ KV: fakeKv() }, 'none')) === null);
}

globalThis.fetch = realFetch;
const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
