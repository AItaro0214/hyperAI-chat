import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import {
  PW_ALGO,
  PW_ITER,
  decoySalt,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  seal,
  timingSafeEqual,
  totpUri,
  totpVerify,
  unseal,
  wrapClientHash,
} from '../lib/crypto.js';
import {
  MAX_FAILED_ATTEMPTS,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  clearFailures,
  clientMeta,
  createSession,
  destroyAllSessions,
  destroySession,
  getUserByEmail,
  getUserById,
  isLocked,
  logEvent,
  now,
  registerFailure,
  signTicket,
  verifyTicket,
} from '../lib/auth.js';
import { requireAuth, throttle } from '../lib/guard.js';
import { APP_NAME } from '../lib/branding.js';
import { consumeResetToken, createResetToken, maskEmail, peekResetToken, resetMail } from '../lib/password-reset.js';

const auth = new Hono();

function setSessionCookie(c, token) {
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
}

async function finishLogin(c, user) {
  const meta = clientMeta(c);
  const token = await createSession(c.env, user, meta);
  await clearFailures(c.env, user);
  setSessionCookie(c, token);
  await logEvent(c.env, { email: user.email, kind: 'login', ok: 1, ...meta });
}

/* ------------------------------ prelogin -------------------------------- */
// Hands the browser the KDF parameters. Unknown addresses get a stable decoy
// salt so this cannot be used to test whether an account exists.
auth.post('/prelogin', async (c) => {
  if (!(await throttle(c, 'prelogin', 60, 300))) return c.json({ error: 'リクエストが多すぎます' }, 429);
  const { email } = await c.req.json().catch(() => ({}));
  if (!email) return c.json({ error: 'email required' }, 400);
  const user = await getUserByEmail(c.env, email);
  const salt = user ? user.pw_salt : await decoySalt(c.env.PW_PEPPER, email);
  return c.json({ salt, iterations: user?.pw_iter || PW_ITER, algo: user?.pw_algo || PW_ALGO });
});

/* -------------------------------- login --------------------------------- */
auth.post('/login', async (c) => {
  if (!(await throttle(c, 'login', 30, 300))) return c.json({ error: 'リクエストが多すぎます' }, 429);
  const meta = clientMeta(c);
  const { email, clientHash } = await c.req.json().catch(() => ({}));
  if (!email || !clientHash) return c.json({ error: 'email と clientHash が必要です' }, 400);

  const user = await getUserByEmail(c.env, email);
  if (!user) {
    await logEvent(c.env, { email, kind: 'password', ok: 0, detail: 'unknown user', ...meta });
    // Constant-ish work so a missing account is not obviously faster.
    await wrapClientHash(c.env.PW_PEPPER, 'decoy', String(clientHash));
    return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401);
  }
  if (isLocked(user)) {
    await logEvent(c.env, { email, kind: 'password', ok: 0, detail: 'locked', ...meta });
    return c.json({ error: 'アカウントがロックされています。管理者による解除が必要です。', locked: true }, 423);
  }

  const candidate = await wrapClientHash(c.env.PW_PEPPER, user.pw_salt, String(clientHash));
  if (!timingSafeEqual(candidate, user.pw_hash)) {
    const state = await registerFailure(c.env, user, 'password', 'bad password', meta);
    return c.json(
      {
        error: 'メールアドレスまたはパスワードが違います',
        remaining: state.remaining,
        locked: state.locked,
      },
      state.locked ? 423 : 401
    );
  }

  if (!user.totp_enabled) {
    const secret = newTotpSecret();
    const ticket = await signTicket(c.env, { purpose: 'enroll', uid: user.id, secret }, 900);
    return c.json({
      status: 'enroll',
      ticket,
      secret,
      uri: totpUri(secret, user.email),
      message: '二要素認証（TOTP）の登録が必要です。',
    });
  }

  const ticket = await signTicket(c.env, { purpose: 'mfa', uid: user.id }, 300);
  return c.json({ status: 'mfa', ticket });
});

