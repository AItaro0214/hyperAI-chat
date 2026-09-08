import { splitForTts, concatWav } from '../src/routes/media.js';
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

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
