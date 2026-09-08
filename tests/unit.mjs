import { estimateTokens, fitToContext, isContextError, groqTakesReasoning } from '../src/lib/chat.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const msg = (role, len) => ({ role, content: 'あ'.repeat(len) });

check('日本語のトークン概算', estimateTokens([msg('user', 150)]) > 90, String(estimateTokens([msg('user', 150)])));
check('画像はまとまったトークンとして数える', estimateTokens([{ role: 'user', content: [{ type: 'image_url' }] }]) > 800);

// small window -> old turns dropped, completion cap clamped
const many = [{ role: 'system', content: 'sys' }, ...Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 400))];
const small = fitToContext({ messages: many, modelMeta: { context: 8000, maxOutput: 4096 }, requestedMax: 4096 });
check('小さいコンテキストで古い発言を落とす', small.dropped > 0 && small.messages.length < many.length, 'dropped=' + small.dropped);
check('  システムプロンプトは残る', small.messages[0].role === 'system');
check('  最新の発言は残る', small.messages[small.messages.length - 1] === many[many.length - 1]);
check('  収まっている', estimateTokens(small.messages) + small.maxTokens < 8000, estimateTokens(small.messages) + ' + ' + small.maxTokens);

// completion cap never exceeds the model's own limit
const capped = fitToContext({ messages: [msg('user', 10)], modelMeta: { context: 131072, maxOutput: 1024 }, requestedMax: 8192 });
check('モデルの最大出力を超えない', capped.maxTokens === 1024, String(capped.maxTokens));

// web search keeps extra headroom
const plain = fitToContext({ messages: many, modelMeta: { context: 131072, maxOutput: 8192 }, requestedMax: 4096, toolHeavy: false });
const heavy = fitToContext({ messages: many, modelMeta: { context: 131072, maxOutput: 8192 }, requestedMax: 4096, toolHeavy: true });
check('Web検索時は余裕を多めに取る', heavy.dropped >= plain.dropped, 'plain=' + plain.dropped + ' heavy=' + heavy.dropped);
check('  通常時は 131K なら削らない', plain.dropped === 0);

check('コンテキスト超過エラーを判定', isContextError('Please reduce the length of the messages or completion.'));
check('  他のエラーは誤判定しない', !isContextError('User not found.'));

check('compound は reasoning_effort 非対応', groqTakesReasoning('groq/compound') === false);
check('  gpt-oss は対応', groqTakesReasoning('openai/gpt-oss-120b') === true);
check('  llama は非対応', groqTakesReasoning('llama-3.3-70b-versatile') === false);

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
