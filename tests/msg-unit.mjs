import { buildMessages, audioFormatFor } from '../src/lib/chat.js';
const results = [];
const check = (n, ok, extra='') => { results.push([ok,n,extra]); console.log((ok?'PASS':'FAIL')+' - '+n+(extra?' :: '+extra:'')); };

check('wav を認識', audioFormatFor('audio/wav') === 'wav');
check('mp3 を認識', audioFormatFor('audio/mpeg') === 'mp3');
check('m4a を拡張子から認識', audioFormatFor('application/octet-stream', 'a.m4a') === 'm4a');
check('webm は非対応', audioFormatFor('audio/webm', 'rec.webm') === null);

const env = { KV: { get: async () => new Uint8Array([1,2,3]).buffer } };
const rows = [{
  id: 'm1', role: 'user', content: 'これ何？',
  attachments: JSON.stringify([
    { id: 'f1', kind: 'image', mime: 'image/png', name: 'a.png' },
    { id: 'f2', kind: 'audio', mime: 'audio/mp3', name: 'a.mp3' },
    { id: 'f3', kind: 'doc', mime: 'application/pdf', name: 'a.pdf' },
  ]),
}];

let r = await buildMessages(env, rows, { caps: { image: true, audio: true, file: true } });
let parts = r.messages[0].content;
check('全対応モデルには3種すべて送る', parts.length === 4, parts.map(p=>p.type).join(','));
check('  音声は input_audio で raw base64', parts.find(p=>p.type==='input_audio')?.input_audio?.format === 'mp3' && !String(parts.find(p=>p.type==='input_audio').input_audio.data).startsWith('data:'));
check('  PDF は file + data URL', String(parts.find(p=>p.type==='file')?.file?.file_data).startsWith('data:application/pdf'));
check('  画像は image_url', !!parts.find(p=>p.type==='image_url'));

r = await buildMessages(env, rows, { caps: { image: true, audio: false, file: false } });
parts = r.messages[0].content;
check('非対応の種類は落とす', parts.length === 2 && parts.some(p=>p.type==='image_url'), parts.map(p=>p.type).join(','));
check('  落とした理由を返す', r.skipped.includes('audio') && r.skipped.includes('file'), r.skipped.join(','));

r = await buildMessages(env, [{ id:'m2', role:'user', content:'ただの文章', attachments:'[]' }], { caps: {} });
check('添付なしは文字列のまま', typeof r.messages[0].content === 'string');

r = await buildMessages(env, [{ id:'m3', role:'user', content:'x', attachments: JSON.stringify([{ id:'f4', kind:'audio', mime:'audio/webm', name:'r.webm' }]) }], { caps: { audio: true } });
check('webm は形式エラーとして落とす', r.skipped.includes('audio-format'), r.skipped.join(','));

console.log('');
const failed = results.filter(x=>!x[0]);
console.log(results.length-failed.length+'/'+results.length+' passed');
if (failed.length) process.exit(1);
