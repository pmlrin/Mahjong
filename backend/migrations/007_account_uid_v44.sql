-- v4.4: 好友码停用，正式账号改用 UID。
-- 实际执行在 backend/src/social/schema.ts 的 migrateUid / protectUid，随 AuthService.initialize 在启动时幂等运行；
-- 本文件记录两种数据库的等价 SQL，供审阅和手工恢复。
--
-- 规则：
-- * UID 只发给正式账号（social_profiles 只有正式账号的行），从 100000 起，唯一，发出后不再改变。
-- * 已有账号按 auth_users.created_at 升序、同一时间再按 user_id 升序依次补发。
-- * 之后新注册的账号在建号的那个事务里取 MAX(uid)+1；UNIQUE 约束兜底，撞号时重试。
-- * 游客没有 UID；游客升级成正式账号时，在升级的那一刻发号。
-- * friend_code 列随表重建一起删除。

-- ---------- 两种数据库通用：重建 social_profiles ----------
CREATE TABLE social_profiles_uid (
  user_id TEXT PRIMARY KEY REFERENCES auth_accounts(user_id),
  avatar_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  last_nickname_changed_at BIGINT,
  uid INTEGER NOT NULL UNIQUE CHECK(uid>=100000)
);
INSERT INTO social_profiles_uid(user_id,avatar_id,profile_version,last_nickname_changed_at,uid)
SELECT a.user_id,
       COALESCE(p.avatar_id,'bamboo'),
       COALESCE(p.profile_version,1),
       p.last_nickname_changed_at,
       99999 + ROW_NUMBER() OVER (ORDER BY u.created_at,a.user_id)
FROM auth_accounts a
JOIN auth_users u ON u.user_id=a.user_id
LEFT JOIN social_profiles p ON p.user_id=a.user_id;
DROP TABLE social_profiles;
ALTER TABLE social_profiles_uid RENAME TO social_profiles;
INSERT INTO social_user_state(user_id,revision)
SELECT user_id,0 FROM social_profiles ON CONFLICT DO NOTHING;

-- ---------- SQLite：UID 不可修改 ----------
CREATE TRIGGER IF NOT EXISTS social_profiles_uid_immutable
BEFORE UPDATE OF uid ON social_profiles FOR EACH ROW WHEN NEW.uid IS NOT OLD.uid
BEGIN SELECT RAISE(ABORT,'UID_IMMUTABLE'); END;

-- ---------- PostgreSQL：UID 不可修改 ----------
-- CREATE OR REPLACE FUNCTION social_profiles_uid_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
-- BEGIN IF NEW.uid IS DISTINCT FROM OLD.uid THEN RAISE EXCEPTION 'UID_IMMUTABLE'; END IF; RETURN NEW; END $$;
-- DROP TRIGGER IF EXISTS social_profiles_uid_immutable ON social_profiles;
-- CREATE TRIGGER social_profiles_uid_immutable BEFORE UPDATE OF uid ON social_profiles
--   FOR EACH ROW EXECUTE FUNCTION social_profiles_uid_immutable();

-- 新账号发号（两种数据库通用，在建号事务里执行）：
-- INSERT INTO social_profiles(user_id,avatar_id,profile_version,last_nickname_changed_at,uid)
-- SELECT ?, 'bamboo', 1, NULL, COALESCE(MAX(uid),99999)+1 FROM social_profiles ON CONFLICT DO NOTHING;
