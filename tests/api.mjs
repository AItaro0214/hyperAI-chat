import { webcrypto as crypto } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const EMAIL = process.env.TEST_EMAIL || 'owner@example.com';
const PASSWORD = process.env.TEST_PASSWORD || 'change-me';
const te = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64');

let cookie = '';
async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
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
  const code = (((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff)) % 1000000;
  return String(code).padStart(6, '0');
}

const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : '')); };

// 1. unauthenticated access is rejected
let r = await call('/api/rooms');
check('未認証は 401', r.status === 401, 'status=' + r.status);

// 2. prelogin
r = await call('/api/auth/prelogin', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
check('prelogin が salt を返す', r.status === 200 && !!r.json.salt, JSON.stringify(r.json));
const { salt, iterations } = r.json;

// 2b. unknown email gets a decoy salt (no enumeration)
const decoy = await call('/api/auth/prelogin', { method: 'POST', body: JSON.stringify({ email: 'nobody@example.com' }) });
check('未知アドレスでも salt を返す（列挙防止）', decoy.status === 200 && !!decoy.json.salt && decoy.json.salt !== salt);

// 3. wrong password
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: 'wrong' }) });
check('誤パスワードは 401 + 残り回数', r.status === 401 && r.json.remaining === 9, JSON.stringify(r.json));

// 4. correct password -> enrollment required
const ch = await clientHash(PASSWORD, salt, iterations);
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
check('正しいパスワードで TOTP 登録へ', r.status === 200 && r.json.status === 'enroll' && !!r.json.secret, r.json.status);
const ticket = r.json.ticket;
const secret = r.json.secret;
check('otpauth URI が生成される', String(r.json.uri || '').startsWith('otpauth://totp/'));

// 5. bad TOTP code
r = await call('/api/auth/enroll', { method: 'POST', body: JSON.stringify({ ticket, code: '000000' }) });
check('誤コードは拒否', r.status === 401, JSON.stringify(r.json));

// 6. good TOTP code
r = await call('/api/auth/enroll', { method: 'POST', body: JSON.stringify({ ticket, code: await totp(secret) }) });
check('正しいコードで登録完了 + リカバリコード', r.status === 200 && r.json.recoveryCodes?.length === 8, JSON.stringify(r.json).slice(0, 120));
const recoveryCodes = r.json.recoveryCodes || [];
check('セッション Cookie が発行される', cookie.startsWith('cft_sid='));

// 7. me
r = await call('/api/auth/me');
check('/auth/me が本人を返す', r.status === 200 && r.json.email === EMAIL && r.json.totpEnabled === true, JSON.stringify(r.json));

// 8. rooms CRUD
r = await call('/api/rooms', { method: 'POST', body: JSON.stringify({ title: 'テスト' }) });
const roomId = r.json.room?.id;
check('ルーム作成', r.status === 201 && !!roomId, roomId);
r = await call('/api/rooms');
check('ルーム一覧', r.status === 200 && r.json.rooms.length >= 1);
r = await call('/api/rooms/' + roomId, { method: 'PATCH', body: JSON.stringify({ model: 'openai/gpt-4o-mini', provider: 'openrouter' }) });
check('ルーム更新（モデル切替）', r.status === 200);

// 9. models catalog (OpenRouter list needs no key)
r = await call('/api/models');
const models = r.json.models || [];
check('モデル一覧取得', r.status === 200 && models.length > 50, models.length + ' models');
for (const fam of ['GPT', 'Claude', 'Gemini', 'Qwen', 'Kimi', 'GLM']) {
  check('  ファミリー ' + fam + ' を含む', models.some((m) => m.family === fam), String(models.filter((m) => m.family === fam).length) + ' 件');
}
check('  画像入力対応モデルがある', models.some((m) => (m.input || []).includes('image')));
check('  画像出力対応モデルがある', models.some((m) => (m.output || []).includes('image')));

// 10. pricing
r = await call('/api/pricing');
check('料金 API', r.status === 200 && r.json.tools?.web_plugin_exa?.price_per_request === 0.007, JSON.stringify(r.json.tools?.web_plugin_exa || {}).slice(0, 80));
const priced = (r.json.models || []).filter((m) => m.pricing?.input_per_m > 0);
check('  1M トークン単価が入っている', priced.length > 50, priced.length + ' models');

// 11. admin
r = await call('/api/admin/secrets');
const keyNames = (r.json.secrets || []).map((s) => s.key);
check('管理: シークレット一覧', r.status === 200 && keyNames.length === 3, JSON.stringify(keyNames));
check('  Gemini のキー枠がある', keyNames.includes('GEMINI_API_KEY'));
r = await call('/api/admin/secrets', { method: 'POST', body: JSON.stringify({ key: 'OPENROUTER_API_KEY', value: 'sk-or-v1-testtesttest1234' }) });
check('管理: キー保存（暗号化）', r.status === 200 && r.json.secrets[0].hint?.includes('...'), JSON.stringify(r.json.secrets[0]));
check('  平文は返らない', !JSON.stringify(r.json).includes('testtesttest1234'));
r = await call('/api/admin/settings', { method: 'POST', body: JSON.stringify({ temperature: 0.5, defaultModel: 'anthropic/claude-sonnet-4.5' }) });
check('管理: 既定設定の保存', r.status === 200 && r.json.settings.temperature === 0.5);
r = await call('/api/admin/account');
check('管理: アカウント情報', r.status === 200 && r.json.account.maxFailedAttempts === 10, 'failed=' + r.json.account.failedAttempts);
r = await call('/api/admin/events');
check('管理: 監査ログ', r.status === 200 && r.json.events.length > 0, r.json.events.length + ' 件');

// 12. chat without a real key -> clear error
r = await call('/api/chat', { method: 'POST', body: JSON.stringify({ roomId, content: 'hello', provider: 'groq' }) });
check('APIキー未設定時は分かりやすいエラー', r.status === 400 && String(r.json.error).includes('GROQ_API_KEY'), JSON.stringify(r.json));

// 13. logout, then lockout behaviour
await call('/api/auth/logout', { method: 'POST' });
cookie = '';
r = await call('/api/auth/me');
check('ログアウト後は 401', r.status === 401);

// 14. lockout after 10 failures
let lockStatus = 0, lastBody = null;
for (let i = 0; i < 11; i++) {
  const res = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: 'bad' + i }) });
  lockStatus = res.status; lastBody = res.json;
}
check('10 回失敗でアカウントロック（423）', lockStatus === 423 && lastBody.locked === true, JSON.stringify(lastBody));
r = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, clientHash: ch }) });
check('ロック中は正しいパスワードでも拒否', r.status === 423, JSON.stringify(r.json));

console.log('');
const failed = results.filter((r) => !r[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2])); process.exit(1); }
