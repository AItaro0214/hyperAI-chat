import { CHAT_TOOLS, thinkingFor, resolveTools, MAX_ROUNDS, ROUND_CEILING } from '../src/lib/chat-tools.js';

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

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
