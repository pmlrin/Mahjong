import { randomInt, randomUUID } from "node:crypto";
import type { Sql } from "../sql.ts";
export const SOCIAL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS social_profiles (user_id TEXT PRIMARY KEY REFERENCES auth_accounts(user_id),avatar_id TEXT NOT NULL,profile_version INTEGER NOT NULL,last_nickname_changed_at BIGINT,friend_code TEXT NOT NULL UNIQUE)",
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
];
export const FRIEND_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export async function ensureSocialProfile(
  tx: Sql,
  userId: string,
  generate = () =>
    Array.from(
      { length: 12 },
      () => FRIEND_ALPHABET[randomInt(FRIEND_ALPHABET.length)],
    ).join(""),
) {
  if (
    await tx.one("SELECT user_id FROM social_profiles WHERE user_id=?", [
      userId,
    ])
  )
    return;
  // ON CONFLICT preserves the PostgreSQL transaction on a random-code collision.
  for (let attempt = 0; attempt < 32; attempt++) {
    const code = generate();
    const inserted = await tx.query(
      "INSERT INTO social_profiles(user_id,avatar_id,profile_version,last_nickname_changed_at,friend_code) VALUES(?,'bamboo',1,NULL,?) ON CONFLICT DO NOTHING",
      [userId, code],
    );
    if (inserted.changes) {
      await tx.query(
        "INSERT INTO social_user_state(user_id,revision) VALUES(?,0) ON CONFLICT DO NOTHING",
        [userId],
      );
      return;
    }
  }
  throw Error("FRIEND_CODE_ALLOCATION_FAILED");
}
export async function migrateSocial(tx: Sql, now = Date.now()) {
  for (const statement of SOCIAL_SCHEMA) await tx.query(statement);
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
