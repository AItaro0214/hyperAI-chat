import {
  toHistoryMessages,
  cleanContent,
  loadAgentHistory,
  HISTORY_NOTE,
  DEFAULT_HISTORY_CHARS,
} from '../src/lib/agent-history.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const row = (role, content) => ({ role, content });

/* ------------------------------ cleaning -------------------------------- */
check('開発指示の印を読める形に直す', cleanContent(row('user', '🛠 ログイン画面を作って')) === '[前回の開発指示] ログイン画面を作って');
check('  通常の発言はそのまま', cleanContent(row('user', 'こんにちは')) === 'こんにちは');
check('  アシスタントの印は触らない', cleanContent(row('assistant', '🛠 これは本文')) === '🛠 これは本文');
check('  空白だけなら空', cleanContent(row('user', '   ')) === '');

/* ------------------------------ selection ------------------------------- */
const convo = [
  row('user', 'A'.repeat(100)),
  row('assistant', 'B'.repeat(100)),
  row('user', 'C'.repeat(100)),
  row('assistant', 'D'.repeat(100)),
];

const all = toHistoryMessages(convo, { maxChars: 10000 });
check('全部入るなら全部返す', all.length === 4, String(all.length));
check('  時系列の順を保つ', all[0].content[0] === 'A' && all[3].content[0] === 'D');
check('  role を保つ', all[0].role === 'user' && all[1].role === 'assistant');

// The budget is spent newest-first, so the oldest turns are the ones dropped.
const tight = toHistoryMessages(convo, { maxChars: 250 });
check('予算内に収める', tight.length === 2, String(tight.length));
check('  新しい方を残す', tight[tight.length - 1].content[0] === 'D', tight.map((m) => m.content[0]).join(''));
check('  古い方を落とす', !tight.some((m) => m.content[0] === 'A'));

check('0 なら無効', toHistoryMessages(convo, { maxChars: 0 }).length === 0);
check('  負数でも無効', toHistoryMessages(convo, { maxChars: -5 }).length === 0);
check('空配列で落ちない', toHistoryMessages([], {}).length === 0 && toHistoryMessages(null, {}).length === 0);

// A single turn bigger than the whole budget is truncated from the front:
// the conclusion of a long summary is worth more than its opening.
const huge = toHistoryMessages([row('assistant', 'x'.repeat(500) + 'ここが結論')], { maxChars: 400 });
check('長すぎる発言は末尾を残す', huge.length === 1 && huge[0].content.endsWith('ここが結論'), huge[0]?.content.slice(-12));
check('  先頭を省略した印がある', huge[0].content.startsWith('…'));
const tiny = toHistoryMessages([row('assistant', 'y'.repeat(500))], { maxChars: 150 });
check('  切り詰める余地もなければ諦める', tiny.length === 0, String(tiny.length));

check('system は混ぜない', toHistoryMessages([row('system', 'S'), row('user', 'U')], {}).length === 1);
check('空の発言は飛ばす', toHistoryMessages([row('user', ''), row('user', 'ok')], {}).length === 1);

/* -------------------------------- loader -------------------------------- */
// Enough of D1 to drive the loader: rows come back newest first.
function fakeEnv(rows, onBind) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            onBind?.(sql, args);
            return { async all() { return { results: rows.filter((r) => r.id !== args[1]) }; } };
          },
        };
      },
    },
  };
}

let seenArgs = null;
const env = fakeEnv(
  [
    { id: 'm3', role: 'user', content: '🛠 いまの依頼' },
    { id: 'm2', role: 'assistant', content: '前回やったこと' },
    { id: 'm1', role: 'user', content: '前回の依頼' },
  ],
  (_sql, args) => (seenArgs = args)
);

const loaded = await loadAgentHistory(env, 'room_1', { excludeId: 'm3' });
check('今回の指示を履歴に含めない', !loaded.some((m) => m.content.includes('いまの依頼')), JSON.stringify(loaded));
check('  過去のやり取りは含める', loaded.length === 2, String(loaded.length));
check('  古い順に並べ直す', loaded[0].content === '前回の依頼', loaded[0].content);
check('  room で絞っている', seenArgs[0] === 'room_1', String(seenArgs[0]));

const off = await loadAgentHistory(env, 'room_1', { excludeId: 'm3', maxChars: 0 });
check('0 なら問い合わせない', off.length === 0);

// Losing history must degrade the run, never fail it.
const broken = { DB: { prepare() { throw new Error('D1 down'); } } };
check('DB が落ちても例外にしない', (await loadAgentHistory(broken, 'r', {})).length === 0);

/* -------------------------------- wiring -------------------------------- */
check('既定の予算がある', DEFAULT_HISTORY_CHARS > 0, String(DEFAULT_HISTORY_CHARS));
check('履歴だと明示する注記がある', HISTORY_NOTE.includes('今回の指示ではありません'));

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
