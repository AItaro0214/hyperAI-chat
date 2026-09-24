/* A real Gemini synthesis, end to end.
 *
 * Not part of the unit run: it spends a few characters of quota and needs a
 * real key. Run it when the speech path changes — the point is that what
 * comes back off the wire is a file a browser will actually play, which no
 * fixture can prove.
 *
 *   OPENROUTER_API_KEY=... node tests/tts-live.mjs [model]
 */
import { synthesize, formatFor } from '../src/lib/speech.js';

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.log('OPENROUTER_API_KEY が設定されていません。スキップします。');
  process.exit(0);
}

const model = process.argv[2] || 'google/gemini-3.8-flash-tts';
const voice = model.includes('gemini') ? 'Kore' : undefined;
console.log('model:', model, '/ requesting:', formatFor(model));

const out = await synthesize(key, model, { text: 'これはテストです。音声形式の確認をしています。', voice });
console.log('format:', out.format, '(requested ' + out.requested + ')', '| mime:', out.mime, '|', out.bytes.length, 'bytes');

const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength);
const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
if (out.format === 'wav') {
  const rate = dv.getUint32(24, true);
  const dataSize = dv.getUint32(40, true);
  const seconds = dataSize / (rate * dv.getUint16(32, true));
  console.log('RIFF:', tag(0), '| WAVE:', tag(8).slice(0, 4), '| data:', tag(36));
  console.log('rate:', rate, '| channels:', dv.getUint16(22, true), '| bits:', dv.getUint16(34, true));
  console.log('RIFF size ok:', dv.getUint32(4, true) === out.bytes.length - 8);
  console.log('data size ok:', dataSize === out.bytes.length - 44);
  console.log('duration:', seconds.toFixed(2) + 's');
} else {
  console.log('magic:', [...out.bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
}

const fs = await import('node:fs');
const path = (process.env.TEMP || '.') + '/tts-check.' + out.format;
fs.writeFileSync(path, out.bytes);
console.log('wrote', path);
