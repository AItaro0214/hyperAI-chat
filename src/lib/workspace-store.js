/* Persisting a room's workspace.
 *
 * Container disk is ephemeral: "when a Container instance goes to sleep, the
 * next time it is started, it will have a fresh disk". So the workspace is
 * snapshotted to KV as a zip and restored on the next cold start. Dependencies
 * are excluded — reinstalling is cheaper than storing them, and KV values cap
 * at 25MB.
 *
 * When an R2 bucket is bound as BACKUP_BUCKET the SDK's own squashfs backups
 * are used instead: they are faster and keep node_modules. */

import { WORKSPACE } from './workspace.js';
import { runCommand, ensureWorkspace, listFiles, withTimeout } from './sandbox.js';

const KEY = (roomId) => 'ws:' + String(roomId || 'scratch');
const MAX_SNAPSHOT = 20 * 1024 * 1024;
const STAGE = '/tmp/workspace.b64';

const hasR2 = (env) => !!env.BACKUP_BUCKET;

/* ------------------------------- snapshot -------------------------------- */

/**
 * Stores the current workspace so it survives the container sleeping.
 * @returns {Promise<{ok: boolean, bytes?: number, kind?: string, reason?: string}>}
 */
export async function snapshotWorkspace(env, roomId, sandbox) {
  const files = await listFiles(sandbox, { limit: 5 }).catch(() => []);
  if (!files.length) return { ok: false, reason: 'empty' };

  if (hasR2(env)) {
    try {
      const backup = await withTimeout(
        sandbox.createBackup({
          dir: WORKSPACE,
          name: 'room-' + roomId,
          localBucket: true,
          excludes: ['node_modules/*', '.git/*'],
        }),
        180000,
        'バックアップ作成'
      );
      await env.KV.put(KEY(roomId) + ':backup', JSON.stringify(backup), { expirationTtl: 60 * 60 * 24 * 30 });
      return { ok: true, kind: 'r2' };
    } catch {
      /* fall through to the zip path */
    }
  }

  // base64 keeps the transfer inside the text-only file API.
  const res = await runCommand(
    sandbox,
    'rm -f /tmp/ws.zip ' + STAGE +
      "; zip -r -q /tmp/ws.zip . -x 'node_modules/*' -x '.git/*' -x '.next/*' -x 'dist/*' -x 'build/*'" +
      '; base64 -w 0 /tmp/ws.zip > ' + STAGE + '; stat -c %s /tmp/ws.zip',
    { timeout: 180000 }
  );
  const size = Number((res.stdout.match(/(\d+)\s*$/) || [])[1] || 0);
  if (!size) return { ok: false, reason: 'zip failed: ' + (res.stderr || res.stdout).slice(0, 200) };
  if (size > MAX_SNAPSHOT) return { ok: false, reason: 'too-large', bytes: size };

  const b64 = await withTimeout(sandbox.readFile(STAGE), 120000, 'スナップショットの読み出し').then((r) =>
    typeof r === 'string' ? r : r?.content || ''
  );
  const clean = String(b64).trim();
  if (!clean) return { ok: false, reason: 'read failed' };

  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await env.KV.put(KEY(roomId), bytes, {
    expirationTtl: 60 * 60 * 24 * 30,
    metadata: { at: Date.now(), bytes: bytes.length },
  });
  return { ok: true, bytes: bytes.length, kind: 'kv' };
}

/* -------------------------------- restore -------------------------------- */

/** True when the workspace has nothing in it. */
async function isEmpty(sandbox) {
  const files = await listFiles(sandbox, { limit: 2 }).catch(() => []);
  return files.length === 0;
}

/**
 * Puts a stored workspace back, but only when the container came up empty.
 * @returns {Promise<{restored: boolean, files?: number, kind?: string}>}
 */
export async function restoreWorkspace(env, roomId, sandbox) {
  await ensureWorkspace(sandbox);
  if (!(await isEmpty(sandbox))) return { restored: false };

  if (hasR2(env)) {
    const saved = await env.KV.get(KEY(roomId) + ':backup', 'json').catch(() => null);
    if (saved) {
      try {
        await withTimeout(sandbox.restoreBackup(saved), 180000, 'バックアップ復元');
        const files = await listFiles(sandbox, { limit: 400 }).catch(() => []);
        return { restored: files.length > 0, files: files.length, kind: 'r2' };
      } catch {
        /* fall through to the zip path */
      }
    }
  }

  const buf = await env.KV.get(KEY(roomId), 'arrayBuffer').catch(() => null);
  if (!buf || !buf.byteLength) return { restored: false };

  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));

  await withTimeout(sandbox.writeFile(STAGE, btoa(bin)), 120000, '復元データの書き込み');
  const res = await runCommand(
    sandbox,
    'base64 -d ' + STAGE + ' > /tmp/ws.zip && unzip -o -q /tmp/ws.zip -d ' + WORKSPACE + ' && rm -f ' + STAGE + ' /tmp/ws.zip',
    { timeout: 180000 }
  );
  if (!res.ok) return { restored: false };

  const files = await listFiles(sandbox, { limit: 400 }).catch(() => []);
  return { restored: files.length > 0, files: files.length, kind: 'kv' };
}

/** What is stored for this room, for the panel to show. */
export async function snapshotInfo(env, roomId) {
  const list = await env.KV.list({ prefix: KEY(roomId) }).catch(() => null);
  const entry = (list?.keys || []).find((k) => k.name === KEY(roomId));
  if (!entry) return null;
  return { at: entry.metadata?.at || null, bytes: entry.metadata?.bytes || null };
}
