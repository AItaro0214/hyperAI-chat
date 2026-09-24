import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { logUsage } from '../lib/store.js';
import { requireKey } from '../lib/chat.js';
import { sanitizeParams, passthroughBody } from '../lib/media-params.js';
import { applyDiscount, estimateVideoCost, fetchVideoModels, jobStatusOf, pollVideoJob, submitVideoJob, videoUrlFrom } from '../lib/video.js';

const video = new Hono();
video.use('/videos', requireAuth);
video.use('/videos/*', requireAuth);

const MAX_STORE_BYTES = 20 * 1024 * 1024; // KV value ceiling is 25MB

video.get('/videos/models', async (c) => {
  try {
    const models = await fetchVideoModels(c.env, { force: c.req.query('refresh') === '1' });
    return c.json({ models });
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});

/** Inlines an owned upload as a data URL — OpenRouter cannot reach our files route. */
async function fileAsDataUrl(env, userId, fileId) {
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

video.post('/videos', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return c.json({ error: 'prompt が必要です' }, 400);
  if (!body.model) return c.json({ error: 'model が必要です' }, 400);

  let apiKey;
  try {
    apiKey = await requireKey(c.env, 'openrouter');
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }

  const models = await fetchVideoModels(c.env).catch(() => []);
  const model = models.find((m) => m.id === body.model);
  if (!model) return c.json({ error: '未知の動画モデルです: ' + body.model }, 400);

  // Only forward what this specific model accepts.
  const payload = { model: model.id, prompt };
  if (body.duration && model.durations.includes(Number(body.duration))) payload.duration = Number(body.duration);
  if (body.resolution && model.resolutions.includes(body.resolution)) payload.resolution = body.resolution;
  if (body.aspectRatio && model.aspectRatios.includes(body.aspectRatio)) payload.aspect_ratio = body.aspectRatio;
  if (body.size && model.sizes.includes(body.size)) payload.size = body.size;
  if (model.seed && Number.isFinite(Number(body.seed)) && body.seed !== '' && body.seed !== null) {
    payload.seed = Number(body.seed);
  }
  if (model.generateAudio && body.generateAudio !== undefined) payload.generate_audio = !!body.generateAudio;

  /* The dynamic form sends `params`. Each value is re-checked against the
   * model's fields; body settings go top level, provider-specific ones under
   * provider.options[slug], which is the only place OpenRouter forwards them. */
  let dropped = [];
  if (body.params && typeof body.params === 'object') {
    const clean = sanitizeParams(model.fields || [], body.params);
    Object.assign(payload, clean.body);
    const provider = passthroughBody(model.providerTag, clean.passthrough);
    if (provider) payload.provider = provider;
    else if (Object.keys(clean.passthrough).length) dropped.push(...Object.keys(clean.passthrough));
    dropped.push(...clean.dropped);
  }

  const frames = [];
  for (const frame of Array.isArray(body.frameImages) ? body.frameImages.slice(0, 2) : []) {
    if (!model.frameImages.includes(frame.frameType)) continue;
    const url = frame.url || (frame.fileId ? await fileAsDataUrl(c.env, userId, frame.fileId) : null);
    if (url) frames.push({ type: 'image_url', image_url: { url }, frame_type: frame.frameType });
  }
  if (frames.length) payload.frame_images = frames;

  let submitted;
  try {
    submitted = await submitVideoJob(apiKey, payload);
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }

  const jobId = newId('vid');
  const estimate = applyDiscount(
    estimateVideoCost(model, {
      size: payload.size,
      resolution: payload.resolution,
      duration: payload.duration,
      generateAudio: payload.generate_audio,
    }),
    model.discount
  );

  // Mirror the request into the room so the result lands in the conversation.
  let messageId = null;
  const room = body.roomId
    ? await c.env.DB.prepare('SELECT id FROM rooms WHERE id = ? AND user_id = ?').bind(body.roomId, userId).first()
    : null;
  if (room) {
    const t = now();
    await c.env.DB.prepare(
      'INSERT INTO messages (id, room_id, user_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(newId('msg'), room.id, userId, 'user', '🎬 ' + prompt, '[]', t)
      .run();
    messageId = newId('msg');
    await c.env.DB.prepare(
      'INSERT INTO messages (id, room_id, user_id, role, content, provider, model, attachments, annotations, meta, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(
        messageId,
        room.id,
        userId,
        'assistant',
        '動画を生成中です…',
        'openrouter',
        model.id,
        '[]',
        '[]',
        JSON.stringify({ videoJob: jobId, videoStatus: 'pending', params: payload, estimate }),
        t + 1
      )
      .run();
    await c.env.DB.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').bind(t, room.id).run();
  }

  await c.env.DB.prepare(
    'INSERT INTO video_jobs (id, user_id, room_id, message_id, provider_job, model, prompt, params, status, cost, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      jobId,
      userId,
      room?.id || null,
      messageId,
      String(submitted?.id || ''),
      model.id,
      prompt,
      JSON.stringify(payload),
      jobStatusOf(submitted),
      estimate,
      now(),
      now()
    )
    .run();

  return c.json({ job: { id: jobId, status: jobStatusOf(submitted), model: model.id, messageId, roomId: room?.id || null, estimate }, dropped }, 202);
});

video.get('/videos/jobs', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, room_id, message_id, model, prompt, status, file_id, video_url, cost, error, created_at FROM video_jobs " +
      'WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
  )
    .bind(c.get('userId'))
    .all();
  return c.json({ jobs: results || [] });
});

