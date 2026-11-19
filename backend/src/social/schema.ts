import { randomUUID } from "node:crypto";
import type { Sql } from "../sql.ts";
const PROFILE_TABLE = (name: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (user_id TEXT PRIMARY KEY REFERENCES auth_accounts(user_id),avatar_id TEXT NOT NULL,profile_version INTEGER NOT NULL,last_nickname_changed_at BIGINT,uid INTEGER NOT NULL UNIQUE CHECK(uid>=100000))`;
export const SOCIAL_SCHEMA = [
  PROFILE_TABLE("social_profiles"),
  "CREATE TABLE IF NOT EXISTS social_user_state (user_id TEXT PRIMARY KEY REFERENCES auth_accounts(user_id),revision BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS social_sessions (session_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE REFERENCES auth_sessions(token_hash),user_id TEXT NOT NULL,browser TEXT NOT NULL,os TEXT NOT NULL,created_at BIGINT,last_seen_at BIGINT)",
  "CREATE INDEX IF NOT EXISTS social_session_user ON social_sessions(user_id,session_id)",
  "CREATE TABLE IF NOT EXISTS friendships (pair_key TEXT PRIMARY KEY,low_id TEXT NOT NULL,high_id TEXT NOT NULL,created_at BIGINT NOT NULL,UNIQUE(low_id,high_id),CHECK(low_id<high_id))",
  "CREATE INDEX IF NOT EXISTS friendship_high ON friendships(high_id)",
  "CREATE TABLE IF NOT EXISTS friend_requests (request_id TEXT PRIMARY KEY,pair_key TEXT NOT NULL,sender_id TEXT NOT NULL,recipient_id TEXT NOT NULL,state TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,version INTEGER NOT NULL,CHECK(sender_id<>recipient_id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS friend_request_pending ON friend_requests(pair_key) WHERE state='PENDING'",
  "CREATE INDEX IF NOT EXISTS friend_request_recipient ON friend_requests(recipient_id,state,expires_at)",
  "CREATE INDEX IF NOT EXISTS friend_request_sender ON friend_requests(sender_id,state,expires_at)",
  "CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL,blocked_id TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(blocker_id,blocked_id),CHECK(blocker_id<>blocked_id))",
  "CREATE TABLE IF NOT EXISTS room_invitations (invitation_id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,recipient_id TEXT NOT NULL,room_id TEXT NOT NULL,lobby_generation INTEGER NOT NULL,state TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,version INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS invitation_pending ON room_invitations(sender_id,recipient_id,room_id,lobby_generation) WHERE state='PENDING'",
  "CREATE INDEX IF NOT EXISTS invitation_recipient ON room_invitations(recipient_id,state,expires_at)",
  "CREATE INDEX IF NOT EXISTS invitation_sender ON room_invitations(sender_id,state,expires_at)",
  "CREATE INDEX IF NOT EXISTS invitation_room ON room_invitations(room_id,state)",
  "CREATE TABLE IF NOT EXISTS social_cooldowns (scope TEXT PRIMARY KEY,until_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS social_limits (bucket TEXT NOT NULL,entry_id TEXT PRIMARY KEY,at BIGINT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS social_limit_window ON social_limits(bucket,at)",
  "CREATE TABLE IF NOT EXISTS social_receipts (scope TEXT NOT NULL,request_id TEXT NOT NULL,payload_hmac TEXT NOT NULL,result TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(scope,request_id))",
  "CREATE TABLE IF NOT EXISTS social_audit (audit_id TEXT PRIMARY KEY,event TEXT NOT NULL,actor_id TEXT NOT NULL,subject_id TEXT,at BIGINT NOT NULL,result TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS avatar_assets (avatar_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_accounts(user_id),sha256 TEXT NOT NULL,png_base64 TEXT NOT NULL,created_at BIGINT NOT NULL,UNIQUE(user_id,sha256))",
  "CREATE INDEX IF NOT EXISTS avatar_asset_owner ON avatar_assets(user_id,created_at)",
];
/** The first UID handed out; accounts then count up in registration order. */
export const FIRST_UID = 100000;
/**
 * Every account gets a permanent numeric UID the moment it becomes an
 * account: at registration, or when a guest upgrades. Guests have no row
 * here and therefore no UID. The UNIQUE constraint is the last line against
 * a duplicate; allocation retries on conflict.
 */
export async function ensureSocialProfile(tx: Sql, userId: string) {
  if (
    await tx.one("SELECT user_id FROM social_profiles WHERE user_id=?", [
      userId,
    ])
  )
    return;
  // ON CONFLICT keeps the PostgreSQL transaction usable if two writers race.
  for (let attempt = 0; attempt < 8; attempt++) {
    const next = await tx.one<{ n: number | string }>(
      "SELECT COALESCE(MAX(uid)," + (FIRST_UID - 1) + ")+1 AS n FROM social_profiles",
    );
    const inserted = await tx.query(
      "INSERT INTO social_profiles(user_id,avatar_id,profile_version,last_nickname_changed_at,uid) VALUES(?,'bamboo',1,NULL,?) ON CONFLICT DO NOTHING",
      [userId, Number(next!.n)],
    );
    if (inserted.changes) {
      await tx.query(
        "INSERT INTO social_user_state(user_id,revision) VALUES(?,0) ON CONFLICT DO NOTHING",
        [userId],
      );
      return;
    }
  }
  throw Error("UID_ALLOCATION_FAILED");
}
async function columns(tx: Sql, table: string) {
  const rows = tx.postgres
    ? await tx.rows(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?",
        [table],
      )
    : await tx.rows("PRAGMA table_info(" + table + ")");
  return new Set(rows.map((r) => String(r.name)));
}
/**
 * v4.4: friend codes give way to UIDs. Rebuilds social_profiles without
 * friend_code and with uid, numbering every existing account from 100000 by
 * auth_users.created_at, then user_id. Accounts that somehow lack a profile
 * are numbered in the same pass. Idempotent; see
 * backend/migrations/007_account_uid_v44.sql for the equivalent SQL.
 */
export async function migrateUid(tx: Sql) {
  const existing = await columns(tx, "social_profiles");
  if (existing.has("uid") && !existing.has("friend_code")) return false;
  await tx.query("DROP TABLE IF EXISTS social_profiles_uid");
  await tx.query(PROFILE_TABLE("social_profiles_uid"));
  const accounts = await tx.rows(
    "SELECT a.user_id,p.avatar_id,p.profile_version,p.last_nickname_changed_at FROM auth_accounts a JOIN auth_users u ON u.user_id=a.user_id LEFT JOIN social_profiles p ON p.user_id=a.user_id ORDER BY u.created_at,a.user_id",
  );
  let uid = FIRST_UID;
  for (const a of accounts)
    await tx.query(
      "INSERT INTO social_profiles_uid(user_id,avatar_id,profile_version,last_nickname_changed_at,uid) VALUES(?,?,?,?,?)",
      [
        a.user_id,
        a.avatar_id ?? "bamboo",
        a.profile_version == null ? 1 : Number(a.profile_version),
        a.last_nickname_changed_at == null
          ? null
          : Number(a.last_nickname_changed_at),
        uid++,
      ],
    );
  await tx.query("DROP TABLE social_profiles");
  await tx.query("ALTER TABLE social_profiles_uid RENAME TO social_profiles");
  for (const a of accounts)
    await tx.query(
      "INSERT INTO social_user_state(user_id,revision) VALUES(?,0) ON CONFLICT DO NOTHING",
      [a.user_id],
    );
  return true;
}
/** A UID never changes once issued; the database refuses an UPDATE of it. */
async function protectUid(tx: Sql) {
  if (tx.postgres) {
    await tx.query(
      "CREATE OR REPLACE FUNCTION social_profiles_uid_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid IS DISTINCT FROM OLD.uid THEN RAISE EXCEPTION 'UID_IMMUTABLE'; END IF; RETURN NEW; END $$",
    );
    await tx.query(
      "DROP TRIGGER IF EXISTS social_profiles_uid_immutable ON social_profiles",
    );
    await tx.query(
      "CREATE TRIGGER social_profiles_uid_immutable BEFORE UPDATE OF uid ON social_profiles FOR EACH ROW EXECUTE FUNCTION social_profiles_uid_immutable()",
    );
  } else
    await tx.query(
      "CREATE TRIGGER IF NOT EXISTS social_profiles_uid_immutable BEFORE UPDATE OF uid ON social_profiles FOR EACH ROW WHEN NEW.uid IS NOT OLD.uid BEGIN SELECT RAISE(ABORT,'UID_IMMUTABLE'); END",
    );
}
export async function migrateSocial(tx: Sql, now = Date.now()) {
  for (const statement of SOCIAL_SCHEMA) await tx.query(statement);
  await migrateUid(tx);
  await protectUid(tx);
  for (const a of await tx.rows("SELECT user_id FROM auth_accounts"))
    await ensureSocialProfile(tx, a.user_id);
  for (const s of await tx.rows(
    "SELECT s.token_hash,s.user_id FROM auth_sessions s JOIN auth_accounts a ON a.user_id=s.user_id LEFT JOIN social_sessions d ON d.token_hash=s.token_hash WHERE d.session_id IS NULL AND s.expires_at>=? AND (s.revoked_at IS NULL OR s.revoked_at>=?)",
    [now - 30 * 86400000, now - 30 * 86400000],
  ))
    await tx.query(
      "INSERT INTO social_sessions(session_id,token_hash,user_id,browser,os,created_at,last_seen_at) VALUES(?,?,?,'UNKNOWN','UNKNOWN',NULL,NULL) ON CONFLICT(token_hash) DO NOTHING",
      [randomUUID(), s.token_hash, s.user_id],
    );
}
