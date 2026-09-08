-- Generated images and video are dropped after three days (see media-retention.js).
-- The row outlives its blob so the transcript can show what used to be there.
ALTER TABLE files ADD COLUMN expired_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_files_reap ON files(kind, created_at);
