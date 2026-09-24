import { splitForTts, concatWav } from '../src/routes/media.js';
import { formatFor, parsePcmType, wavFromPcm, hasContainer, OPENROUTER_FORMATS } from '../src/lib/speech.js';
const results = [];
const check = (n, ok, extra='') => { results.push([ok,n,extra]); console.log((ok?'PASS':'FAIL')+' - '+n+(extra?' :: '+extra:'')); };

const long = 'これはテストです。'.repeat(60);
const chunks = splitForTts(long);
check('長文を分割する', chunks.length > 1, chunks.length + ' chunks');
check('  各チャンクが上限以内', chunks.every(c => c.length <= 190), Math.max(...chunks.map(c=>c.length)) + ' max');
check('  文の途中で切らない', chunks.slice(0,-1).every(c => /[。．.!?！？]$/.test(c.trim())), JSON.stringify(chunks[0].slice(-12)));
check('短文は1チャンク', splitForTts('こんにちは。').length === 1);
const noBreaks = splitForTts('あ'.repeat(500));
check('区切りが無くても分割', noBreaks.length === 3 && noBreaks.every(c=>c.length<=190), noBreaks.map(c=>c.length).join('/'));

function wav(samples) {
  const buf = new ArrayBuffer(44 + samples*2);
  const dv = new DataView(buf);
  const w = (o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
  w(0,'RIFF'); dv.setUint32(4, 36+samples*2, true); w(8,'WAVEfmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,24000,true); dv.setUint32(28,48000,true); dv.setUint16(32,2,true); dv.setUint16(34,16,true);
  w(36,'data'); dv.setUint32(40, samples*2, true);
  for(let i=0;i<samples;i++) dv.setInt16(44+i*2, i%100, true);
  return buf;
}
const merged = concatWav([wav(100), wav(50), wav(25)]);
const mv = new DataView(merged);
check('WAV を連結できる', merged.byteLength === 44 + (175*2), merged.byteLength + ' bytes');
check('  RIFF サイズを更新', mv.getUint32(4, true) === merged.byteLength - 8);
check('  data サイズを更新', mv.getUint32(40, true) === 175*2);
check('  1つだけならそのまま', concatWav([wav(10)]).byteLength === 64);

/* ------------------------------- formats -------------------------------- */
/* All of the below was verified against OpenRouter's live endpoint: it takes
 * mp3 and pcm and nothing else, and Gemini takes only pcm. */
check('Gemini は pcm しか受け付けない', formatFor('google/gemini-3.8-flash-tts') === 'pcm');
check('  プレビュー版も同じ', formatFor('google/gemini-3.1-flash-tts-preview', 'mp3') === 'pcm', '希望を押し通さない');
check('  mp3 を頼まれても pcm', formatFor('google/gemini-3.8-flash-lite-tts', 'mp3') === 'pcm');
check('ふつうのモデルは mp3', formatFor('hexgrad/kokoro-82m') === 'mp3');
check('  OpenRouter が拒む形式は落とす', formatFor('hexgrad/kokoro-82m', 'wav') === 'mp3', 'wav は 400 になる');
check('  受け付ける形式なら通す', formatFor('openai/gpt-audio-mini', 'pcm') === 'pcm');
check('Groq は wav を使える', formatFor('playai-tts', 'wav', { provider: 'groq' }) === 'wav');
check('  Groq の既定も wav', formatFor('playai-tts', undefined, { provider: 'groq' }) === 'wav');

check('OpenRouter の対応形式は2つだけ', OPENROUTER_FORMATS.join(',') === 'mp3,pcm', OPENROUTER_FORMATS.join(','));

/* ----------------------------- pcm → wav -------------------------------- */
const pcmType = parsePcmType('audio/pcm;rate=24000;channels=1');
check('content-type から pcm の諸元を読む', pcmType?.sampleRate === 24000 && pcmType.channels === 1, JSON.stringify(pcmType));
check('  L16 表記も読む', parsePcmType('audio/L16;rate=16000')?.sampleRate === 16000);
check('  mp3 は pcm ではない', parsePcmType('audio/mpeg') === null);
check('  指定が無ければ既定値', parsePcmType('audio/pcm')?.sampleRate === 24000);

const samples = new Uint8Array(480); // 240 samples, 16bit mono
const wrapped = wavFromPcm(samples, { sampleRate: 24000, channels: 1, bits: 16 });
const wv = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
const tag = (o) => String.fromCharCode(wv.getUint8(o), wv.getUint8(o + 1), wv.getUint8(o + 2), wv.getUint8(o + 3));
check('pcm に WAV ヘッダを付ける', tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(36) === 'data');
check('  本文は44バイト後ろ', wrapped.length === samples.length + 44, String(wrapped.length));
check('  RIFF サイズが合う', wv.getUint32(4, true) === wrapped.length - 8);
check('  data サイズが合う', wv.getUint32(40, true) === samples.length);
check('  サンプルレートを書く', wv.getUint32(24, true) === 24000);
check('  バイトレートを書く', wv.getUint32(28, true) === 24000 * 2, String(wv.getUint32(28, true)));
check('  16bit モノラル', wv.getUint16(22, true) === 1 && wv.getUint16(34, true) === 16);
// A WAV this app makes must survive the concatenation it already does.
check('  自前の連結器で読める', concatWav([wrapped.buffer.slice(wrapped.byteOffset, wrapped.byteOffset + wrapped.length)]).byteLength === wrapped.length);

/* ---------------------------- container check ---------------------------- */
check('RIFF は容器あり', hasContainer(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])));
check('ID3 付き mp3 は容器あり', hasContainer(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0])));
// The real bytes Gemini returned began with exactly this.
check('裸の mp3 フレームも容器あり', hasContainer(new Uint8Array([0xff, 0xf3, 0x84, 0xc4, 0, 0, 0, 0])));
check('無音の生 pcm は容器なし', !hasContainer(new Uint8Array(8)), 'Gemini の応答はここから始まる');
check('空なら容器なし', !hasContainer(new Uint8Array(0)));

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
