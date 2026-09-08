/* Retention for generated images and video.
 *
 * These two kinds are almost all of the bytes the app ever stores — a single
 * video run outweighs months of conversation — and they are the least worth
 * keeping, since anything worth having gets downloaded. So they follow the same
 * rule as preview environments: three days, or the room being deleted.
 *
 * Only the blob is dropped. The row stays behind so the transcript can say a
 * picture used to be here rather than showing a broken image, and it costs
 * about a hundred bytes against the megabytes reclaimed. Deleting the room
 * still removes both (see purgeRoomFiles). */

import { now } from './auth.js';

export const MEDIA_TTL_DAYS = 3;

/** Uploads and documents are the user's own; only generated media ages out. */
export const EXPIRING_KINDS = ['image', 'video'];

export const expiresAt = (createdAt, days = MEDIA_TTL_DAYS) => createdAt + days * 86400;

/** True once the row is past its window and still holds a blob. */
export function isExpired(row, at = now(), days = MEDIA_TTL_DAYS) {
  if (!row || !EXPIRING_KINDS.includes(row.kind)) return false;
  if (row.expired_at) return true;
  return expiresAt(Number(row.created_at) || 0, days) <= at;
}

/**
 * Drops blobs past the window and marks their rows.
 * Called from the scheduled handler.
 * @returns {Promise<{count: number, bytes: number}>}
 */
export async function reapExpiredMedia(env, limit = 200) {
  const cutoff = now() - MEDIA_TTL_DAYS * 86400;
  const { results } = await env.DB.prepare(
    'SELECT id, size FROM files WHERE kind IN (?, ?) AND expired_at IS NULL AND created_at < ? ORDER BY created_at LIMIT ?'
  )
    .bind(EXPIRING_KINDS[0], EXPIRING_KINDS[1], cutoff, limit)
    .all();

  let count = 0;
  let bytes = 0;
  for (const row of results || []) {
    try {
      await env.KV.delete('file:' + row.id);
    } catch {
      // A blob that will not delete should not stall the rest of the sweep;
      // the row stays unmarked and the next run tries again.
      continue;
    }
    await env.DB.prepare('UPDATE files SET expired_at = ? WHERE id = ?').bind(now(), row.id).run();
    count++;
    bytes += Number(row.size) || 0;
  }
  return { count, bytes };
}

/* ---------------------------- orphaned blobs ---------------------------- */

/* A blob whose row is gone is invisible to the sweep above and would sit in KV
 * forever, which defeats the point of having a retention rule at all. Rows and
 * blobs are written separately, so a blob can briefly exist before its row: the
 * grace period keeps the sweep off anything that recent. Blobs written before
 * the `at` stamp existed carry no timestamp and are treated as old. */
const ORPHAN_GRACE_SEC = 3600;
const ID_BATCH = 50;

export async function reapOrphanBlobs(env, limit = 1000) {
  if (!env.KV?.list) return { count: 0 };

  const cutoff = now() - ORPHAN_GRACE_SEC;
  const candidates = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'file:', cursor });
    for (const key of page.keys || []) {
      const at = Number(key.metadata?.at);
      if (Number.isFinite(at) && at > cutoff) continue;
      candidates.push(key.name.slice('file:'.length));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && candidates.length < limit);

  let count = 0;
  for (let i = 0; i < candidates.length; i += ID_BATCH) {
    const batch = candidates.slice(i, i + ID_BATCH);
    const { results } = await env.DB.prepare(
      'SELECT id FROM files WHERE id IN (' + batch.map(() => '?').join(',') + ')'
    )
      .bind(...batch)
      .all();
    const known = new Set((results || []).map((r) => r.id));
    for (const id of batch) {
      if (known.has(id)) continue;
      try {
        await env.KV.delete('file:' + id);
        count++;
      } catch {
        /* next sweep will find it again */
      }
    }
  }
  return { count };
}
