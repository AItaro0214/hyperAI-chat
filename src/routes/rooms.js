import { Hono } from 'hono';
import { newId } from '../lib/crypto.js';
import { now } from '../lib/auth.js';
import { requireAuth } from '../lib/guard.js';
import { getSettings, getApiKey, getJsonSetting } from '../lib/store.js';
import { recoverReply, OWN_JOBS_KEY, JOB_WAIT_MS } from '../lib/runpod.js';
import { pendingReplies, settleMessage } from '../lib/runpod-jobs.js';

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

/** Fifteen minutes: longer than any reply, shorter than forever. */
const PARTIAL_GRACE_SEC = 900;
/* A breakthrough turn runs on its own (a Workflow) for up to two hours, and
 * says so in meta.progress or meta.runpodJob. */
const TURN_GRACE_SEC = JOB_WAIT_MS / 1000 + 900;

function staleMeta(row) {
  const meta = row.meta && row.meta.length > 20000 ? { truncated: true } : parseJson(row.meta, null);
  if (!meta?.partial) return meta;
  const grace = meta.progress || meta.runpodJob ? TURN_GRACE_SEC : PARTIAL_GRACE_SEC;
  if (now() - Number(row.created_at || 0) < grace) return meta;
  return { ...meta, partial: false, abandoned: true };
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
    /* A row still marked partial long after it was created is not in
     * progress — the Worker that was writing it is gone. waitUntil outlives
     * the response by seconds, not the quarter hour an unbounded generation
     * can take, and a row left this way makes the client poll it forever. */
    meta: staleMeta(row),
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
  /* A breakthrough reply still waiting on its RunPod job is looked up once
   * more before the room is shown, so a tab that was closed comes back to a
   * finished answer. At most every 20 seconds per reply. */
  const waiting = await pendingReplies(c.env, { roomId: room.id, limit: 3 }).catch(() => []);
  for (const row of waiting) {
    const checkedAt = parseJson(row.meta, {})?.runpodJob?.checkedAt || 0;
    if (Date.now() - checkedAt < 20000) continue;
    await settleMessage(c.env, row).catch(() => {});
  }
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
  const stranded = [];
  for (const f of results || []) {
    try {
      await env.KV.delete('file:' + f.id);
    } catch {
      // Dropping the row now would strand the blob in KV with nothing pointing
      // at it. Keep the row so the orphan sweep can retry the delete.
      stranded.push(f.id);
    }
  }
  const keep = stranded.length ? ' AND id NOT IN (' + stranded.map(() => '?').join(',') + ')' : '';
  await env.DB.prepare('DELETE FROM files WHERE room_id = ? AND user_id = ?' + keep)
    .bind(roomId, userId, ...stranded)
    .run();
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

/* Fetches a lost reply back from RunPod and writes it into its message row.
 *
 * The GPU finished and was paid for; only the Worker relaying it went away.
 * RunPod holds finished jobs for about half an hour, so within that window the
 * reply is still there to be claimed — after it, nothing can bring it back and
 * saying so plainly is better than a spinner. */
rooms.post('/:id/messages/:mid/recover', async (c) => {
  const room = await ownedRoom(c, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const msg = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?')
    .bind(c.req.param('mid'), room.id)
    .first();
  if (!msg) return c.json({ error: 'message not found' }, 404);

  /* A reply that knows its job is read by id — exact, where the search below
   * can only guess by time. */
  if (parseJson(msg.meta, {})?.runpodJob?.id) {
    const out = await settleMessage(c.env, msg).catch((e) => ({ state: 'error', error: e.message }));
    const updated = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
    if (out.state === 'settled' || out.state === 'lost') {
      return c.json({ ok: !updated.error, message: shapeMessage(updated), reason: updated.error || undefined, matched: true });
    }
    if (out.state === 'pending') {
      return c.json({ ok: false, pending: 1, reason: 'RunPod で処理中です（' + out.status + '）。終わると自動で入ります。' });
    }
    /* Its own job is the only one that can be its reply. Already settled, or
     * unreadable just now — either way, guessing by time from the other jobs
     * on the endpoint can only find someone else's. */
    return c.json({
      ok: false,
      message: shapeMessage(updated),
      reason: out.state === 'skipped' ? 'この返答のジョブは既に回収済みです。' : 'RunPod に問い合わせできませんでした: ' + (out.error || out.state),
    });
  }

  const msgMeta = parseJson(msg.meta, {}) || {};
  /* A turn still running as a Workflow, before its reply job: it is
   * deciding or searching, and will write the reply itself. */
  if (msgMeta.workflow && msgMeta.partial && c.env.BREAKTHROUGH) {
    const status = await c.env.BREAKTHROUGH.get(msgMeta.workflow)
      .then((w) => w.status())
      .catch(() => null);
    if (status && ['queued', 'running', 'waiting', 'paused', 'waitingForPause'].includes(status.status)) {
      return c.json({ ok: false, pending: 1, reason: '処理中です（' + (msgMeta.progress?.text || status.status) + '）。終わると自動で入ります。' });
    }
  }

  /* Stopped before any reply job was sent — while deciding whether to
   * search, or searching: there is no reply to find, only decisions, whose
   * text is a half-answer cut off at 700 tokens. Matching by time would
   * take one. */
  if ((msgMeta.phase === 'deciding' || msgMeta.progress) && !msgMeta.runpodJob) {
    const why = '検索の判断の途中で止まったため、返答は作られていません。もう一度送ってください。';
    await c.env.DB.prepare('UPDATE messages SET error = ?, meta = ? WHERE id = ?')
      .bind(msg.error || why, JSON.stringify({ ...msgMeta, partial: false }), msg.id)
      .run();
    const updated = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
    return c.json({ ok: false, reason: why, message: shapeMessage(updated) });
  }

  const settings = await getSettings(c.env);
  const endpointId = settings.runpodEndpointId;
  if (!endpointId) return c.json({ error: 'ブレイクスルー用のエンドポイントが設定されていません' }, 400);
  const apiKey = await getApiKey(c.env, 'RUNPOD_API_KEY');
  if (!apiKey) return c.json({ error: 'RUNPOD_API_KEY が未登録です' }, 400);

  let result;
  try {
    // The app's own jobs (diagnosis, warm-up), set aside by id.
    const ownJobs = new Set(await getJsonSetting(c.env, OWN_JOBS_KEY, []).catch(() => []));
    result = await recoverReply(apiKey, endpointId, { since: Number(msg.created_at) || 0, ownJobs });
  } catch (e) {
    return c.json({ error: 'RunPod に問い合わせできませんでした: ' + String(e?.message || e).slice(0, 300) }, 502);
  }

  const failedJobs = result.failed || [];
  if (!result.found) {
    const waiting = result.pending.length;
    /* No reply to bring back, but a failed job says why there is none. That
     * reason is written to the message, so it is still there after RunPod
     * forgets the job. */
    if (!waiting && failedJobs.length) {
      // Recent failures on the endpoint, not necessarily this message's.
      const why = '該当する答えは見つかりませんでした。このエンドポイントで最近失敗したジョブ: ' + failedJobs[0].error;
      const meta = { ...(parseJson(msg.meta, {}) || {}), partial: false, runpodFailures: failedJobs };
      await c.env.DB.prepare('UPDATE messages SET error = ?, meta = ? WHERE id = ?')
        .bind(msg.error || why, JSON.stringify(meta), msg.id)
        .run();
      const updated = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
      return c.json({ ok: false, failed: failedJobs, reason: why, message: shapeMessage(updated) });
    }
    return c.json({
      ok: false,
      pending: waiting,
      checked: result.checked,
      reason: waiting
        ? '同じエンドポイントでまだ実行中のジョブが ' + waiting + ' 件あります。完了後にもう一度お試しください。'
        : result.outOfWindow
          ? '該当する答えは見つかりませんでした（残っている返答はどれもこの発言と時刻が合わず、別の発言のものなので取り込みません）。'
          : result.appJobs
            ? '該当する答えは見つかりませんでした（残っていたのは診断・起動用のジョブ ' + result.appJobs + ' 件だけでした）。'
            : result.decisions
          ? '残っているのは検索の判断のジョブだけで、返答のジョブは見つかりませんでした。'
          : result.checked
            ? '完了済みジョブは ' + result.checked + ' 件見つかりましたが、本文が取り出せませんでした。'
            : 'RunPod 側に残っているジョブがありません。保持期間（約30分）を過ぎた可能性があります。',
    });
  }

  const reply = result.found;
  // Never trade a longer reply for a shorter one: a row that streamed most of
  // the way through is better than a job that matched only by timestamp.
  const keepExisting = String(msg.content || '').length > reply.text.length;
  const content = keepExisting ? msg.content : reply.text;
  const reasoning = reply.reasoning || msg.reasoning || null;
  const meta = {
    ...(parseJson(msg.meta, {}) || {}),
    partial: false,
    abandoned: false,
    recovered: {
      jobId: reply.jobId,
      at: now(),
      matched: !!result.matched,
      // The error column is cleared below; what it said is kept here.
      ...(msg.error ? { previousError: String(msg.error).slice(0, 600) } : {}),
      ...(failedJobs.length ? { failedJobs } : {}),
    },
  };

  await c.env.DB.prepare(
    'UPDATE messages SET content = ?, reasoning = ?, prompt_tokens = ?, completion_tokens = ?, meta = ?, error = NULL WHERE id = ?'
  )
    .bind(
      content,
      reasoning,
      reply.usage?.prompt_tokens ?? msg.prompt_tokens ?? null,
      reply.usage?.completion_tokens ?? msg.completion_tokens ?? null,
      JSON.stringify(meta),
      msg.id
    )
    .run();

  const updated = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(msg.id).first();
  return c.json({ ok: true, matched: !!result.matched, jobId: reply.jobId, message: shapeMessage(updated) });
});

export default rooms;
