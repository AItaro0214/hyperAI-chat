import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { getSettings } from '../lib/store.js';

const rooms = new Hono();
rooms.use('*', requireAuth);

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function shapeMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning || null,
    provider: row.provider,
    model: row.model,
    attachments: parseJson(row.attachments, []),
    annotations: parseJson(row.annotations, []),
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cost: row.cost,
    meta: row.meta && row.meta.length > 20000 ? { truncated: true } : parseJson(row.meta, null),
    error: row.error || null,
    createdAt: row.created_at,
  };
}

async function ownedRoom(c, id) {
  const row = await c.env.DB.prepare('SELECT * FROM rooms WHERE id = ? AND user_id = ?').bind(id, c.get('userId')).first();
  return row || null;
}

rooms.get('/', async (c) => {
  const includeArchived = c.req.query('archived') === '1';
  const sql = includeArchived
    ? 'SELECT * FROM rooms WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT 500'
    : 'SELECT * FROM rooms WHERE user_id = ? AND archived = 0 ORDER BY pinned DESC, updated_at DESC LIMIT 500';
  const { results } = await c.env.DB.prepare(sql).bind(c.get('userId')).all();
  const counts = await c.env.DB.prepare(
    'SELECT room_id, COUNT(*) AS n FROM messages WHERE user_id = ? GROUP BY room_id'
  )
    .bind(c.get('userId'))
    .all();
  const byRoom = Object.fromEntries((counts.results || []).map((r) => [r.room_id, r.n]));
  return c.json({
    rooms: (results || []).map((r) => ({
      id: r.id,
      title: r.title,
      provider: r.provider,
      model: r.model,
      systemPrompt: r.system_prompt,
      webSearch: !!r.web_search,
      imageOutput: r.image_output === null || r.image_output === undefined ? true : !!r.image_output,
      webSearchEngine: r.web_search_engine,
      imageMode: r.image_mode,
      reasoningEffort: r.reasoning_effort,
      temperature: r.temperature,
      maxTokens: r.max_tokens,
      pinned: !!r.pinned,
      archived: !!r.archived,
      totalCost: r.total_cost,
      messageCount: byRoom[r.id] || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

rooms.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = await getSettings(c.env);
  const id = newId('room');
  const t = now();
  await c.env.DB.prepare(
    'INSERT INTO rooms (id, user_id, title, provider, model, system_prompt, web_search, image_output, temperature, max_tokens, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      id,
      c.get('userId'),
      (body.title || '新しいトークルーム').slice(0, 120),
      body.provider || settings.defaultProvider,
      body.model || settings.defaultModel,
      body.systemPrompt ?? settings.systemPrompt ?? '',
      (body.webSearch ?? settings.webSearchDefault) ? 1 : 0,
      (body.imageOutput ?? settings.imageDefault) ? 1 : 0,
      numOrNull(body.temperature ?? settings.temperature),
      numOrNull(body.maxTokens ?? settings.maxTokens),
      t,
      t
    )
    .run();
  const room = await ownedRoom(c, id);
  return c.json({ room: { id: room.id, title: room.title, provider: room.provider, model: room.model } }, 201);
});

rooms.get('/:id', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC, rowid ASC')
    .bind(room.id)
    .all();
  return c.json({
    room: {
      id: room.id,
      title: room.title,
      provider: room.provider,
      model: room.model,
      systemPrompt: room.system_prompt,
      webSearch: !!room.web_search,
      imageOutput: room.image_output === null || room.image_output === undefined ? true : !!room.image_output,
      webSearchEngine: room.web_search_engine,
      imageMode: room.image_mode,
      reasoningEffort: room.reasoning_effort,
      searchSettings: parseJson(room.search_settings, null),
      temperature: room.temperature,
      maxTokens: room.max_tokens,
      pinned: !!room.pinned,
      archived: !!room.archived,
      totalCost: room.total_cost,
      createdAt: room.created_at,
      updatedAt: room.updated_at,
    },
    messages: (results || []).map(shapeMessage),
  });
});

rooms.patch('/:id', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const fields = [];
  const values = [];
  const map = {
    title: 'title',
    provider: 'provider',
    model: 'model',
    systemPrompt: 'system_prompt',
    temperature: 'temperature',
    maxTokens: 'max_tokens',
    webSearchEngine: 'web_search_engine',
    imageMode: 'image_mode',
    reasoningEffort: 'reasoning_effort',
  };
  if (body.searchSettings !== undefined) {
    fields.push('search_settings = ?');
    values.push(body.searchSettings ? JSON.stringify(body.searchSettings) : null);
  }
  const numeric = new Set(['temperature', 'maxTokens']);
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) {
      fields.push(col + ' = ?');
      values.push(numeric.has(k) ? numOrNull(body[k]) : body[k]);
    }
  }
  for (const [k, col] of Object.entries({ webSearch: 'web_search', imageOutput: 'image_output', pinned: 'pinned', archived: 'archived' })) {
    if (body[k] !== undefined) {
      fields.push(col + ' = ?');
      values.push(body[k] ? 1 : 0);
    }
  }
  if (!fields.length) return c.json({ ok: true });
  fields.push('updated_at = ?');
  values.push(now(), room.id, c.get('userId'));
  await c.env.DB.prepare('UPDATE rooms SET ' + fields.join(', ') + ' WHERE id = ? AND user_id = ?')
    .bind(...values)
    .run();
  return c.json({ ok: true });
});

async function purgeRoomFiles(env, roomId, userId) {
  const { results } = await env.DB.prepare('SELECT id FROM files WHERE room_id = ? AND user_id = ?').bind(roomId, userId).all();
  for (const f of results || []) {
    try {
      await env.KV.delete('file:' + f.id);
    } catch {
      /* best effort */
    }
  }
  await env.DB.prepare('DELETE FROM files WHERE room_id = ? AND user_id = ?').bind(roomId, userId).run();
}

rooms.delete('/:id', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  await purgeRoomFiles(c.env, room.id, c.get('userId'));
  // The sandbox workspace, its snapshot and the preview environment belong to
  // the room, so deleting the room disposes of them too.
  if (c.env.Sandbox) {
    const { destroyEnvironment } = await import('../lib/preview.js');
    await destroyEnvironment(c.env, room.id).catch(() => {});
  }
  await c.env.DB.prepare('DELETE FROM agent_events WHERE run_id IN (SELECT id FROM agent_runs WHERE room_id = ?)')
    .bind(room.id)
    .run();
  await c.env.DB.prepare('DELETE FROM agent_runs WHERE room_id = ?').bind(room.id).run();
  await c.env.DB.prepare('DELETE FROM messages WHERE room_id = ?').bind(room.id).run();
  await c.env.DB.prepare('DELETE FROM rooms WHERE id = ? AND user_id = ?').bind(room.id, c.get('userId')).run();
  return c.json({ ok: true });
});

