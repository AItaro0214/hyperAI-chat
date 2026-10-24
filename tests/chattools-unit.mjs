import {
  CHAT_TOOLS,
  chatTools,
  thinkingFor,
  resolveTools,
  approxTokens,
  shrinkToolResults,
  promptBudgetFor,
  errorText,
  MAX_ROUNDS,
  ROUND_CEILING,
} from '../src/lib/chat-tools.js';
import { ENGINE_STRENGTHS } from '../src/lib/search.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

check('読み取り専用ツールだけ', CHAT_TOOLS.map((t) => t.function.name).join(',') === 'web_search,web_fetch',
  CHAT_TOOLS.map((t) => t.function.name).join(','));
check('  書き込み系が混ざっていない', !CHAT_TOOLS.some((t) => /write|run|delete/.test(t.function.name)));
check('  雑談には使うなと書いてある', CHAT_TOOLS[0].function.description.includes('雑談'));

check('思考: 未設定なら触らない', thinkingFor('') === null && thinkingFor(undefined) === null);
check('  off は切る', thinkingFor('off') === false && thinkingFor('none') === false);
check('  minimal も切る', thinkingFor('minimal') === false);
check('  high は入れる', thinkingFor('high') === true && thinkingFor('low') === true);

const realFetch = globalThis.fetch;
const reply = (msg) => ({ ok: true, status: 200, async json() { return { choices: [{ message: msg }] }; } });

// The model asks for nothing: no tools run, nothing is spent.
let calls = 0;
globalThis.fetch = async () => { calls++; return reply({ content: 'こんにちは' }); };
let out = await resolveTools({ url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'hi' }] }, execute: async () => 'x' });
check('検索不要なら何も呼ばない', out.calls.length === 0 && out.rounds === 0, 'rounds=' + out.rounds);
check('  メッセージを増やさない', out.messages.length === 1);

// The model asks once, then answers.
let turn = 0;
globalThis.fetch = async () => {
  turn++;
  return turn === 1
    ? reply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"query":"天気"}' } }] })
    : reply({ content: '晴れです' });
};
const executed = [];
out = await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: '天気' }] },
  execute: async (n, a) => { executed.push(n + ':' + a.query); return '結果'; },
});
check('求められたら実行する', executed.join() === 'web_search:天気', executed.join());
check('  結果を会話に足す', out.messages.some((m) => m.role === 'tool' && m.content === '結果'));
check('  1往復で止まる', out.rounds === 1, 'rounds=' + out.rounds);

// Tool support is not guaranteed; a failure must not block the answer.
globalThis.fetch = async () => ({ ok: false, status: 400, async json() { return {}; } });
out = await resolveTools({ url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] }, execute: async () => 'x' });
check('ツール非対応でも落ちない', !!out.failed && out.messages.length === 1, String(out.failed));

// A model that keeps asking has to be stopped.
globalThis.fetch = async () => reply({ content: null, tool_calls: [{ id: 'c', function: { name: 'web_search', arguments: '{"query":"q"}' } }] });
out = await resolveTools({ url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] }, execute: async () => 'r' });
check('無限に検索させない', out.exhausted === true && out.rounds === MAX_ROUNDS, 'rounds=' + out.rounds);

// The probe must not inherit thinking: it would spend its budget on a
// monologue and end the turn before emitting a tool call.
let sentBody = null;
globalThis.fetch = async (_u, o) => {
  sentBody = JSON.parse(o.body);
  return reply({ content: 'ok' });
};
await resolveTools({
  url: 'u',
  headers: {},
  body: { messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: true } },
  execute: async () => 'x',
});
check('判断用リクエストは思考を切る', sentBody.chat_template_kwargs.enable_thinking === false,
  JSON.stringify(sentBody.chat_template_kwargs));
check('  ツール呼び出しに足る枠がある', sentBody.max_tokens >= 512, String(sentBody.max_tokens));
check('  ストリーミングしない', sentBody.stream === false);

