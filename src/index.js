import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveSession, touchSession, SESSION_COOKIE } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import roomRoutes from './routes/rooms.js';
import chatRoutes from './routes/chat.js';
import mediaRoutes from './routes/media.js';
import adminRoutes from './routes/admin.js';
import catalogRoutes from './routes/catalog.js';
import videoRoutes from './routes/video.js';
import exportRoutes from './routes/export.js';
import imageRoutes from './routes/images.js';
import agentRoutes from './routes/agent.js';
import artifactRoutes from './routes/artifacts.js';

// The Durable Object class the container binding runs against.
export { Sandbox } from '@cloudflare/sandbox';
export { AgentWorkflow } from './workflows/agent.js';

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Artifact previews ship their own sandbox policy and must stay framable
  // by this app, so the global deny is skipped for them.
  if (!c.res.headers.get('x-artifact')) c.header('X-Frame-Options', 'DENY');
});

// Session resolution for every /api route. Individual routers decide whether a
// session is required.
app.use('/api/*', sessionMiddleware);
app.use('/opencode/*', sessionMiddleware);
app.use('/preview/*', sessionMiddleware);

async function sessionMiddleware(c, next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await resolveSession(c.env, token);
    if (session) {
      c.set('session', session);
      c.set('userId', session.user_id);
      c.set('email', session.email);
      if (session.last_seen_at < Math.floor(Date.now() / 1000) - 300) {
        c.executionCtx.waitUntil(touchSession(c.env, session.id));
      }
    }
  }
  await next();
}

/* A room's preview app, served from our own domain so the URL is stable and
 * stays behind this app's login. */
app.all('/preview/:roomId/*', async (c) => {
  if (!c.get('session')) return c.text('unauthorized', 401);
  const { servePreview } = await import('./lib/preview.js');
  const roomId = c.req.param('roomId');
  const room = await c.env.DB.prepare('SELECT id FROM rooms WHERE id = ? AND user_id = ?')
    .bind(roomId, c.get('userId'))
    .first();
  if (!room) return c.text('not found', 404);
  const path = '/' + (c.req.param('*') || '');
  return servePreview(c.env, roomId, c.req.raw, path);
});
app.all('/preview/:roomId', (c) => c.redirect('/preview/' + c.req.param('roomId') + '/'));

/* The OpenCode web UI is proxied through here so it stays behind the app's own
 * login rather than being exposed on a public tunnel with the API key inside. */
app.all('/opencode/*', async (c) => {
  if (!c.get('session')) return c.text('unauthorized', 401);
  if (!c.env.Sandbox) return c.text('sandbox not configured', 503);
  const { sandboxFor } = await import('./lib/sandbox.js');
  const { proxyToOpencode, OPENCODE_PORT } = await import('./lib/opencode.js');
  const sandbox = sandboxFor(c.env, c.req.query('roomId'));
  return proxyToOpencode(c.req.raw, sandbox, { port: OPENCODE_PORT, url: 'http://localhost:' + OPENCODE_PORT });
});

app.route('/api/auth', authRoutes);
app.route('/api/rooms', roomRoutes);
app.route('/api', chatRoutes);
app.route('/api', mediaRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', catalogRoutes);
app.route('/api', videoRoutes);
app.route('/api', exportRoutes);
app.route('/api', imageRoutes);
app.route('/api', agentRoutes);
app.route('/api/artifacts', artifactRoutes);

app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('unhandled', err?.stack || err);
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  return c.json({ error: err?.message || 'internal error' }, status);
});

// Everything else falls through to the static assets binding (SPA).
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  async fetch(request, env, ctx) {
    // Sandbox preview URLs arrive on their own hostnames and must be handed
    // straight to the container before the app router sees them.
    if (env.Sandbox) {
      const { proxyToSandbox } = await import('@cloudflare/sandbox');
      const proxied = await proxyToSandbox(request, env).catch(() => null);
      if (proxied) return proxied;
    }
    return app.fetch(request, env, ctx);
  },

  /* Preview environments and generated media are deliberately disposable;
   * this is what disposes of them. Both run on the same three day window. */
  async scheduled(event, env, ctx) {
    const { reapExpired } = await import('./lib/preview.js');
    const { reapExpiredMedia, reapOrphanBlobs } = await import('./lib/media-retention.js');
    ctx.waitUntil(
      reapExpired(env)
        .then((rooms) => {
          if (rooms.length) console.log('reaped preview environments', rooms.join(', '));
        })
        .catch((e) => console.error('preview reap failed', e))
    );
    ctx.waitUntil(
      reapExpiredMedia(env)
        .then(({ count, bytes }) => {
          if (count) console.log('reaped media', count, 'files', Math.round(bytes / 1024) + 'KB');
          return reapOrphanBlobs(env);
        })
        .then(({ count }) => {
          if (count) console.log('reaped orphan blobs', count);
        })
        .catch((e) => console.error('media reap failed', e))
    );
  },
};