/* ---------------------------- TOTP enrollment --------------------------- */
auth.post('/enroll', async (c) => {
  const meta = clientMeta(c);
  const { ticket, code } = await c.req.json().catch(() => ({}));
  const body = await verifyTicket(c.env, ticket, 'enroll');
  if (!body) return c.json({ error: 'セッションの有効期限が切れました。もう一度ログインしてください。' }, 401);
  const user = await getUserById(c.env, body.uid);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (isLocked(user)) return c.json({ error: 'アカウントがロックされています', locked: true }, 423);

  if (!(await totpVerify(body.secret, code))) {
    const state = await registerFailure(c.env, user, 'totp', 'enroll code mismatch', meta);
    return c.json({ error: '認証コードが正しくありません', remaining: state.remaining, locked: state.locked }, state.locked ? 423 : 401);
  }

  const codes = newRecoveryCodes(8);
  const hashed = await Promise.all(codes.map((x) => hashRecoveryCode(c.env.PW_PEPPER, x)));
  await c.env.DB.prepare(
    'UPDATE users SET totp_secret_enc = ?, totp_enabled = 1, recovery_codes = ?, updated_at = ? WHERE id = ?'
  )
    .bind(await seal(c.env.MASTER_KEY, body.secret), JSON.stringify(hashed), now(), user.id)
    .run();
  await logEvent(c.env, { email: user.email, kind: 'totp', ok: 1, detail: 'enrolled', ...meta });
  await finishLogin(c, user);
  return c.json({ status: 'ok', recoveryCodes: codes });
});

/* ------------------------------- TOTP step ------------------------------ */
auth.post('/mfa', async (c) => {
  if (!(await throttle(c, 'mfa', 40, 300))) return c.json({ error: 'リクエストが多すぎます' }, 429);
  const meta = clientMeta(c);
  const { ticket, code } = await c.req.json().catch(() => ({}));
  const body = await verifyTicket(c.env, ticket, 'mfa');
  if (!body) return c.json({ error: 'セッションの有効期限が切れました。もう一度ログインしてください。' }, 401);
  const user = await getUserById(c.env, body.uid);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (isLocked(user)) return c.json({ error: 'アカウントがロックされています', locked: true }, 423);

  const secret = await unseal(c.env.MASTER_KEY, user.totp_secret_enc);
  if (!secret || !(await totpVerify(secret, code))) {
    const state = await registerFailure(c.env, user, 'totp', 'bad code', meta);
    return c.json({ error: '認証コードが正しくありません', remaining: state.remaining, locked: state.locked }, state.locked ? 423 : 401);
  }
  await finishLogin(c, user);
  return c.json({ status: 'ok' });
});