video.get('/videos/:id', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare('SELECT * FROM video_jobs WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), userId)
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.status === 'failed') return c.json({ job: shapeJob(row) });

  // A finished job whose download failed earlier is retried once on request.
  if (row.status === 'completed') {
    if (row.file_id || !row.video_url) return c.json({ job: shapeJob(row) });
    let retryKey;
    try {
      retryKey = await requireKey(c.env, 'openrouter');
    } catch {
      return c.json({ job: shapeJob(row) });
    }
    const again = await downloadVideo(c, row, userId, row.video_url, retryKey);
    if (again.fileId) {
      // The cost was already booked when the job first completed.
      await finishJob(c, row, { status: 'completed', fileId: again.fileId, videoUrl: row.video_url, cost: row.cost, attachment: again.attachment, addCost: false });
      return c.json({ job: { ...shapeJob(row), status: 'completed', fileId: again.fileId, attachment: again.attachment } });
    }
    return c.json({ job: shapeJob(row) });
  }

  let apiKey;
  try {
    apiKey = await requireKey(c.env, 'openrouter');
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }

  let upstream;
  try {
    upstream = await pollVideoJob(apiKey, row.provider_job);
  } catch (e) {
    return c.json({ job: shapeJob(row), warning: e.message });
  }

  const status = jobStatusOf(upstream);
  if (status === 'pending' || status === 'in_progress') {
    await c.env.DB.prepare('UPDATE video_jobs SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), row.id).run();
    return c.json({ job: { ...shapeJob(row), status } });
  }

  if (status === 'failed') {
    const message = upstream?.error?.message || upstream?.error || '生成に失敗しました';
    await finishJob(c, row, { status: 'failed', error: String(message).slice(0, 500) });
    return c.json({ job: { ...shapeJob(row), status: 'failed', error: String(message).slice(0, 500) } });
  }

  // completed
  const url = videoUrlFrom(upstream);
  if (!url) {
    await finishJob(c, row, { status: 'failed', error: '完了しましたが動画URLが返りませんでした' });
    return c.json({ job: { ...shapeJob(row), status: 'failed', error: '完了しましたが動画URLが返りませんでした' } });
  }

  const downloaded = await downloadVideo(c, row, userId, url, apiKey);
  const fileId = downloaded.fileId;
  const attachment = downloaded.attachment;

  const cost = typeof upstream?.usage?.cost === 'number' ? upstream.usage.cost : row.cost;
  await finishJob(c, row, { status: 'completed', fileId, videoUrl: url, cost, attachment });
  await logUsage(c.env, {
    userId,
    roomId: row.room_id,
    provider: 'openrouter',
    model: row.model,
    kind: 'video',
    cost,
  });
  return c.json({ job: { ...shapeJob(row), status: 'completed', fileId, videoUrl: url, cost, attachment } });
});

/**
 * The finished video lives behind the OpenRouter API, so downloading it needs
 * the same key as the rest of the calls. Without it the browser is handed a URL
 * it can never open.
 */
async function downloadVideo(c, row, userId, url, apiKey) {
  const needsAuth = /^https:\/\/openrouter\.ai\//i.test(url);
  try {
    const res = await fetch(url, {
      headers: needsAuth ? { authorization: 'Bearer ' + apiKey } : {},
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      console.error('video download HTTP ' + res.status);
    } else {
      const buf = await res.arrayBuffer();
      if (buf.byteLength <= MAX_STORE_BYTES) {
        const fileId = newId('file');
        const mime = res.headers.get('content-type') || 'video/mp4';
        await c.env.KV.put('file:' + fileId, buf, { metadata: { mime, at: now() } });
        await c.env.DB.prepare(
          'INSERT INTO files (id, user_id, room_id, kind, mime, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(fileId, userId, row.room_id, 'video', mime, 'generated.mp4', buf.byteLength, now())
          .run();
        return {
          fileId,
          attachment: { id: fileId, kind: 'video', mime, name: 'generated.mp4', size: buf.byteLength, url: '/api/files/' + fileId },
        };
      }
      console.error('video too large to store: ' + buf.byteLength);
    }
  } catch (e) {
    console.error('video download failed', e);
  }
  // Falling back to the provider URL keeps a reference, but it needs a key to
  // open, so the message says so rather than showing a dead player.
  return { fileId: null, attachment: { kind: 'video', mime: 'video/mp4', name: 'generated.mp4', url, external: true } };
}

function shapeJob(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    messageId: row.message_id,
    model: row.model,
    prompt: row.prompt,
    status: row.status,
    fileId: row.file_id,
    videoUrl: row.video_url,
    cost: row.cost,
    error: row.error,
    createdAt: row.created_at,
  };
}

async function finishJob(c, row, { status, error = null, fileId = null, videoUrl = null, cost = null, attachment = null, addCost = true }) {
  await c.env.DB.prepare(
    'UPDATE video_jobs SET status = ?, error = ?, file_id = ?, video_url = ?, cost = ?, updated_at = ? WHERE id = ?'
  )
    .bind(status, error, fileId, videoUrl, cost ?? row.cost, now(), row.id)
    .run();

  if (!row.message_id) return;
  const content =
    status === 'completed'
      ? '🎬 ' + row.prompt
      : '動画の生成に失敗しました';
  await c.env.DB.prepare('UPDATE messages SET content = ?, attachments = ?, meta = ?, error = ?, cost = ? WHERE id = ?')
    .bind(
      content,
      JSON.stringify(attachment ? [attachment] : []),
      JSON.stringify({ videoJob: row.id, videoStatus: status, params: safeParse(row.params) }),
      error,
      cost ?? row.cost,
      row.message_id
    )
    .run();
  if (row.room_id && addCost) {
    await c.env.DB.prepare('UPDATE rooms SET total_cost = total_cost + ?, updated_at = ? WHERE id = ?')
      .bind(cost ?? row.cost ?? 0, now(), row.room_id)
      .run();
  }
}

function safeParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export default video;
