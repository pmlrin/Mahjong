-- Additive PostgreSQL V2 schema. Store.initV2 applies the same idempotent definitions.
-- Run backfill with backend/src/migrate.ts while the single-writer service is stopped.
-- Rebuild does not update documents(kind='match') or recompute historical ranks.
CREATE TABLE IF NOT EXISTS history_summaries (
 match_id TEXT PRIMARY KEY, finished_at BIGINT NOT NULL,format TEXT NOT NULL,
 mode TEXT NOT NULL,status TEXT NOT NULL,payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS history_members (
 user_id TEXT NOT NULL,match_id TEXT NOT NULL,seat INTEGER NOT NULL,
 finished_at BIGINT NOT NULL,format TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,
 rank INTEGER,net_points INTEGER NOT NULL,PRIMARY KEY(user_id,match_id)
);
CREATE INDEX IF NOT EXISTS history_user_time ON history_members(user_id,finished_at DESC,match_id DESC);
CREATE INDEX IF NOT EXISTS history_user_filter ON history_members(user_id,format,mode,finished_at DESC,match_id DESC);
CREATE TABLE IF NOT EXISTS replay_positions (user_id TEXT NOT NULL,match_id TEXT NOT NULL,payload JSONB NOT NULL,PRIMARY KEY(user_id,match_id));
CREATE TABLE IF NOT EXISTS migration_issues (match_id TEXT PRIMARY KEY,reason TEXT NOT NULL);
