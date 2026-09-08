// Checks the promotional-discount lookup against the live OpenRouter listing.
// Read-only: it calls the public /videos/models and /models/{slug}/endpoints
// routes, neither of which needs an API key.
import { fetchVideoModels, estimateVideoCost, applyDiscount } from '../src/lib/video.js';

const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};

const started = Date.now();
const models = await fetchVideoModels({}, { force: true });
const elapsed = Date.now() - started;
check('動画モデルを取得できる', models.length > 10, models.length + ' models / ' + elapsed + 'ms');
check('28件の割引照会が10秒以内に終わる', elapsed < 10000, elapsed + 'ms');
check('全モデルに discount が入る', models.every((m) => typeof m.discount === 'number'));

const discounted = models.filter((m) => m.discount > 0);
console.log('  割引中: ' + (discounted.map((m) => m.id + ' ' + Math.round(m.discount * 100) + '%OFF').join(', ') || 'なし'));

for (const id of ['bytedance/seedance-2.0-mini', 'bytedance/seedance-2.5', 'google/veo-3.1', 'minimax/hailuo-3']) {
  const m = models.find((x) => x.id === id);
  if (!m) {
    check('  ' + id + ' がある', false);
    continue;
  }
  const res = m.resolutions.includes('720p') ? '720p' : m.resolutions[0];
  const list = estimateVideoCost(m, { resolution: res, duration: 1, generateAudio: m.generateAudio });
  const eff = applyDiscount(list, m.discount);
  check(
    '  ' + id + ' の秒単価が出る',
    list != null && eff != null,
    res + ' 定価$' + Number(list).toFixed(5) + ' → 実費$' + Number(eff).toFixed(5) + ' (discount=' + m.discount + ')'
  );
}

const mini = models.find((x) => x.id === 'bytedance/seedance-2.0-mini');
if (mini) {
  const l480 = estimateVideoCost(mini, { resolution: '480p', duration: 1 });
  const e480 = applyDiscount(l480, mini.discount);
  // OpenRouter advertises "from $0.01345/second" for this model while the
  // promotion runs; a real 480p/4s job was billed $0.0568 (= $0.0142/s).
  check('seedance-2.0-mini 480p の実効秒単価が公称値と一致', Math.abs(e480 - 0.01345) < 0.002, '$' + e480.toFixed(5) + '/秒');
  const e720 = applyDiscount(estimateVideoCost(mini, { resolution: '720p', duration: 1 }), mini.discount);
  console.log('  480p 5秒: $' + (e480 * 5).toFixed(4) + ' / 720p 5秒: $' + (e720 * 5).toFixed(4));
}

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2]));
  process.exit(1);
}