rooms.post('/:id/clear', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  await purgeRoomFiles(c.env, room.id, c.get('userId'));
  await c.env.DB.prepare('DELETE FROM messages WHERE room_id = ?').bind(room.id).run();
  await c.env.DB.prepare('UPDATE rooms SET total_cost = 0, updated_at = ? WHERE id = ?').bind(now(), room.id).run();
  return c.json({ ok: true });
});

rooms.delete('/:id/messages/:mid', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare('DELETE FROM messages WHERE id = ? AND room_id = ?').bind(c.req.param('mid'), room.id).run();
  return c.json({ ok: true });
});

// Deletes the given message and everything after it, so a branch can be retried.
rooms.post('/:id/truncate', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const { messageId } = await c.req.json().catch(() => ({}));
  const msg = await c.env.DB.prepare('SELECT created_at FROM messages WHERE id = ? AND room_id = ?')
    .bind(messageId, room.id)
    .first();
  if (!msg) return c.json({ error: 'message not found' }, 404);
  await c.env.DB.prepare('DELETE FROM messages WHERE room_id = ? AND created_at >= ?').bind(room.id, msg.created_at).run();
  return c.json({ ok: true });
});

rooms.get('/:id/export', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC').bind(room.id).all();
  const payload = {
    exportedAt: new Date().toISOString(),
    room: { id: room.id, title: room.title, model: room.model, provider: room.provider, systemPrompt: room.system_prompt },
    messages: (results || []).map(shapeMessage),
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="room-' + room.id + '.json"',
    },
  });
});

export default rooms;