/* ---------------------------- recovery codes ---------------------------- */
auth.post('/recovery', async (c) => {
  if (!(await throttle(c, 'recovery', 20, 600))) return c.json({ error: 'リクエストが多すぎます' }, 429);
  const meta = clientMeta(c);
  const { ticket, code } = await c.req.json().catch(() => ({}));
  const body = await verifyTicket(c.env, ticket, 'mfa');
  if (!body) return c.json({ error: 'セッションの有効期限が切れました。もう一度ログインしてください。' }, 401);
  const user = await getUserById(c.env, body.uid);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (isLocked(user)) return c.json({ error: 'アカウントがロックされています', locked: true }, 423);

  let stored = [];
  try {
    stored = JSON.parse(user.recovery_codes || '[]');
  } catch {
    stored = [];
  }
  const hash = await hashRecoveryCode(c.env.PW_PEPPER, code);
  const idx = stored.findIndex((h) => timingSafeEqual(h, hash));
  if (idx < 0) {
    const state = await registerFailure(c.env, user, 'recovery', 'bad recovery code', meta);
    return c.json({ error: 'リカバリコードが正しくありません', remaining: state.remaining, locked: state.locked }, state.locked ? 423 : 401);
  }
  stored.splice(idx, 1);
  await c.env.DB.prepare('UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(stored), now(), user.id)
    .run();
  await logEvent(c.env, { email: user.email, kind: 'recovery', ok: 1, detail: 'remaining=' + stored.length, ...meta });
  await finishLogin(c, user);
  return c.json({ status: 'ok', remainingRecoveryCodes: stored.length });
});

/* ---------------------------- password reset ---------------------------- */
// The answer is the same whether or not the address is registered, so this
// cannot be used to find out which addresses have an account.
const FORGOT_REPLY = '登録済みのアドレスであれば、再設定用のリンクを送りました。メールを確認してください。';

auth.post('/forgot', async (c) => {
  if (!(await throttle(c, 'forgot', 5, 3600))) return c.json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' }, 429);
  const meta = clientMeta(c);
  const { email } = await c.req.json().catch(() => ({}));
  if (!email) return c.json({ error: 'メールアドレスを入力してください' }, 400);

  const user = await getUserByEmail(c.env, email);
  if (!user) {
    await logEvent(c.env, { email, kind: 'pw_reset', ok: 0, detail: 'unknown user', ...meta });
    return c.json({ ok: true, message: FORGOT_REPLY });
  }
  if (!c.env.EMAIL || !c.env.MAIL_FROM) {
    await logEvent(c.env, { email: user.email, kind: 'pw_reset', ok: 0, detail: 'mail not configured', ...meta });
    return c.json({ ok: true, message: FORGOT_REPLY });
  }
  const token = await createResetToken(c.env, user, meta);
  if (!token) {
    await logEvent(c.env, { email: user.email, kind: 'pw_reset', ok: 0, detail: 'daily limit', ...meta });
    return c.json({ ok: true, message: FORGOT_REPLY });
  }

  // The token rides in the fragment, which browsers never send to a server
  // or put in a Referer header.
  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  try {
    await c.env.EMAIL.send(resetMail({ to: user.email, from: c.env.MAIL_FROM, link: origin + '/#reset=' + token, appName: APP_NAME }));
    await logEvent(c.env, { email: user.email, kind: 'pw_reset', ok: 1, detail: 'mail sent', ...meta });
  } catch (e) {
    console.error('reset mail failed', e?.code, e?.message);
    await logEvent(c.env, { email: user.email, kind: 'pw_reset', ok: 0, detail: 'mail failed: ' + (e?.code || e?.message || e), ...meta });
  }
  return c.json({ ok: true, message: FORGOT_REPLY });
});

// Lets the page check the link and fetch the KDF parameters before asking for
// a new password. Does not use the token up.
auth.post('/reset/check', async (c) => {
  if (!(await throttle(c, 'reset', 30, 600))) return c.json({ error: 'リクエストが多すぎます' }, 429);
  const { token } = await c.req.json().catch(() => ({}));
  const user = await peekResetToken(c.env, token);
  if (!user) return c.json({ error: 'このリンクは無効か、有効期限が切れています。もう一度メールを送ってください。' }, 400);
  return c.json({ ok: true, email: maskEmail(user.email), salt: user.pw_salt, iterations: user.pw_iter || PW_ITER });
});

auth.post('/reset', async (c) => {
  if (!(await throttle(c, 'reset', 30, 600))) return c.json({ error: 'リクエストが多すぎます' }, 429);
  const meta = clientMeta(c);
  const { token, clientHash } = await c.req.json().catch(() => ({}));
  if (!token || !clientHash) return c.json({ error: 'パラメータが不足しています' }, 400);
  const user = await consumeResetToken(c.env, token);
  if (!user) return c.json({ error: 'このリンクは無効か、有効期限が切れています。もう一度メールを送ってください。' }, 400);

  // Proving the mailbox is also how a locked account gets back in, the same
  // as `npm run unlock`. TOTP is still asked for at the next login.
  const hash = await wrapClientHash(c.env.PW_PEPPER, user.pw_salt, String(clientHash));
  await c.env.DB.prepare(
    'UPDATE users SET pw_hash = ?, pw_changed_at = ?, failed_attempts = 0, locked_at = NULL, updated_at = ? WHERE id = ?'
  )
    .bind(hash, now(), now(), user.id)
    .run();
  await destroyAllSessions(c.env, user.id);
  await logEvent(c.env, { email: user.email, kind: 'pw_reset', ok: 1, detail: 'password replaced', ...meta });
  return c.json({ ok: true });
});

/* --------------------------------- misc --------------------------------- */
auth.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const session = c.get('session');
  await destroySession(c.env, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  if (session) await logEvent(c.env, { email: session.email, kind: 'logout', ok: 1, ...clientMeta(c) });
  return c.json({ ok: true });
});

auth.get('/me', requireAuth, async (c) => {
  const session = c.get('session');
  const user = await getUserById(c.env, session.user_id);
  let recovery = [];
  try {
    recovery = JSON.parse(user.recovery_codes || '[]');
  } catch {
    recovery = [];
  }
  return c.json({
    email: user.email,
    isAdmin: !!user.is_admin,
    totpEnabled: !!user.totp_enabled,
    lastLoginAt: user.last_login_at,
    pwChangedAt: user.pw_changed_at,
    recoveryCodesLeft: recovery.length,
    maxFailedAttempts: MAX_FAILED_ATTEMPTS,
  });
});

export default auth;
