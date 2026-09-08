-- Per-room web search engine and reasoning effort.
ALTER TABLE rooms ADD COLUMN web_search_engine TEXT;
ALTER TABLE rooms ADD COLUMN reasoning_effort TEXT;
