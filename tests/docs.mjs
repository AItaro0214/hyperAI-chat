// Document upload and export endpoints. Run against `npm run dev` with the user
// reset to a fresh (TOTP-unenrolled) state.
import { webcrypto as crypto } from 'node:crypto';
import { buildXlsx, buildDocx } from '../src/lib/office.js';
import { unzip } from '../src/lib/zip.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const EMAIL = process.env.TEST_EMAIL || 'owner@example.com';
const PASSWORD = process.env.TEST_PASSWORD || 'change-me';
const te = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};

let cookie = '';
async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (opts.raw) return res;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}
async function kdf(pw, salt, iter) {
  const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: te.encode(salt), iterations: iter, hash: 'SHA-256' }, key, 256)));
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
async function totp(secretB32) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = new ArrayBuffer(8); const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 4294967296)); dv.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', b32decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  return String((((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff)) % 1000000).padStart(6, '0');
}

let r = await call('/api/auth/prelogin', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
const ch = await kdf(PASSWORD, r.json.salt, r.json.iterations);
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
r = await call('/api/auth/enroll', { method: 'POST', body: JSON.stringify({ ticket: r.json.ticket, code: await totp(r.json.secret) }) });
check('ログイン', r.status === 200);

/* ---------------------------- document upload --------------------------- */
const xlsxBytes = await buildXlsx([{ name: '売上', rows: [['商品', '数量'], ['りんご', '120']] }]);
const fd = new FormData();
fd.append('file', new Blob([xlsxBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '売上.xlsx');
r = await call('/api/files', { method: 'POST', body: fd });
check('xlsx をアップロードできる', r.status === 201 && r.json.kind === 'doc', JSON.stringify(r.json).slice(0, 90));
const xlsxId = r.json.id;

let head = await call('/api/files/' + xlsxId, { raw: true });
check('  ドキュメントは添付として返る', (head.headers.get('content-disposition') || '').startsWith('attachment'), head.headers.get('content-disposition'));
check('  日本語ファイル名が壊れない', decodeURIComponent((head.headers.get('content-disposition') || '').split("UTF-8''")[1] || '') === '売上.xlsx');
check('  中身が往復する', new Uint8Array(await head.arrayBuffer()).length === xlsxBytes.length);

const docxBytes = await buildDocx('# 見出し\n\n本文です。');
const fd2 = new FormData();
fd2.append('file', new Blob([docxBytes], { type: 'application/octet-stream' }), 'report.docx');
r = await call('/api/files', { method: 'POST', body: fd2 });
check('docx をアップロードできる', r.status === 201 && r.json.kind === 'doc');
const docxId = r.json.id;

/* -------------------------------- export -------------------------------- */
const markdown = `# 月次レポート

売上は **18%** 増でした。

| 部門 | 売上 |
|---|---|
| 国内 | 4.2億 |
| 海外 | 1.8億 |

## 次のアクション

- 増員する
- 価格を見直す
`;

async function exportAs(format, content = markdown, title = 'テスト レポート') {
  const res = await call('/api/export', { method: 'POST', body: JSON.stringify({ format, content, title }) });
  if (res.status !== 201) return { res, bytes: null };
  const file = await call(res.json.url, { raw: true });
  return { res, bytes: new Uint8Array(await file.arrayBuffer()), disposition: file.headers.get('content-disposition') };
}

for (const [format, ext] of [['xlsx', '.xlsx'], ['docx', '.docx'], ['pptx', '.pptx']]) {
  const { res, bytes } = await exportAs(format);
  check(format + ' を書き出せる', res.status === 201 && bytes && bytes[0] === 0x50 && bytes[1] === 0x4b, bytes ? bytes.length + ' bytes' : JSON.stringify(res.json));
  check('  拡張子が ' + ext, res.json.name?.endsWith(ext), res.json.name);
}

let out = await exportAs('xlsx');
let parts = await unzip(out.bytes);
let sheet = new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']);
check('xlsx に表の中身が入る', sheet.includes('国内') && sheet.includes('4.2億'), (sheet.match(/国内/) || []).length + ' hit');
check('  ヘッダー行が拾われる', sheet.includes('部門'));

out = await exportAs('pptx');
parts = await unzip(out.bytes);
check('pptx が2枚になる', !!parts['ppt/slides/slide2.xml'] && !parts['ppt/slides/slide3.xml'], Object.keys(parts).filter((k) => /slides\/slide\d+\.xml$/.test(k)).length + ' slides');
check('  表がネイティブの表になる', new TextDecoder().decode(parts['ppt/slides/slide1.xml']).includes('<a:tbl>'));

out = await exportAs('csv', '```csv\n名前,点数\n山田,88\n"佐藤, 花",92\n```');
const csvText = new TextDecoder().decode(out.bytes);
check('コードフェンス付き CSV を書き出せる', csvText.includes('山田,88') && !csvText.includes('```'), JSON.stringify(csvText.slice(0, 40)));
check('  Excel 用に BOM を付ける', out.bytes[0] === 0xef && out.bytes[1] === 0xbb && out.bytes[2] === 0xbf);
check('  ダウンロードとして返る', (out.disposition || '').startsWith('attachment'), out.disposition);

out = await exportAs('md');
check('markdown はそのまま', new TextDecoder().decode(out.bytes) === markdown);

out = await exportAs('xlsx', markdown, 'a/b:c*d?e');
check('危険なファイル名を落とす', !/[\\/:*?"<>|]/.test(out.res.json.name), out.res.json.name);

r = await call('/api/export', { method: 'POST', body: JSON.stringify({ format: 'exe', content: 'x' }) });
check('未対応形式は拒否', r.status === 400, JSON.stringify(r.json));
r = await call('/api/export', { method: 'POST', body: JSON.stringify({ format: 'xlsx', content: '   ' }) });
check('空の内容は拒否', r.status === 400);
const noAuth = await fetch(BASE + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'md', content: 'x' }) });
check('未認証では書き出せない', noAuth.status === 401, 'status=' + noAuth.status);

await call('/api/files/' + xlsxId, { method: 'DELETE' });
await call('/api/files/' + docxId, { method: 'DELETE' });

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2])); process.exit(1); }
