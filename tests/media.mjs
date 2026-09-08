// Video-generation and artifact endpoints. Run against `npm run dev` with the
// user reset to a fresh (TOTP-unenrolled) state.
import { webcrypto as crypto } from 'node:crypto';

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

/* ------------------------------- video --------------------------------- */
r = await call('/api/videos/models');
const vmodels = r.json.models || [];
check('動画モデル一覧を取得', r.status === 200 && vmodels.length > 10, vmodels.length + ' models');
for (const want of ['bytedance/seedance-2.0-mini', 'google/veo-3.1']) {
  check('  ' + want + ' がある', vmodels.some((m) => m.id === want));
}
const seed = vmodels.find((m) => m.id === 'bytedance/seedance-2.0-mini');
check('  対応解像度/尺/アスペクト比が入っている',
  seed && seed.resolutions.length > 0 && seed.durations.length > 0 && seed.aspectRatios.length > 0,
  seed ? seed.resolutions.join('/') + ' | ' + seed.durations.length + '通りの尺' : '');
check('  料金SKUが入っている', !!seed?.pricing?.video_tokens, JSON.stringify(seed?.pricing || {}));
check('  音声生成/シード対応フラグ', typeof seed?.generateAudio === 'boolean' && typeof seed?.seed === 'boolean');

r = await call('/api/videos', { method: 'POST', body: JSON.stringify({ model: 'bogus/model', prompt: 'x' }) });
check('未知モデルは拒否', r.status === 400, JSON.stringify(r.json));
r = await call('/api/videos', { method: 'POST', body: JSON.stringify({ model: 'bytedance/seedance-2.0-mini' }) });
check('プロンプト無しは拒否', r.status === 400);
r = await call('/api/videos/jobs');
check('ジョブ一覧', r.status === 200 && Array.isArray(r.json.jobs));

/* --------------------------- range requests ----------------------------- */
const fd = new FormData();
const bytes = new Uint8Array(1000).map((_, i) => i % 251);
fd.append('file', new Blob([bytes], { type: 'video/mp4' }), 'clip.mp4');
r = await call('/api/files', { method: 'POST', body: fd });
check('動画ファイルをアップロード', r.status === 201, JSON.stringify(r.json).slice(0, 80));
const fileUrl = '/api/files/' + r.json.id;

let full = await call(fileUrl, { raw: true });
check('通常取得は 200 で Accept-Ranges を返す', full.status === 200 && full.headers.get('accept-ranges') === 'bytes', full.headers.get('accept-ranges'));

let part = await call(fileUrl, { raw: true, headers: { range: 'bytes=0-99' } });
const partBody = new Uint8Array(await part.arrayBuffer());
check('範囲指定は 206 を返す', part.status === 206, 'status=' + part.status);
check('  Content-Range が正しい', part.headers.get('content-range') === 'bytes 0-99/1000', part.headers.get('content-range'));
check('  本文が 100 バイト', partBody.length === 100, String(partBody.length));
check('  中身が一致', partBody[0] === 0 && partBody[99] === 99);

part = await call(fileUrl, { raw: true, headers: { range: 'bytes=900-' } });
check('末尾までの指定', part.status === 206 && part.headers.get('content-range') === 'bytes 900-999/1000', part.headers.get('content-range'));
part = await call(fileUrl, { raw: true, headers: { range: 'bytes=-50' } });
check('末尾 N バイト指定', part.status === 206 && part.headers.get('content-range') === 'bytes 950-999/1000', part.headers.get('content-range'));
part = await call(fileUrl, { raw: true, headers: { range: 'bytes=5000-6000' } });
check('範囲外は 416', part.status === 416, 'status=' + part.status);
await call(fileUrl, { method: 'DELETE' });

/* ----------------------------- artifacts -------------------------------- */
const html = '<!doctype html><html><body><h1 id="t">hello</h1><script>document.getElementById("t").textContent="ran"</' + 'script></body></html>';
r = await call('/api/artifacts', { method: 'POST', body: JSON.stringify({ content: html, kind: 'html', title: 'テスト' }) });
check('アーティファクト作成', r.status === 201 && !!r.json.artifact?.id, JSON.stringify(r.json.artifact || {}));
const artId = r.json.artifact.id;

const raw = await call('/api/artifacts/' + artId + '/raw', { raw: true });
const rawBody = await raw.text();
check('raw が HTML を返す', raw.status === 200 && rawBody.includes('hello'));
const csp = raw.headers.get('content-security-policy') || '';
check('  サンドボックス CSP', csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'self'"), csp.slice(0, 70));
check('  CDN とネットワークは既定で許可', csp.includes('script-src') && csp.includes('https:') && csp.includes('connect-src https:'));
const strict = await call('/api/artifacts/' + artId + '/raw?strict=1', { raw: true });
const strictCsp = strict.headers.get('content-security-policy') || '';
check('  strict=1 で外部通信を遮断', strictCsp.includes("connect-src 'none'") && !strictCsp.includes('https:'), strictCsp.slice(0, 60));
check('  インラインスクリプトは許可', csp.includes("script-src 'unsafe-inline'"));
check('  自アプリからのみ frame 可', raw.headers.get('x-frame-options') === 'SAMEORIGIN' && csp.includes("frame-ancestors 'self'"));

r = await call('/api/artifacts', { method: 'POST', body: JSON.stringify({ content: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>', kind: 'svg' }) });
const svgId = r.json.artifact.id;
const svgRaw = await call('/api/artifacts/' + svgId + '/raw', { raw: true });
const svgBody = await svgRaw.text();
check('SVG は HTML に包んで返す', svgBody.includes('<svg') && svgBody.startsWith('<!doctype html'));

r = await call('/api/artifacts');
check('一覧に出る', r.status === 200 && r.json.artifacts.length >= 2);
r = await call('/api/artifacts/' + artId, { method: 'DELETE' });
const gone = await call('/api/artifacts/' + artId + '/raw', { raw: true });
check('削除できる', r.status === 200 && gone.status === 404);

const noAuth = await fetch(BASE + '/api/artifacts/' + svgId + '/raw');
check('未認証では見られない', noAuth.status === 401, 'status=' + noAuth.status);

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2])); process.exit(1); }
