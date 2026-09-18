import {
  splitVersion,
  compareVersion,
  newestInFamily,
  pickImageModel,
  pickVideoModel,
  pickSpeechModel,
} from '../src/lib/image-purpose.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const cat = (...ids) => ids.map((id) => ({ id }));

/* ------------------------------ splitting ------------------------------- */
const g = splitVersion('google/gemini-3.1-flash-image');
check('前後と版を分ける', g.prefix === 'google/gemini-' && g.suffix === '-flash-image', JSON.stringify(g));
check('  版は数値の配列', g.version.join('.') === '3.1', g.version.join('.'));
check('ハイフン区切りの版も読む', splitVersion('bytedance-seed/seedream-5-0-pro').version.join('.') === '5.0');
check('  v 付きも読む', splitVersion('recraft/recraft-v4.1-vector').prefix === 'recraft/recraft-v');
check('変種を切り出す', splitVersion('google/gemini-3.8-flash:batch').variant === 'batch');
check('数字がなければ null', splitVersion('openai/gpt-audio') === null);

/* ------------------------------ comparing ------------------------------- */
check('3.8 > 3.1', compareVersion([3, 8], [3, 1]) > 0);
check('  4 > 3.9', compareVersion([4], [3, 9]) > 0);
check('  3.1 > 3', compareVersion([3, 1], [3]) > 0, '細かい版のほうが新しい');
check('  5.0 > 4.5', compareVersion([5, 0], [4, 5]) > 0);
check('  同値は0', compareVersion([3, 1], [3, 1]) === 0);
check('  10 > 9（文字列比較ではない）', compareVersion([10], [9]) > 0);

/* ---------------------------- family lookup ----------------------------- */
const live = cat(
  'google/gemini-3.1-flash-image',
  'google/gemini-3.8-flash-image',
  'google/gemini-3.1-flash-lite-image',
  'google/gemini-3.8-flash-lite-image',
  'google/gemini-3.8-flash-image:batch',
  'google/gemini-3-pro-image',
  'openai/gpt-image-1-mini'
);

check('同じ系統の最新に上げる', newestInFamily(live, 'google/gemini-3.1-flash-image').id === 'google/gemini-3.8-flash-image');
check('  lite は lite の中で上げる', newestInFamily(live, 'google/gemini-3.1-flash-lite-image').id === 'google/gemini-3.8-flash-lite-image');
check('  lite を通常版に混ぜない', newestInFamily(live, 'google/gemini-3.1-flash-lite-image').id.includes('lite'));
check('  pro を別系統として扱う', newestInFamily(live, 'google/gemini-3-pro-image').id === 'google/gemini-3-pro-image');
check('  :batch を代わりに使わない', !newestInFamily(live, 'google/gemini-3.1-flash-image').id.includes('batch'));
check('  :batch は :batch の中だけ', newestInFamily(live, 'google/gemini-3.1-flash-image:batch')?.id === 'google/gemini-3.8-flash-image:batch');
check('系統ごと無ければ null', newestInFamily(live, 'nope/absent-1-model') === null);
check('版のない id は完全一致', newestInFamily(cat('openai/gpt-audio'), 'openai/gpt-audio').id === 'openai/gpt-audio');
check('空カタログで落ちない', newestInFamily([], 'google/gemini-3.1-flash-image') === null);

/* ------------------------------ end to end ------------------------------ */
const fast = pickImageModel(live, { purpose: 'fast' });
check('用途指定が最新世代を掴む', fast.model.id === 'google/gemini-3.8-flash-lite-image', fast.model.id);
check('  何に置き換えたか説明が出る', fast.why.includes('→'), fast.why);

// A purpose whose whole preference list is gone still falls through cleanly.
const sparse = cat('openai/gpt-image-1-mini');
const missing = pickImageModel(sparse, { purpose: 'vector' });
check('候補が全滅しても既定に落ちる', missing.model?.id === 'openai/gpt-image-1-mini', String(missing.model?.id));

// An explicit model name must never be silently upgraded: the user said it.
const named = pickImageModel(live, { model: 'google/gemini-3.1-flash-image' });
check('明示指定は勝手に上げない', named.model.id === 'google/gemini-3.1-flash-image', named.model.id);
check('  指定だと分かる説明', named.why.startsWith('指定'), named.why);

const vids = cat('bytedance/seedance-2.0-mini', 'bytedance/seedance-4.0-mini', 'google/veo-3.1', 'google/veo-4.2');
check('動画も世代で上がる', pickVideoModel(vids, { purpose: 'fast' }).model.id === 'bytedance/seedance-4.0-mini');
check('  高品質側も', pickVideoModel(vids, { purpose: 'quality' }).model.id === 'google/veo-4.2');

const tts = cat('google/gemini-3.1-flash-tts-preview', 'google/gemini-3.9-flash-tts-preview', 'openai/gpt-audio-mini');
check('読み上げも世代で上がる', pickSpeechModel(tts, { purpose: 'natural' }).model.id === 'google/gemini-3.9-flash-tts-preview');

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
