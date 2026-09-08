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
