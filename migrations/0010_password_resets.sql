-- Password reset by e-mail. Only sha256(token) is stored; the token itself
-- exists in the mail and nowhere else.
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,           -- sha256(token)
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  ip         TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at DESC);
