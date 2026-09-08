import { normalizeRates, estimateVideoCost, applyDiscount } from '../src/lib/video.js';
const results = [];
const check = (n, ok, extra='') => { results.push([ok,n,extra]); console.log((ok?'PASS':'FAIL')+' - '+n+(extra?' :: '+extra:'')); };
const near = (a,b,tol=0.005)=>a!=null&&Math.abs(a-b)<=tol;

// MiniMax: dollars per second
const hailuo3 = { pricing: { duration_seconds: '0.13', reference_images: '0.04' } };
check('MiniMax H3 は秒課金として読める', near(estimateVideoCost(hailuo3,{duration:6}), 0.78), String(estimateVideoCost(hailuo3,{duration:6})));
const hailuoMax = { pricing: { duration_seconds: '0.08', duration_seconds_480p: '0.05', duration_seconds_768p: '0.08' } };
check('  解像度別の単価を選ぶ', near(estimateVideoCost(hailuoMax,{duration:10,resolution:'480p'}), 0.5), String(estimateVideoCost(hailuoMax,{duration:10,resolution:'480p'})));
check('  指定なしは既定単価', near(estimateVideoCost(hailuoMax,{duration:10}), 0.8));

// Veo: audio-dependent per-second
const veo = { pricing: { duration_seconds_with_audio: '0.40', duration_seconds_without_audio: '0.20', duration_seconds_with_audio_4k: '0.60' } };
check('Veo 3.1 音声ありは高い', near(estimateVideoCost(veo,{duration:8,generateAudio:true}), 3.2), String(estimateVideoCost(veo,{duration:8,generateAudio:true})));
check('  音声なしは半額', near(estimateVideoCost(veo,{duration:8,generateAudio:false}), 1.6));
check('  4K は専用単価', near(estimateVideoCost(veo,{duration:5,resolution:'4k',generateAudio:true}), 3.0));

// Seedance: video tokens
const seedance = { pricing: { video_tokens: '0.0000035' } };
const sd = estimateVideoCost(seedance,{duration:1,size:'854x480'});
check('Seedance はトークン課金', near(sd, 0.0336, 0.001), String(sd));

// cents-based
const runway = { pricing: { cents_per_second_output: '28', minimum_cents_per_generation: '56' } };
check('セント建てをドルに換算', near(estimateVideoCost(runway,{duration:5}), 1.4), String(estimateVideoCost(runway,{duration:5})));
check('  最低料金が効く', near(estimateVideoCost(runway,{duration:1}), 0.56), String(estimateVideoCost(runway,{duration:1})));
const grok = { pricing: { cents_per_video_output_second_480p: '8', cents_per_video_output_second_720p: '14' } };
check('  解像度別のセント建て', near(estimateVideoCost(grok,{duration:5,resolution:'720p'}), 0.7));

// megapixel-second
const upscale = { pricing: { cents_per_megapixel_second_precise: '7.5', cents_per_megapixel_second_creative: '10.5' } };
check('メガピクセル秒も算出できる', estimateVideoCost(upscale,{duration:5,resolution:'720p'}) > 0, String(estimateVideoCost(upscale,{duration:5,resolution:'720p'})));

// collisions keep the dearer rate
const wan = { pricing: { text_to_video_duration_seconds_720p: '0.08', image_to_video_duration_seconds_720p: '0.10' } };
check('同一解像度で単価が割れたら高い方', near(estimateVideoCost(wan,{duration:5,resolution:'720p'}), 0.5), String(estimateVideoCost(wan,{duration:5,resolution:'720p'})));

check('料金不明なら null', estimateVideoCost({pricing:{}},{duration:5}) === null);
const rates = normalizeRates(hailuo3.pricing);
check('参照画像の追加料金も拾う', rates.extra.referenceImage === 0.04);

// promotional discounts
const seedanceMini = { pricing: { video_tokens: '0.0000035' } };
const listPerSec = estimateVideoCost(seedanceMini, { duration: 1, resolution: '480p' });
check('480p の定価は約 $0.0336/秒', near(listPerSec, 0.0336, 0.0005), String(listPerSec));
check('  60%OFF で約 $0.0134/秒', near(applyDiscount(listPerSec, 0.6), 0.01345, 0.0005), String(applyDiscount(listPerSec, 0.6)));
const list720 = estimateVideoCost(seedanceMini, { duration: 1, resolution: '720p' });
check('720p の定価は約 $0.0756/秒', near(list720, 0.0756, 0.0005), String(list720));
check('  60%OFF で約 $0.0302/秒', near(applyDiscount(list720, 0.6), 0.03024, 0.0005), String(applyDiscount(list720, 0.6)));
check('割引 0 なら定価のまま', applyDiscount(0.5, 0) === 0.5);
check('不正な割引は無視', applyDiscount(0.5, 1.5) === 0.5 && applyDiscount(0.5, -1) === 0.5);
check('null はそのまま null', applyDiscount(null, 0.6) === null);

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
