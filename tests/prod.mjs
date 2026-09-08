// Production smoke test. Deliberately does NOT complete TOTP enrollment (the
// account owner must do that with their own authenticator) and does not
// exercise the lockout path.

const BASE = process.env.BASE || 'https://chat.example.com';
const EMAIL = process.env.TEST_EMAIL || 'owner@example.com';
const results = [];
const check = (n, ok, extra = '') => {
  results.push([ok, n, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + n + (extra ? ' :: ' + extra : ''));
};

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, headers: res.headers };
}

let r = await call('/api/health');
check('health', r.status === 200 && r.json.ok);

r = await call('/api/rooms');
check('未認証 API は 401', r.status === 401);

r = await call('/api/auth/prelogin', { method: 'POST', body: JSON.stringify({ email: EMAIL }) });
check('prelogin（本番 D1 にユーザーが存在）', r.status === 200 && r.json.iterations === 600000, JSON.stringify(r.json));

// The account password is changed by the owner after setup, so this smoke test
// deliberately does not attempt a login: a wrong guess would eat into the
// 10-attempt lockout budget.
const page = await fetch(BASE + '/');
const html = await page.text();
check('SPA 配信', page.status === 200 && html.includes('hyperAI-chat'));
check('HTTPS + CSP', !!page.headers.get('content-security-policy'));
for (const a of ['/app.js', '/styles.css', '/vendor/marked.js', '/vendor/qrcode.js', '/vendor/purify.min.js']) {
  const res = await fetch(BASE + a);
  check('  資産 ' + a, res.status === 200);
}

console.log('');
const failed = results.filter((x) => !x[0]);
console.log(results.length - failed.length + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
