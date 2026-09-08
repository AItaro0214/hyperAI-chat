-- hyperAI-chat : initial schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  pw_hash         TEXT NOT NULL,
  pw_salt         TEXT NOT NULL,
  pw_algo         TEXT NOT NULL DEFAULT 'pbkdf2c-v1',
  pw_iter         INTEGER NOT NULL DEFAULT 600000,
  pw_changed_at   INTEGER,
  totp_secret_enc TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  recovery_codes  TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_at       INTEGER,
  last_login_at   INTEGER,
  is_admin        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,          -- sha256(token)
  user_id      TEXT NOT NULL,
  mfa_ok       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  ua           TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS login_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  email  TEXT,
  kind   TEXT NOT NULL,      -- password | totp | recovery | logout | lock | unlock | pw_change | totp_reset
  ok     INTEGER NOT NULL,
  detail TEXT,
  ip     TEXT,
  ua     TEXT,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_events_at ON login_events(at DESC);

-- API keys etc. AES-256-GCM sealed with the MASTER_KEY worker secret.
CREATE TABLE IF NOT EXISTS app_secrets (
  key        TEXT PRIMARY KEY,   -- OPENROUTER_API_KEY | GROQ_API_KEY
  value_enc  TEXT NOT NULL,
  hint       TEXT,               -- masked preview, safe to display
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,      -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  system_prompt TEXT,
  web_search    INTEGER NOT NULL DEFAULT 0,
  temperature   REAL,
  max_tokens    INTEGER,
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  total_cost    REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rooms_user ON rooms(user_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  role              TEXT NOT NULL,           -- user | assistant | system
  content           TEXT NOT NULL DEFAULT '',
  reasoning         TEXT,
  provider          TEXT,
  model             TEXT,
  attachments       TEXT,                    -- JSON array
  annotations       TEXT,                    -- JSON array (web citations)
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost              REAL,
  meta              TEXT,                    -- JSON
  error             TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  room_id    TEXT,
  kind       TEXT,        -- image | audio | doc
  mime       TEXT,
  name       TEXT,
  size       INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT,
  room_id           TEXT,
  provider          TEXT,
  model             TEXT,
  kind              TEXT,      -- chat | image | asr | tts | web_search
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  units             REAL,      -- seconds of audio / characters / searches
  cost              REAL,
  at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_log(at DESC);
