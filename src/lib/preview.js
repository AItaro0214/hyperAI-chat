/* Long-lived preview environments.
 *
 * A quick tunnel dies with the container and hands out a different URL every
 * time, which is no good for "open the app and use it". Instead the request is
 * proxied straight into the container from our own domain, so the URL is stable
 * and sits behind the app's login. Waking a sleeping container is part of the
 * request path, so the environment survives the container being recycled.
 *
 * Everything is disposable by design: three days, or the room being deleted. */

import { now } from './auth.js';
import { WORKSPACE } from './workspace.js';
import { sandboxFor, runCommand, listFiles, containerFetch, startPreview, stopPreview } from './sandbox.js';
import { restoreWorkspace } from './workspace-store.js';
import { checkPreviewPort } from './commands.js';

export const PREVIEW_TTL_DAYS = 3;
export const DB_PATH = WORKSPACE + '/.data/preview.sqlite';
const READY_TIMEOUT = 90000;

export const previewUrlFor = (roomId) => '/preview/' + encodeURIComponent(roomId) + '/';

/**
 * The environment record, if the room has one that has not expired.
 */
export async function getPreview(env, roomId) {
  const row = await env.DB.prepare('SELECT * FROM preview_envs WHERE room_id = ?').bind(roomId).first();
  if (!row) return null;
  if (Number(row.expires_at) < now()) return { ...row, expired: true };
  return row;
}

/** Node 24 ships node:sqlite, so a scratch database needs nothing installed. */
async function ensureDatabase(sandbox) {
  await runCommand(sandbox, 'mkdir -p ' + JSON.stringify(WORKSPACE + '/.data'), { timeout: 30000 });
  return DB_PATH;
}

/**
 * Starts (or restarts) the room's preview server and records it.
 * @returns {Promise<{ok: boolean, url?: string, error?: string, log?: string}>}
 */
export async function startEnvironment(env, userId, roomId, { command, port }) {
  const bad = checkPreviewPort(port);
  if (bad) return { ok: false, error: bad };
  const sandbox = sandboxFor(env, roomId);
  await restoreWorkspace(env, roomId, sandbox).catch(() => null);
  const dbPath = await ensureDatabase(sandbox);

  const existing = await getPreview(env, roomId);
  if (existing?.process_id) await stopPreview(sandbox, existing.port, existing.process_id).catch(() => {});

  // The app finds its scratch database through the environment.
  const withEnv = 'PREVIEW_DB=' + JSON.stringify(dbPath) + ' DATABASE_URL=' + JSON.stringify('file:' + dbPath) + ' ' + command;
  const started = await startPreview(sandbox, withEnv, port);

  const t = now();
  const expires = t + PREVIEW_TTL_DAYS * 86400;
  await env.DB.prepare(
    'INSERT INTO preview_envs (room_id, user_id, port, command, process_id, db_path, status, last_seen_at, expires_at, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(room_id) DO UPDATE SET port = excluded.port, command = excluded.command, ' +
      'process_id = excluded.process_id, db_path = excluded.db_path, status = excluded.status, ' +
      'last_seen_at = excluded.last_seen_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at'
  )
    .bind(
      roomId,
      userId,
      port,
      command,
      started.processId || null,
      dbPath,
      started.error ? 'failed' : 'running',
      t,
      expires,
      t,
      t
    )
    .run();

  if (started.error) return { ok: false, error: started.error, log: started.log };
  return { ok: true, url: previewUrlFor(roomId), expiresAt: expires, dbPath, log: started.log };
}

/** Brings a recorded environment back up after the container was recycled. */
async function revive(env, row) {
  const sandbox = sandboxFor(env, row.room_id);
  await restoreWorkspace(env, row.room_id, sandbox).catch(() => null);
  await ensureDatabase(sandbox);
  const withEnv =
    'PREVIEW_DB=' + JSON.stringify(row.db_path || DB_PATH) +
    ' DATABASE_URL=' + JSON.stringify('file:' + (row.db_path || DB_PATH)) + ' ' + row.command;
  const started = await startPreview(sandbox, withEnv, row.port);
  await env.DB.prepare('UPDATE preview_envs SET process_id = ?, status = ?, updated_at = ? WHERE room_id = ?')
    .bind(started.processId || null, started.error ? 'failed' : 'running', now(), row.room_id)
    .run();
  return started;
}

