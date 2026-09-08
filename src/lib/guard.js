export async function requireAuth(c, next) {
  const session = c.get('session');
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return next();
}

export async function requireAdmin(c, next) {
  const session = c.get('session');
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  if (!session.is_admin) return c.json({ error: 'forbidden' }, 403);
  return next();
}

/** Coarse per-IP throttle backed by KV. Used on unauthenticated auth routes. */
export async function throttle(c, bucket, limit, windowSec) {
  if (!c.env.KV) return true;
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const key = 'rl:' + bucket + ':' + ip + ':' + slot;
  const current = Number((await c.env.KV.get(key)) || 0) + 1;
  await c.env.KV.put(key, String(current), { expirationTtl: Math.max(60, windowSec * 2) });
  return current <= limit;
}
