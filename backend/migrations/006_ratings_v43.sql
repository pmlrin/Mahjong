-- 等级分（rating）。PostgreSQL 与 SQLite 共用同一份定义；Store.initV2 在启动时幂等执行。
-- rating_settlements 的主键是结算的幂等键：每场正常结束的对局只结算一次。
-- 上线前已结束的对局不补算，所有人从初始分 900（一尾）开始。
CREATE TABLE IF NOT EXISTS player_ratings (user_id TEXT PRIMARY KEY,rating INTEGER NOT NULL,matches INTEGER NOT NULL,updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS rating_settlements (match_id TEXT PRIMARY KEY,settled_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS rating_changes (match_id TEXT NOT NULL,user_id TEXT NOT NULL,seat INTEGER NOT NULL,before_rating INTEGER NOT NULL,after_rating INTEGER NOT NULL,delta INTEGER NOT NULL,settled_at BIGINT NOT NULL,PRIMARY KEY(match_id,user_id));
CREATE INDEX IF NOT EXISTS rating_changes_user ON rating_changes(user_id,settled_at DESC);
