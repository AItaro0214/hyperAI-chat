import {
  b64encode,
  b64url,
  b64decode,
  hmacSha256,
  randomToken,
  sha256hex,
  timingSafeEqual,
} from './crypto.js';

export const SESSION_COOKIE = 'cft_sid';
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
export const MAX_FAILED_ATTEMPTS = 10;

export const now = () => Math.floor(Date.now() / 1000);

export function clientMeta(c) {
  return {
    ip: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || '',
    ua: (c.req.header('user-agent') || '').slice(0, 300),
  };
}

/* ------------------------------- users ---------------------------------- */
export function getUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(String(email || '').trim().toLowerCase()).first();
}

export function getUserById(env, id) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export async function logEvent(env, { email, kind, ok, detail, ip, ua }) {
  try {
    await env.DB.prepare(
      'INSERT INTO login_events (email, kind, ok, detail, ip, ua, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(email || null, kind, ok ? 1 : 0, detail || null, ip || null, ua || null, now())
      .run();
  } catch (e) {
    console.error('logEvent failed', e);
  }
}

export function isLocked(user) {
  return !!user && (user.locked_at != null || user.failed_attempts >= MAX_FAILED_ATTEMPTS);
}

// Returns the state after the failure so callers can report remaining attempts.
export async function registerFailure(env, user, kind, detail, meta) {
  const attempts = (user.failed_attempts || 0) + 1;
  const lock = attempts >= MAX_FAILED_ATTEMPTS;
  await env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_at = ?, updated_at = ? WHERE id = ?')
    .bind(attempts, lock ? now() : user.locked_at ?? null, now(), user.id)
    .run();
  await logEvent(env, { email: user.email, kind, ok: 0, detail, ...meta });
  if (lock && !user.locked_at) {
    await logEvent(env, { email: user.email, kind: 'lock', ok: 0, detail: 'attempts=' + attempts, ...meta });
  }
  return { attempts, locked: lock, remaining: Math.max(0, MAX_FAILED_ATTEMPTS - attempts) };
}

export async function clearFailures(env, user) {
  await env.DB.prepare(
    'UPDATE users SET failed_attempts = 0, locked_at = NULL, last_login_at = ?, updated_at = ? WHERE id = ?'
  )
    .bind(now(), now(), user.id)
    .run();
}

/* ----------------------------- short tickets ----------------------------
 * Stateless signed token used between the password step and the TOTP step.
 * ---------------------------------------------------------------------- */
export async function signTicket(env, payload, ttlSec = 300) {
  const body = { ...payload, exp: now() + ttlSec, jti: randomToken(8) };
  const raw = b64url(new TextEncoder().encode(JSON.stringify(body)));
  const sig = b64url(await hmacSha256(env.PW_PEPPER, 'ticket:' + raw));
  return raw + '.' + sig;
}

export async function verifyTicket(env, token, purpose) {
  if (!token || typeof token !== 'string') return null;
  const [raw, sig] = token.split('.');
  if (!raw || !sig) return null;
  const expected = b64url(await hmacSha256(env.PW_PEPPER, 'ticket:' + raw));
  if (!timingSafeEqual(sig, expected)) return null;
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(b64decode(raw)));
  } catch {
    return null;
  }
  if (!body || body.exp < now()) return null;
  if (purpose && body.purpose !== purpose) return null;
  return body;
}

/* ------------------------------- sessions ------------------------------- */
export async function createSession(env, user, meta) {
  const token = randomToken(32);
  const id = await sha256hex(token);
  const t = now();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, mfa_ok, created_at, expires_at, last_seen_at, ip, ua) VALUES (?, ?, 1, ?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, t, t + SESSION_TTL_SEC, t, meta?.ip || null, meta?.ua || null)
    .run();
  return token;
}

export async function resolveSession(env, token) {
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await env.DB.prepare(
    'SELECT s.*, u.email, u.is_admin, u.totp_enabled, u.locked_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
  )
    .bind(id)
    .first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  if (row.locked_at != null) return null;
  return row;
}

export async function touchSession(env, sessionId) {
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now(), sessionId).run();
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256hex(token)).run();
}

export async function destroyAllSessions(env, userId, exceptId) {
  if (exceptId) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(userId, exceptId).run();
  } else {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  }
}

export function maskSecret(value) {
  const v = String(value || '');
  if (v.length <= 10) return '*'.repeat(v.length);
  return v.slice(0, 6) + '...' + v.slice(-4);
}

export { b64encode };
