import { estimateChatCost, outputTokens, turnCost } from '../src/lib/models.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const near = (a, b) => Math.abs(a - b) < 1e-9;

/* --------------------------- reasoning tokens --------------------------- */
// The OpenAI-compatible schema counts reasoning inside completion_tokens;
// completion_tokens_details is a breakdown, not an addition.
check(
  '思考トークンは completion に含まれている前提',
  outputTokens({ completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 800 } }) === 1000,
  '二重計上しない'
);
check('  内訳がなくても数える', outputTokens({ completion_tokens: 500 }) === 500);
check('  usage なしは 0', outputTokens(null) === 0 && outputTokens({}) === 0);

// A provider that reports reasoning outside completion_tokens gives itself away
// by returning fewer completion tokens than the reasoning it claims to hold.
check(
  '外出しされていたら足す',
  outputTokens({ completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 900 } }) === 950,
  '思考の多いターンが無料に見えるのを防ぐ'
);

/* ------------------------------ estimation ------------------------------ */
const groqModel = { provider: 'groq', pricing: { kind: 'chat', input_per_m: 1, output_per_m: 4 } };
const usage = { prompt_tokens: 1e6, completion_tokens: 1e6 };
check('Groq をトークンから見積もる', near(estimateChatCost(groqModel, usage), 5), String(estimateChatCost(groqModel, usage)));

const thinky = { prompt_tokens: 0, completion_tokens: 1e6, completion_tokens_details: { reasoning_tokens: 9e5 } };
check('  思考込みで課金される', near(estimateChatCost(groqModel, thinky), 4), String(estimateChatCost(groqModel, thinky)));

check('価格表がなければ null', estimateChatCost({ provider: 'groq' }, usage) === null);
check('  usage がなければ null', estimateChatCost(groqModel, null) === null);

/* -------------------------------- turn ---------------------------------- */
// OpenRouter bills us directly and that number already includes reasoning.
check('請求額があればそれを使う', turnCost(groqModel, { cost: 0.25, completion_tokens: 1e6 }) === 0.25, '見積もりで上書きしない');
check('  0 は請求なしとして扱う', near(turnCost(groqModel, { cost: 0, ...usage }), 5), 'Groq の cost 欠落と同じ扱い');
check('請求額がなければ見積もる', near(turnCost(groqModel, usage), 5), String(turnCost(groqModel, usage)));
check('  価格表もなければ 0', turnCost(null, usage) === 0, '合算が NaN にならないこと');
check('  usage ごとなくても 0', turnCost(groqModel, undefined) === 0);

// The bug this replaced: a Groq run reported nothing spent at all.
const before = Number({ prompt_tokens: 1e6, completion_tokens: 1e6 }.cost) || 0;
check('以前は Groq が 0 円になっていた', before === 0 && turnCost(groqModel, usage) > 0, '0 → $5');

/* ------------------------- router sentinel prices ----------------------- */
// openrouter/auto and friends advertise -1000000 until they pick a model.
const router = { provider: 'openrouter', pricing: { kind: 'chat', input_per_m: -1000000, output_per_m: -1000000 } };
check('ルーターの番兵価格は見積もらない', estimateChatCost(router, usage) === null, String(estimateChatCost(router, usage)));
check('  合計をマイナスにしない', turnCost(router, usage) === 0, String(turnCost(router, usage)));
check('  請求額があればそれは使う', turnCost(router, { cost: 0.4, ...usage }) === 0.4);

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
