import { CHAT_TOOLS, thinkingFor, resolveTools, MAX_ROUNDS } from '../src/lib/chat-tools.js';

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
const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exitCode = passed === results.length ? 0 : 1;
