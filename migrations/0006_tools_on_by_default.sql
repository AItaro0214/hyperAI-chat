-- Server-tool modes cost nothing unless the model actually calls them, so the
-- tools are offered by default instead of being opt-in.
ALTER TABLE rooms ADD COLUMN image_output INTEGER NOT NULL DEFAULT 1;
UPDATE rooms SET web_search = 1 WHERE web_search = 0;
