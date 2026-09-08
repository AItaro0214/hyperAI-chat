/* Batch image generation. Pictures land in the room as one assistant turn, the
 * way a reply with generated images does. */

import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { logUsage } from '../lib/store.js';
import { requireKey } from '../lib/chat.js';
import { fetchImageModels, buildImageRequest, planBatches, generateImages, imagesFrom, costOf } from '../lib/images.js';

const images = new Hono();
images.use('/images', requireAuth);
images.use('/images/*', requireAuth);

const MAX_BATCH = 10;

images.get('/images/models', async (c) => {
  try {
    const models = await fetchImageModels(c.env, { force: c.req.query('refresh') === '1' });
    return c.json({ models });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

/** Reference pictures are inlined; OpenRouter cannot reach our files route. */
async function referenceUrl(env, userId, fileId) {
  const row = await env.DB.prepare('SELECT mime FROM files WHERE id = ? AND user_id = ?').bind(fileId, userId).first();
  if (!row) return null;
  const buf = await env.KV.get('file:' + fileId, 'arrayBuffer');
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return 'data:' + (row.mime || 'image/png') + ';base64,' + btoa(bin);
}

images.post('/images', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return c.json({ error: 'プロンプトを入力してください' }, 400);

  let apiKey;
  try {
    apiKey = await requireKey(c.env, 'openrouter');
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }

  const models = await fetchImageModels(c.env).catch(() => []);
  const model = models.find((m) => m.id === body.model);
  if (!model) return c.json({ error: '未知の画像モデルです: ' + body.model }, 400);

  const count = Math.max(1, Math.min(Number(body.count) || 1, MAX_BATCH));
  const references = [];
  for (const fileId of Array.isArray(body.referenceFileIds) ? body.referenceFileIds.slice(0, 5) : []) {
    const url = await referenceUrl(c.env, userId, fileId);
    if (url) references.push(url);
  }

  // Models capped at n=1 still produce a batch: the request is simply split.
  const batches = planBatches(count, model.maxN);
  const results = await Promise.allSettled(
    batches.map((n) => {
      const { body: payload } = buildImageRequest(model, { ...body, prompt, n, references });
      return generateImages(apiKey, payload);
    })
  );

  const collected = [];
  let cost = 0;
  const errors = [];
  for (const r of results) {
    if (r.status === 'rejected') {
      errors.push(String(r.reason?.message || r.reason).slice(0, 200));
      continue;
    }
    collected.push(...imagesFrom(r.value));
    const c1 = costOf(r.value);
    if (c1) cost += c1;
  }

  if (!collected.length) {
    return c.json({ error: errors[0] || '画像を取得できませんでした', errors }, 502);
  }

  const attachments = [];
  for (const img of collected.slice(0, MAX_BATCH)) {
    const id = newId('file');
    const mime = img.mime || 'image/png';
    const name = 'generated.' + (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    await c.env.KV.put('file:' + id, img.bytes, { metadata: { mime, name } });
    await c.env.DB.prepare(
      'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, userId, body.roomId || null, 'image', mime, name, img.bytes.length, now())
      .run();
    attachments.push({ id, url: '/api/files/' + id, mime, name, kind: 'image' });
  }

  // Mirror the batch into the room so it stays in the conversation.
  let messageId = null;
  const room = body.roomId
    ? await c.env.DB.prepare('SELECT id FROM rooms WHERE id = ? AND user_id = ?').bind(body.roomId, userId).first()
    : null;
  if (room) {
    const t = now();
    await c.env.DB.prepare(
      'INSERT INTO messages (id, room_id, user_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(newId('msg'), room.id, userId, 'user', '🎨 ' + prompt, '[]', t)
      .run();
    messageId = newId('msg');
    await c.env.DB.prepare(
      'INSERT INTO messages (id, room_id, user_id, role, content, provider, model, attachments, annotations, meta, cost, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        messageId,
        room.id,
        userId,
        'assistant',
        attachments.length + ' 枚生成しました。',
        'openrouter',
        model.id,
        JSON.stringify(attachments),
        '[]',
        JSON.stringify({ imageBatch: { count: attachments.length, prompt, errors } }),
        cost || null,
        t + 1
      )
      .run();
    await c.env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(t, room.id).run();
  }

  if (cost) await logUsage(c.env, { userId, roomId: room?.id || null, provider: 'openrouter', model: model.id, kind: 'image', units: attachments.length, cost });

  return c.json({ images: attachments, cost: cost || null, messageId, roomId: room?.id || null, errors }, 201);
});

export default images;
