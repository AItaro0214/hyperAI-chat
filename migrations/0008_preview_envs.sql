-- A room's preview environment. Everything here is disposable: the row is the
-- record of what to reap when it expires or the room goes away.
CREATE TABLE IF NOT EXISTS preview_envs (
  room_id     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  port        INTEGER NOT NULL DEFAULT 3000,
  command     TEXT,
  process_id  TEXT,
  db_path     TEXT,
  status      TEXT NOT NULL DEFAULT 'stopped',
  last_seen_at INTEGER,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preview_expires ON preview_envs(expires_at);