globalThis.fetch = realFetch;
/* --------------------- searching until satisfied ------------------------ */
// More rounds when asked, but never past the ceiling.
let turns = 0;
globalThis.fetch = async () => {
  turns++;
  return turns <= 6
    ? reply({ content: null, tool_calls: [{ id: 'c' + turns, function: { name: 'web_search', arguments: JSON.stringify({ query: 'q' + turns }) } }] })
    : reply({ content: '結論' });
};
out = await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  maxRounds: 6, execute: async () => 'r',
});
check('往復回数を増やせる', out.rounds === 6, 'rounds=' + out.rounds);

turns = 0;
out = await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  maxRounds: 999, execute: async () => 'r',
});
check('  上限を超えさせない', out.rounds <= ROUND_CEILING, 'rounds=' + out.rounds + ' / 上限 ' + ROUND_CEILING);

// The real shape of a runaway loop: the same query, over and over.
globalThis.fetch = async () =>
  reply({ content: null, tool_calls: [{ id: 'same', function: { name: 'web_search', arguments: '{"query":"同じ"}' } }] });
const ran = [];
out = await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  maxRounds: 10, execute: async (n, a) => { ran.push(a.query); return 'r'; },
});
check('同じ検索の繰り返しで止める', out.stoppedBecause === '同じ検索の繰り返し', String(out.stoppedBecause));
check('  同じ検索を二度実行しない', ran.length === 1, ran.join(', '));
check('  打ち切っても回答には進む', out.messages.at(-1).content.includes('これ以上は検索できません'));

// A slow model must not hold the request open indefinitely.
globalThis.fetch = async () => {
  await new Promise((r) => setTimeout(r, 40));
  return reply({ content: null, tool_calls: [{ id: 'x' + Math.random(), function: { name: 'web_search', arguments: JSON.stringify({ query: Math.random() }) } }] });
};
out = await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  maxRounds: 10, budgetMs: 120, execute: async () => 'r',
});
check('時間予算で打ち切る', out.stoppedBecause === '時間切れ' || out.rounds < 10, 'rounds=' + out.rounds + ' / ' + out.stoppedBecause);

globalThis.fetch = realFetch;

/* ------------------------ engine choice in the schema --------------------- */
const searchTool = (tools) => tools.find((t) => t.function.name === 'web_search').function;
check('既定（選択なし）は engine を出さない', !('engine' in searchTool(CHAT_TOOLS).parameters.properties));
check('  候補 1 つでも出さない', !('engine' in searchTool(chatTools({ engines: ['exa'], strengths: ENGINE_STRENGTHS })).parameters.properties));
const two = searchTool(chatTools({ engines: ['brave', 'exa'], strengths: ENGINE_STRENGTHS }));
const engineProp = two.parameters.properties.engine;
check('候補 2 つで enum を出す', JSON.stringify(engineProp?.enum) === '["brave","exa"]', JSON.stringify(engineProp?.enum));
check('  必須にはしない（既定がある）', JSON.stringify(two.parameters.required) === '["query"]');
check('  得意分野を説明に書く', engineProp.description.includes('ニュース') && engineProp.description.includes('論文') && two.description.includes('engine'));
check('  ページを読むのは方式を問わない', chatTools({ engines: ['brave', 'exa'] })[1].function.description.includes('どの検索エンジン'));
check('  呼ぶたびに作り直す（共有物を書き換えない）', !('engine' in searchTool(CHAT_TOOLS).parameters.properties));

// The tools passed in are the ones the model is offered.
let offered = null;
globalThis.fetch = async (u, o) => { offered = JSON.parse(o.body).tools; return reply({ content: 'ok' }); };
await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  tools: chatTools({ engines: ['brave', 'exa'], strengths: ENGINE_STRENGTHS }), execute: async () => 'x',
});
check('渡したツールをモデルに見せる', !!searchTool(offered).parameters.properties.engine);

// The model's choice reaches execute() as an argument.
turn = 0;
const engineArgs = [];
globalThis.fetch = async () => {
  turn++;
  return turn === 1
    ? reply({ content: null, tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"query":"論文","engine":"exa"}' } }] })
    : reply({ content: '答え' });
};
await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  execute: async (n, a) => { engineArgs.push(a.engine); return '結果'; },
});
check('  選んだ engine が実行に届く', engineArgs.join() === 'exa', engineArgs.join());
globalThis.fetch = realFetch;

