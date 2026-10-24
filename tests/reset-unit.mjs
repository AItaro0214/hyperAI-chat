/* Password reset by e-mail, end to end through the auth router.
 *
 * D1 is stood in for by node:sqlite running the real migrations, and the
 * send_email binding by a stub that keeps the mails, so the link a user would
 * click is the one taken out of the mail body. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import auth from '../src/routes/auth.js';
import { wrapClientHash } from '../src/lib/crypto.js';
import { RESET_MAX_PER_DAY, maskEmail } from '../src/lib/password-reset.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

/* ------------------------------ D1 stand-in ------------------------------ */
function d1(db) {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => ((args = a), stmt),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  };
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../migrations/0010_password_resets.sql', import.meta.url), 'utf8'));

const PEPPER = 'test-pepper';
const SALT = 'test-salt';
const EMAIL = 'owner@example.com';
const t0 = Math.floor(Date.now() / 1000);
db.prepare(
  'INSERT INTO users (id, email, pw_hash, pw_salt, totp_enabled, failed_attempts, locked_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 10, ?, ?, ?)'
).run('usr_1', EMAIL, await wrapClientHash(PEPPER, SALT, 'old-hash'), SALT, t0, t0, t0);
db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('s1', 'usr_1', t0, t0 + 999, t0);

const mails = [];
const env = {
  DB: d1(db),
  PW_PEPPER: PEPPER,
  MASTER_KEY: 'unused',
  APP_ORIGIN: 'https://chat.example.com',
  MAIL_FROM: 'noreply@notify.example.com',
  EMAIL: { send: async (m) => (mails.push(m), { messageId: 'm' + mails.length }) },
};

const post = async (path, body, e = env) => {
  const res = await auth.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, e);
  return { status: res.status, json: await res.json() };
};
const tokenOf = (mail) => (mail.text.match(/#reset=([\w-]+)/) || [])[1];

/* ------------------------------- request -------------------------------- */
const unknown = await post('/forgot', { email: 'stranger@example.com' });
const known = await post('/forgot', { email: 'Owner@Example.com ' });
check('未登録のアドレスにはメールを送らない', mails.length === 1, 'mails=' + mails.length);
check('  登録の有無で返事を変えない', unknown.status === 200 && unknown.json.message === known.json.message, unknown.json.message);
check('登録済みのアドレスには送る（大文字・空白を無視）', mails[0]?.to === EMAIL, mails[0]?.to);
check('  送信元は MAIL_FROM', mails[0]?.from === env.MAIL_FROM);
check('  リンクは APP_ORIGIN のフラグメント', /^https:\/\/chat\.example\.com\/#reset=[\w-]{40,}$/m.test(mails[0]?.text || ''));
check('  本文に有効期限と二要素認証のことが書いてある', /15 分/.test(mails[0].text) && /6桁/.test(mails[0].text));
const stored = db.prepare('SELECT id FROM password_resets').all();
check('DB にはトークンそのものを残さない', stored.length === 1 && stored[0].id !== tokenOf(mails[0]) && /^[0-9a-f]{64}$/.test(stored[0].id));

/* ------------------------------- check ---------------------------------- */
const token1 = tokenOf(mails[0]);
const peek = await post('/reset/check', { token: token1 });
check('リンクの確認で salt と回数を返す', peek.status === 200 && peek.json.salt === SALT && peek.json.iterations === 600000);
check('  アドレスは伏せて返す', peek.json.email === maskEmail(EMAIL) && peek.json.email === 'ow***@example.com', peek.json.email);
check('でたらめなトークンは無効', (await post('/reset/check', { token: 'nope' })).status === 400);

/* A newer mail retires the older link. */
await post('/forgot', { email: EMAIL });
const token2 = tokenOf(mails[1]);
check('新しいメールを送ると古いリンクは使えない', (await post('/reset/check', { token: token1 })).status === 400);
check('  新しいリンクは使える', (await post('/reset/check', { token: token2 })).status === 200);

/* -------------------------------- reset --------------------------------- */
const done = await post('/reset', { token: token2, clientHash: 'new-hash' });
check('新しいパスワードを設定できる', done.status === 200 && done.json.ok === true, JSON.stringify(done.json));
const user = db.prepare('SELECT * FROM users WHERE id = ?').get('usr_1');
check('  ハッシュが新しいパスワードのものになる', user.pw_hash === (await wrapClientHash(PEPPER, SALT, 'new-hash')));
check('  ロックと失敗回数が解除される', user.locked_at === null && user.failed_attempts === 0);
check('  二要素認証はそのまま', user.totp_enabled === 1);
check('  他の端末のセッションは切れる', db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === 0);
check('同じリンクは2回使えない', (await post('/reset', { token: token2, clientHash: 'again' })).status === 400);

const login = await post('/login', { email: EMAIL, clientHash: 'new-hash' });
check('新しいパスワードでログインすると二要素認証に進む', login.status === 200 && login.json.status === 'mfa', JSON.stringify(login.json).slice(0, 80));
const old = await post('/login', { email: EMAIL, clientHash: 'old-hash' });
check('古いパスワードでは入れない', old.status === 401);

/* ------------------------------- expiry --------------------------------- */
db.exec('DELETE FROM password_resets');
await post('/forgot', { email: EMAIL });
db.exec('UPDATE password_resets SET expires_at = ' + (t0 - 1));
check('期限切れのリンクは無効', (await post('/reset', { token: tokenOf(mails.at(-1)), clientHash: 'x' })).status === 400);

/* ----------------------------- daily limit ------------------------------ */
db.exec('DELETE FROM password_resets');
const before = mails.length;
for (let i = 0; i < RESET_MAX_PER_DAY + 2; i++) await post('/forgot', { email: EMAIL });
check('1日に送るのは ' + RESET_MAX_PER_DAY + ' 通まで', mails.length - before === RESET_MAX_PER_DAY, String(mails.length - before));
const limited = db.prepare("SELECT COUNT(*) AS n FROM login_events WHERE kind = 'pw_reset' AND detail = 'daily limit'").get().n;
check('  上限に達したことを記録する', limited === 2, String(limited));

/* ---------------------------- send failures ----------------------------- */
db.exec('DELETE FROM password_resets');
const failing = { ...env, EMAIL: { send: async () => { throw Object.assign(new Error('no'), { code: 'E_SENDER_NOT_VERIFIED' }); } } };
const failed = await post('/forgot', { email: EMAIL }, failing);
check('送信に失敗しても同じ返事をする', failed.status === 200 && failed.json.message === known.json.message);
const failLog = db.prepare("SELECT detail FROM login_events WHERE kind = 'pw_reset' ORDER BY id DESC LIMIT 1").get();
check('  失敗の理由を記録する', /E_SENDER_NOT_VERIFIED/.test(failLog.detail), failLog.detail);
const noBinding = await post('/forgot', { email: EMAIL }, { ...env, EMAIL: undefined });
check('送信の設定が無くても落ちない', noBinding.status === 200);

const failedCount = results.filter((r) => !r[0]).length;
console.log('\n' + (results.length - failedCount) + '/' + results.length + ' passed');
process.exit(failedCount ? 1 : 0);
