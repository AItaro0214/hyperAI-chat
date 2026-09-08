import { webcrypto as crypto } from 'node:crypto';

const BASE = 'http://127.0.0.1:8787';
const EMAIL = process.env.TEST_EMAIL || 'owner@example.com';
const PASSWORD = process.env.TEST_PASSWORD || 'change-me';
const te = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64');
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
  return { status: res.status, json, headers: res.headers };
}

async function clientHash(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: te.encode(salt), iterations, hash: 'SHA-256' }, key, 256);
  return b64(new Uint8Array(bits));
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

const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : '')); };

// login
let r = await call('/api/auth/prelogin', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
const ch = await clientHash(PASSWORD, r.json.salt, r.json.iterations);
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
const secret = r.json.secret;
r = await call('/api/auth/enroll', { method: 'POST', body: JSON.stringify({ ticket: r.json.ticket, code: await totp(secret) }) });
check('ログイン + TOTP 登録', r.status === 200);
const recovery = r.json.recoveryCodes;

// TOTP re-login path (logout, password, mfa)
await call('/api/auth/logout', { method: 'POST' });
cookie = '';
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
check('2 回目以降は MFA ステップ', r.json.status === 'mfa', r.json.status);
r = await call('/api/auth/mfa', { method: 'POST', body: JSON.stringify({ ticket: r.json.ticket, code: await totp(secret) }) });
check('TOTP でログイン成功', r.status === 200 && r.json.status === 'ok', JSON.stringify(r.json));

// recovery code path
await call('/api/auth/logout', { method: 'POST' });
cookie = '';
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
r = await call('/api/auth/recovery', { method: 'POST', body: JSON.stringify({ ticket: r.json.ticket, code: recovery[0] }) });
check('リカバリコードでログイン', r.status === 200 && r.json.remainingRecoveryCodes === 7, JSON.stringify(r.json));
// used code cannot be reused
await call('/api/auth/logout', { method: 'POST' });
cookie = '';
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
const t2 = r.json.ticket;
r = await call('/api/auth/recovery', { method: 'POST', body: JSON.stringify({ ticket: t2, code: recovery[0] }) });
check('使用済みリカバリコードは再利用不可', r.status === 401, JSON.stringify(r.json));
r = await call('/api/auth/mfa', { method: 'POST', body: JSON.stringify({ ticket: t2, code: await totp(secret) }) });
check('復帰ログイン', r.status === 200);

// file upload + download
const fd = new FormData();
const pngHex =
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000a49444154789c63000100000500010d0a2db4000000' +
  '0049454e44ae426082';
const png = Buffer.from(pngHex, 'hex');
fd.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
r = await call('/api/files', { method: 'POST', body: fd });
check('ファイルアップロード', r.status === 201 && !!r.json.id, JSON.stringify(r.json));
const fileId = r.json.id;
const dl = await call('/api/files/' + fileId, { raw: true });
check('ファイル取得（認証付き）', dl.status === 200 && dl.headers.get('content-type') === 'image/png');
const noAuth = await fetch(BASE + '/api/files/' + fileId);
check('未認証ではファイルを取得できない', noAuth.status === 401, 'status=' + noAuth.status);

// chat streaming plumbing (bad key -> error event, message still persisted)
await call('/api/admin/secrets', { method: 'POST', body: JSON.stringify({ key: 'OPENROUTER_API_KEY', value: 'sk-or-v1-invalid-key-for-test-0000' }) });
r = await call('/api/rooms', { method: 'POST', body: JSON.stringify({ title: 'stream test' }) });
const roomId = r.json.room.id;
const res = await fetch(BASE + '/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ roomId, content: 'こんにちは', provider: 'openrouter', model: 'openai/gpt-4o-mini' }),
});
check('SSE レスポンス', res.headers.get('content-type')?.includes('text/event-stream'), res.headers.get('content-type'));
const events = [];
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    let ev = 'message', data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    events.push([ev, data]);
  }
}
check('meta イベント', events.some((e) => e[0] === 'meta'), JSON.stringify(events.map((e) => e[0])));
check('error イベント（不正キー）', events.some((e) => e[0] === 'error' && e[1].includes('プロバイダエラー')), (events.find((e) => e[0] === 'error') || [])[1]?.slice(0, 120));
check('done イベント', events.some((e) => e[0] === 'done'));

r = await call('/api/rooms/' + roomId);
check('ユーザー発言が保存される', r.json.messages.some((m) => m.role === 'user' && m.content === 'こんにちは'));
check('失敗した応答もエラー付きで保存される', r.json.messages.some((m) => m.role === 'assistant' && m.error));

// web search flag persists on the room
r = await call('/api/rooms/' + roomId, { method: 'PATCH', body: JSON.stringify({ webSearch: true }) });
r = await call('/api/rooms/' + roomId);
check('Web検索フラグの保存', r.json.room.webSearch === true);

// export
const exp = await call('/api/rooms/' + roomId + '/export', { raw: true });
check('JSON エクスポート', exp.status === 200 && exp.headers.get('content-disposition')?.includes('attachment'));

// static assets
const page = await fetch(BASE + '/');
const html = await page.text();
check('SPA が配信される', page.status === 200 && html.includes('hyperAI-chat'));
const csp = page.headers.get('content-security-policy');
check('CSP ヘッダ', !!csp && csp.includes("default-src 'self'"), csp?.slice(0, 60));
for (const asset of ['/app.js', '/styles.css', '/vendor/marked.js', '/vendor/purify.min.js', '/vendor/qrcode.js']) {
  const a = await fetch(BASE + asset);
  check('  資産 ' + asset, a.status === 200);
}

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2])); process.exit(1); }
