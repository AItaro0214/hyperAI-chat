import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';

const artifacts = new Hono();
artifacts.use('*', requireAuth);

const MAX_BYTES = 400 * 1024;

/**
 * Artifacts run their own scripts, so they are served from a dedicated route
 * with a policy that permits inline code but blocks every outbound request.
 * Only this app may frame them.
 */
/*
 * Generated pages almost always pull React, Tailwind or a chart library from a
 * CDN, so a network-free policy simply renders them blank. The iframe is
 * sandboxed WITHOUT allow-same-origin, which is what actually protects the app:
 * the page runs in an opaque origin and cannot reach this site's cookies,
 * storage or DOM whatever it loads. `?strict=1` restores the offline policy.
 */
const OPEN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  'img-src https: data: blob:',
  'font-src https: data:',
  'media-src https: data: blob:',
  'connect-src https:',
  'frame-src https: data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const STRICT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

function wrapDocument(content, kind, title) {
  const trimmed = String(content || '').trim();
  if (kind === 'svg' || /^<svg[\s>]/i.test(trimmed)) {
    return (
      '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      escapeHtml(title || 'artifact') +
      '</title><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100%}</style>' +
      '</head><body>' +
      trimmed +
      '</body></html>'
    );
  }
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return trimmed;
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHtml(title || 'artifact') +
    '</title></head><body>' +
    trimmed +
    '</body></html>'
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

artifacts.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const content = String(body.content || '');
  if (!content.trim()) return c.json({ error: 'content が必要です' }, 400);
  if (content.length > MAX_BYTES) return c.json({ error: 'コードが大きすぎます（上限 400KB）' }, 413);

  const kind = body.kind === 'svg' ? 'svg' : 'html';
  const id = newId('art');
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO artifacts (id, user_id, room_id, message_id, title, kind, content, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      id,
      c.get('userId'),
      body.roomId || null,
      body.messageId || null,
      String(body.title || '無題のアーティファクト').slice(0, 120),
      kind,
      content,
      t,
      t
    )
    .run();
  return c.json({ artifact: { id, kind, url: '/api/artifacts/' + id + '/raw', createdAt: t } }, 201);
});

artifacts.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, room_id, message_id, title, kind, length(content) AS size, created_at FROM artifacts ' +
      'WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(c.get('userId'))
    .all();
  return c.json({ artifacts: results || [] });
});

artifacts.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.get('userId'))
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({
    artifact: {
      id: row.id,
      title: row.title,
      kind: row.kind,
      content: row.content,
      roomId: row.room_id,
      messageId: row.message_id,
      createdAt: row.created_at,
    },
  });
});

artifacts.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const row = await c.env.DB.prepare('SELECT id FROM artifacts WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.get('userId'))
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  const content = String(body.content || '');
  if (content.length > MAX_BYTES) return c.json({ error: 'コードが大きすぎます（上限 400KB）' }, 413);
  await c.env.DB.prepare('UPDATE artifacts SET content = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?')
    .bind(content, body.title ? String(body.title).slice(0, 120) : null, now(), row.id)
    .run();
  return c.json({ ok: true });
});

artifacts.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM artifacts WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('userId')).run();
  return c.json({ ok: true });
});

artifacts.get('/:id/raw', async (c) => {
  const row = await c.env.DB.prepare('SELECT title, kind, content FROM artifacts WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), c.get('userId'))
    .first();
  if (!row) return c.text('not found', 404);
  return new Response(wrapDocument(row.content, row.kind, row.title), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': c.req.query('strict') === '1' ? STRICT_CSP : OPEN_CSP,
      'x-frame-options': 'SAMEORIGIN',
      'cache-control': 'private, no-store',
      'x-artifact': '1',
    },
  });
});

export default artifacts;
