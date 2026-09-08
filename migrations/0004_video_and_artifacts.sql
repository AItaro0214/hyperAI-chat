-- Asynchronous video generation jobs (OpenRouter POST /api/v1/videos)
CREATE TABLE IF NOT EXISTS video_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  room_id      TEXT,
  message_id   TEXT,
  provider_job TEXT,
  model        TEXT NOT NULL,
  prompt       TEXT NOT NULL,
  params       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  file_id      TEXT,
  video_url    TEXT,
  cost         REAL,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_jobs_user ON video_jobs(user_id, created_at DESC);

-- Runnable HTML/SVG snippets extracted from assistant answers
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  room_id    TEXT,
  message_id TEXT,
  title      TEXT,
  kind       TEXT NOT NULL DEFAULT 'html',
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at DESC);