/**
 * Serves one request from the room's preview, waking or restarting it as needed.
 */
export async function servePreview(env, roomId, request, path) {
  const row = await getPreview(env, roomId);
  if (!row) return new Response('プレビュー環境がありません。開発パネルから起動してください。', { status: 404 });
  if (row.expired) {
    return new Response('このプレビュー環境は期限切れです（' + PREVIEW_TTL_DAYS + '日）。もう一度起動してください。', { status: 410 });
  }

  const sandbox = sandboxFor(env, roomId);
  const url = new URL(request.url);
  const target = new Request('http://localhost:' + row.port + path + url.search, request);

  let res = await containerFetch(sandbox, target, row.port).catch(() => null);
  if (!res || res.status === 502 || res.status === 503) {
    // The container was recycled; bring the server back and try once more.
    const again = await revive(env, row).catch(() => null);
    if (again && !again.error) {
      res = await containerFetch(sandbox, new Request(target), row.port).catch(() => null);
    }
  }
  if (!res) {
    return new Response('プレビューを起動できませんでした。開発パネルで状態を確認してください。', { status: 502 });
  }

  await env.DB.prepare('UPDATE preview_envs SET last_seen_at = ? WHERE room_id = ?').bind(now(), roomId).run();
  return res;
}

/* --------------------------------- reaping -------------------------------- */

/** Drops everything belonging to a room: container files, snapshot, record. */
export async function destroyEnvironment(env, roomId) {
  const row = await env.DB.prepare('SELECT * FROM preview_envs WHERE room_id = ?').bind(roomId).first();
  try {
    const sandbox = sandboxFor(env, roomId);
    if (row?.process_id) await stopPreview(sandbox, row.port, row.process_id).catch(() => {});
    await runCommand(sandbox, 'rm -rf ' + WORKSPACE + ' && mkdir -p ' + WORKSPACE, { timeout: 60000 }).catch(() => {});
  } catch {
    /* the container may already be gone, which is the desired end state */
  }
  await env.KV.delete('ws:' + roomId).catch(() => {});
  await env.KV.delete('ws:' + roomId + ':backup').catch(() => {});
  await env.DB.prepare('DELETE FROM preview_envs WHERE room_id = ?').bind(roomId).run();
  return { destroyed: true };
}

/** Called from the scheduled handler; removes environments past their TTL. */
export async function reapExpired(env, limit = 20) {
  const { results } = await env.DB.prepare(
    'SELECT room_id FROM preview_envs WHERE expires_at < ? ORDER BY expires_at LIMIT ?'
  )
    .bind(now(), limit)
    .all();

  const reaped = [];
  for (const row of results || []) {
    await destroyEnvironment(env, row.room_id).catch(() => {});
    reaped.push(row.room_id);
  }
  return reaped;
}

/** Extends the window, so an environment in daily use is not reaped. */
export async function touchEnvironment(env, roomId) {
  await env.DB.prepare('UPDATE preview_envs SET expires_at = ?, updated_at = ? WHERE room_id = ?')
    .bind(now() + PREVIEW_TTL_DAYS * 86400, now(), roomId)
    .run();
}

export async function environmentInfo(env, roomId) {
  const row = await getPreview(env, roomId);
  if (!row) return null;
  const files = await listFiles(sandboxFor(env, roomId), { limit: 3 }).catch(() => []);
  return {
    url: previewUrlFor(roomId),
    port: row.port,
    command: row.command,
    status: row.expired ? 'expired' : row.status,
    dbPath: row.db_path,
    expiresAt: row.expires_at,
    hasFiles: files.length > 0,
  };
}
