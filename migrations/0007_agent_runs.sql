-- Agent runs survive the browser closing, so their progress lives in the
-- database rather than only in the open SSE stream.
CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  room_id     TEXT NOT NULL,
  instance_id TEXT,
  task        TEXT NOT NULL,
  provider    TEXT,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  steps       INTEGER NOT NULL DEFAULT 0,
  cost        REAL,
  preview_url TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_room ON agent_runs(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
