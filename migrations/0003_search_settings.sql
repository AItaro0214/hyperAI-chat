-- Per-room Groq web search tuning (JSON: includeDomains / excludeDomains / country / snippetOnly)
ALTER TABLE rooms ADD COLUMN search_settings TEXT;