/* ------------------------------ context budget ---------------------------- */
// The production failure: ten searches' results, 34,479 tokens, 32K window.
check('予算: 32K の窓で答えの分を残す', promptBudgetFor(32768) === 32768 - 8192 - 512, String(promptBudgetFor(32768)));
check('  窓が不明なら 32K とみなす', promptBudgetFor(undefined) === promptBudgetFor(32768));
check('  262K では答え 16K を残してほぼ全部使う', promptBudgetFor(262144) === 262144 - 16384 - 512, String(promptBudgetFor(262144)));
check('見積もり: ツール呼び出しの引数も数える',
  approxTokens([{ role: 'assistant', content: null, tool_calls: [{ function: { arguments: 'x'.repeat(1500) } }] }]) >= 1000);

const bulky = () => [
  { role: 'user', content: '質問' },
  ...Array.from({ length: 10 }, (_, i) => [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c' + i, content: '結果'.repeat(4000) },
  ]).flat(),
];
const big = bulky();
const before = approxTokens(big);
const cuts = shrinkToolResults(big, 20000);
check('縮める: 予算に収める', approxTokens(big) <= 20000 && cuts > 0, before + ' → ' + approxTokens(big));
check('  ツールの結果だけを縮める', big[0].content === '質問' && big.filter((m) => m.role === 'tool').length === 10);
check('  省略したと書く', big.some((m) => m.role === 'tool' && m.content.includes('省略')));
check('  呼び出しと結果の組は壊さない', big.filter((m) => m.tool_calls).length === 10);
check('  収まっていれば何もしない', shrinkToolResults([{ role: 'user', content: 'x' }], 20000) === 0);
// With the full window, the ten long searches that broke 32K fit whole.
const roomy = bulky();
check('262K なら 10 回分の検索結果を縮めずに収まる', shrinkToolResults(roomy, promptBudgetFor(262144)) === 0, String(approxTokens(roomy)));

// A model that keeps searching stops before the window, not at it.
let sentTokens = [];
turn = 0;
globalThis.fetch = async (u, o) => {
  sentTokens.push(approxTokens(JSON.parse(o.body).messages));
  turn++;
  return reply({ content: null, tool_calls: [{ id: 'k' + turn, function: { name: 'web_search', arguments: '{"query":"q' + turn + '"}' } }] });
};
out = await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] },
  maxRounds: 10, promptBudget: promptBudgetFor(32768),
  execute: async () => '結果'.repeat(4000), // ~8,000 chars, as ten long snippets come to
});
check('検索を続けても上限を超えて送らない', Math.max(...sentTokens) <= promptBudgetFor(32768) - 700, sentTokens.join(','));
check('  上限で打ち切ったと言う', out.stoppedBecause === '会話の長さの上限', String(out.stoppedBecause));
check('  打ち切った後も予算内', approxTokens(out.messages) <= promptBudgetFor(32768), String(approxTokens(out.messages)));

// A refused decision says why.
const runpodError = JSON.stringify({
  error: JSON.stringify({ error: { code: 400, message: 'request (34479 tokens) exceeds the available context size (32768 tokens), try increasing it' } }),
});
check('エラー本文から理由を取り出す', errorText(runpodError).startsWith('request (34479 tokens) exceeds'), errorText(runpodError));
check('  JSON でなければそのまま', errorText('plain failure') === 'plain failure');
globalThis.fetch = async () => ({ ok: false, status: 400, async text() { return runpodError; }, async json() { return {}; } });
out = await resolveTools({ url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] }, execute: async () => 'x' });
check('判断の失敗は理由つきで返す', /^HTTP 400: request \(34479 tokens\)/.test(out.failed), out.failed);

// Each decision's response reaches the caller (it carries the startup details).
const seenReplies = [];
globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: 'ok' } }], hyperai_worker: { source: 'cache' } }; } });
await resolveTools({
  url: 'u', headers: {}, body: { messages: [{ role: 'user', content: 'x' }] }, execute: async () => 'x',
  onReply: (j) => seenReplies.push(j.hyperai_worker?.source),
});
check('判断の応答を onReply に渡す', seenReplies.join() === 'cache', seenReplies.join());
globalThis.fetch = realFetch;

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
