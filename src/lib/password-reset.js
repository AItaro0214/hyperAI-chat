/* Password reset by e-mail.
 *
 * A reset only replaces the password. TOTP stays required at the next login,
 * so someone who controls the mailbox alone still cannot get in. The link is
 * single use, expires after RESET_TTL_SEC, and an account receives at most
 * RESET_MAX_PER_DAY mails a day so the mailbox cannot be flooded. */

import { randomToken, sha256hex } from './crypto.js';
import { now } from './auth.js';

export const RESET_TTL_SEC = 15 * 60;
export const RESET_MAX_PER_DAY = 3;

/** Issues a token for the user. Returns null when today's allowance is used up. */
export async function createResetToken(env, user, meta) {
  const t = now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?')
    .bind(user.id, t - 86400)
    .first();
  if ((recent?.n || 0) >= RESET_MAX_PER_DAY) return null;

  const token = randomToken(32);
  // An older link stops working once a newer one is sent.
  await env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(t, user.id).run();
  await env.DB.prepare('INSERT INTO password_resets (id, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256hex(token), user.id, t, t + RESET_TTL_SEC, meta?.ip || null)
    .run();
  return token;
}

/** The user a still-valid token belongs to, without using it up. */
export async function peekResetToken(env, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  return env.DB.prepare(
    'SELECT u.* FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.used_at IS NULL AND r.expires_at > ?'
  )
    .bind(await sha256hex(token), now())
    .first();
}

/** Marks the token used and returns its user. Only one caller can win. */
export async function consumeResetToken(env, token) {
  const user = await peekResetToken(env, token);
  if (!user) return null;
  const res = await env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
    .bind(now(), await sha256hex(token), now())
    .run();
  return res?.meta?.changes === 1 ? user : null;
}

/** "ab***@example.com", enough for the user to recognise their own address. */
export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return local.slice(0, 2) + '***@' + domain;
}

export function resetMail({ to, from, link, appName }) {
  const minutes = Math.round(RESET_TTL_SEC / 60);
  return {
    to,
    from,
    subject: '【' + appName + '】パスワードの再設定',
    text: [
      appName + ' のパスワード再設定の依頼を受け付けました。',
      '',
      '下のリンクを開いて、新しいパスワードを決めてください。',
      link,
      '',
      'リンクの有効期限は ' + minutes + ' 分で、1回だけ使えます。',
      '再設定した後も、ログインには認証アプリの6桁のコードが必要です。',
      '',
      'このメールに心当たりがない場合は、何もせずに削除してください。パスワードは変わりません。',
    ].join('\n'),
  };
}
