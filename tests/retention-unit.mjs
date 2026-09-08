import {
  isExpired,
  expiresAt,
  reapExpiredMedia,
  reapOrphanBlobs,
  MEDIA_TTL_DAYS,
  EXPIRING_KINDS,
} from '../src/lib/media-retention.js';

const results = [];
const check = (name, ok, extra = '') => {
  results.push([ok, name, extra]);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''));
};

const NOW = Math.floor(Date.now() / 1000);
const ago = (days) => NOW - days * 86400;
const row = (kind, days, extra = {}) => ({ id: 'f' + kind + days, kind, created_at: ago(days), size: 1024, ...extra });

/* ------------------------------ the window ------------------------------ */
check('3日で期限切れ', MEDIA_TTL_DAYS === 3, String(MEDIA_TTL_DAYS));
check('期限は作成から3日後', expiresAt(1000) === 1000 + 3 * 86400);

check('新しい画像は残る', !isExpired(row('image', 1), NOW));
check('4日前の画像は期限切れ', isExpired(row('image', 4), NOW));
check('4日前の動画は期限切れ', isExpired(row('video', 4), NOW));
check('境界（ちょうど3日）は期限切れ', isExpired(row('image', 3), NOW));

/* --------------------- only generated media ages out -------------------- */
check('音声は対象外', !isExpired(row('audio', 30), NOW));
check('ドキュメントは対象外', !isExpired(row('doc', 30), NOW));
check('対象は画像と動画だけ', EXPIRING_KINDS.join(',') === 'image,video', EXPIRING_KINDS.join(','));
check('null 行で落ちない', !isExpired(null, NOW));

/* --------------------- already-marked rows stay marked ------------------ */
check('マーク済みは新しくても期限切れ', isExpired(row('image', 0, { expired_at: NOW }), NOW));

/* ------------------------------ the sweep ------------------------------- */
// Enough of D1 and KV to drive reapExpiredMedia without a live binding.
function fakeEnv(rows, { failDelete = [] } = {}) {
  const deleted = [];
  const marked = [];
  return {
    deleted,
    marked,
    KV: {
      async delete(key) {
        if (failDelete.includes(key)) throw new Error('KV down');
        deleted.push(key);
      },
    },
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                const cutoff = args[2];
                return { results: rows.filter((r) => EXPIRING_KINDS.includes(r.kind) && !r.expired_at && r.created_at < cutoff) };
              },
              async run() {
                if (sql.startsWith('UPDATE')) marked.push(args[1]);
              },
            };
          },
        };
      },
    },
  };
}

const rows = [
  row('image', 5),
  row('video', 9),
  row('image', 1), // inside the window
  row('audio', 9), // wrong kind
  row('doc', 9), // wrong kind
  row('image', 8, { expired_at: NOW - 100 }), // already swept
];

const env = fakeEnv(rows);
const res = await reapExpiredMedia(env);
check('古い画像と動画だけ削除', res.count === 2, 'count=' + res.count);
check('  blob を消している', env.deleted.length === 2, env.deleted.join(' '));
check('  行にマークを付けている', env.marked.length === 2, env.marked.join(' '));
check('  容量を積算', res.bytes === 2048, String(res.bytes));
check('  期限内は残す', !env.deleted.some((k) => k.includes('image1')));
check('  音声/文書には触れない', !env.deleted.some((k) => k.includes('audio') || k.includes('doc')));

// A KV failure must not mark the row, so the next sweep retries it.
const env2 = fakeEnv([row('image', 5), row('video', 9)], { failDelete: ['file:fimage5'] });
const res2 = await reapExpiredMedia(env2);
check('KV 失敗時は行をマークしない', res2.count === 1 && !env2.marked.includes('fimage5'), 'count=' + res2.count);
check('  残りの掃除は続行', env2.deleted.includes('file:fvideo9'));

/* --------------------------- orphaned blobs ----------------------------- */
// KV holds the blobs; D1 holds the rows that make them reachable.
function orphanEnv(blobs, knownIds) {
  const deleted = [];
  return {
    deleted,
    KV: {
      async list() {
        return { keys: blobs, list_complete: true, cursor: null };
      },
      async delete(key) {
        deleted.push(key);
      },
    },
    DB: {
      prepare() {
        return {
          bind(...ids) {
            return { async all() {
              return { results: ids.filter((i) => knownIds.includes(i)).map((id) => ({ id })) };
            } };
          },
        };
      },
    },
  };
}

const blob = (id, at) => ({ name: 'file:' + id, metadata: at === undefined ? {} : { at } });

const oEnv = orphanEnv(
  [
    blob('kept', ago(1)),      // has a row
    blob('orphan', ago(1)),    // no row, old enough
    blob('fresh', NOW - 60),   // no row, but written a minute ago
    blob('legacy'),            // no row, predates the timestamp stamping
  ],
  ['kept']
);
const oRes = await reapOrphanBlobs(oEnv);
check('行のない blob を削除', oRes.count === 2, 'count=' + oRes.count + ' ' + oEnv.deleted.join(' '));
check('  行のある blob は残す', !oEnv.deleted.includes('file:kept'));
check('  直近の書き込みは猶予する', !oEnv.deleted.includes('file:fresh'));
check('  タイムスタンプなしは古いとみなす', oEnv.deleted.includes('file:legacy'));
check('  孤児を削除している', oEnv.deleted.includes('file:orphan'));

const noKv = await reapOrphanBlobs({});
check('KV なしでも落ちない', noKv.count === 0);

const passed = results.filter(([ok]) => ok).length;
console.log('\n' + passed + '/' + results.length + ' passed');
process.exit(passed === results.length ? 0 : 1);
