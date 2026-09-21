import { withCacheBreakpoints, needsExplicitCache, cacheStats } from '../src/lib/cache.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const big = (n) => 'x'.repeat(n);
const marks = (msgs) =>
  msgs.filter((m) => Array.isArray(m.content) && m.content.some((b) => b?.cache_control)).length;

/* ----------------------- who needs telling at all ----------------------- */
check('Claude は明示が要る', needsExplicitCache('openrouter', 'anthropic/claude-sonnet-5'));
check('Qwen も要る', needsExplicitCache('openrouter', 'qwen/qwen3-max'));
check('GPT は不要（自動）', !needsExplicitCache('openrouter', 'openai/gpt-5.4'));
check('Gemini は不要', !needsExplicitCache('openrouter', 'google/gemini-3.8-flash'));
check('Grok は不要', !needsExplicitCache('openrouter', 'x-ai/grok-4.6'));
check('Groq 経由は不要', !needsExplicitCache('groq', 'qwen/qwen3-32b'), 'Groq 自身が自動で行う');
check('モデル不明なら触らない', !needsExplicitCache('openrouter', undefined));

/* --------------------------- leaving alone ------------------------------ */
const plain = [{ role: 'system', content: big(9000) }, { role: 'user', content: 'hi' }];
check('対象外のモデルは素通し', withCacheBreakpoints(plain, { provider: 'openrouter', model: 'openai/gpt-5.4' }) === plain);
check('空配列で落ちない', withCacheBreakpoints([], { model: 'anthropic/claude-sonnet-5' }).length === 0);
check('null で落ちない', withCacheBreakpoints(null, { model: 'anthropic/claude-sonnet-5' }) === null);

/* ------------------------------ marking --------------------------------- */
const anthropic = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' };

const short = withCacheBreakpoints(
  [{ role: 'system', content: 'short' }, { role: 'user', content: 'hi' }],
  anthropic
);
check('小さすぎる前置きは印を付けない', marks(short) === 0, '書き込み割増のほうが高くつく');

const withSystem = withCacheBreakpoints(
  [{ role: 'system', content: big(9000) }, { role: 'user', content: 'hi' }],
  anthropic
);
check('大きいシステムには印を付ける', marks(withSystem) === 1, String(marks(withSystem)));
check('  ephemeral として印を付ける', withSystem[0].content[0].cache_control.type === 'ephemeral');
check('  本文は保持される', withSystem[0].content[0].text.length === 9000);
check('  元の配列を書き換えない', typeof plain[0].content === 'string');

const convo = withCacheBreakpoints(
  [
    { role: 'system', content: big(9000) },
    { role: 'user', content: big(5000) },
    { role: 'assistant', content: big(5000) },
    { role: 'user', content: '次は？' },
  ],
  anthropic
);
check('会話にも印を付ける', marks(convo) === 2, String(marks(convo)) + ' 箇所');
check('  最後の発言には付けない', !Array.isArray(convo[3].content), '次ターンで変わる位置は無駄');
check('  1つ手前に付く', Array.isArray(convo[2].content) && !!convo[2].content[0].cache_control);

// Anthropic allows four; two is deliberate, and never more.
check('印は多くても2箇所', marks(convo) <= 2);

/* ---------------------- content that cannot be marked ------------------- */
const withToolCall = withCacheBreakpoints(
  [
    { role: 'system', content: big(9000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'tool', content: big(9000), tool_call_id: 'a' },
    { role: 'user', content: 'つぎ' },
  ],
  anthropic
);
check('tool_calls の行は飛ばす', withToolCall[1].content === null, '印を付けられない');
check('  代わりに tool 出力へ付く', Array.isArray(withToolCall[2].content));

const imageOnly = withCacheBreakpoints(
  [
    { role: 'system', content: big(9000) },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'user', content: 'hi' },
  ],
  anthropic
);
check('画像だけの行には付けない', !imageOnly[1].content[0].cache_control, 'テキストブロックにしか付けられない');

const mixed = withCacheBreakpoints(
  [
    { role: 'system', content: big(9000) },
    { role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: big(6000) }] },
    { role: 'user', content: 'hi' },
  ],
  anthropic
);
check('混在なら末尾のテキストへ付く', !!mixed[1].content[1].cache_control && !mixed[1].content[0].cache_control);

/* ------------------------------- reporting ------------------------------ */
check('読み取り量を拾う', cacheStats({ prompt_tokens_details: { cached_tokens: 1200 } }).read === 1200);
check('書き込み量を拾う', cacheStats({ cache_creation_input_tokens: 300 }).written === 300);
check('usage なしでも 0', cacheStats(null).read === 0 && cacheStats(undefined).written === 0);

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
