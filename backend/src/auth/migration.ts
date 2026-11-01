import type { Store } from "../store.ts";
import { AUTH_SCHEMA } from "./schema.ts";
import type { AuthConfig } from "./config.ts";
export async function migrateAuth(
  store: Store,
  config: AuthConfig,
  now = Date.now(),
) {
  await store.transaction(async (tx) => {
    for (const statement of AUTH_SCHEMA) await tx.query(statement);
    const identity = await tx.one(
      "SELECT environment FROM auth_environment WHERE singleton=1",
    );
    if (identity && identity.environment !== config.environment)
      throw Error("AUTH_ENVIRONMENT_MISMATCH");
    await tx.query(
      "INSERT INTO auth_environment(singleton,environment) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING",
      [config.environment],
    );
  });
  const done = await store.transaction((tx) =>
    tx.one("SELECT name FROM auth_migrations WHERE name='users-v3'"),
  );
  if (done)
    return { alreadyApplied: true, users: 0, sessions: 0, conflicts: 0 };
  const users = new Map<string, { name: string; at: number; source: string }>(),
    conflicts = new Set<string>();
  const candidate = (id: string, name: string, at: number, source: string) => {
    if (!id || !name) return;
    const old = users.get(id);
    if (old && old.name !== name) conflicts.add(id);
    if (
      !old ||
      (source === "session" && old.source !== "session") ||
      (source === old.source && at > old.at)
    )
      users.set(id, { name, at, source });
  };
  const sessions = await store.list<any>("session");
  for (const { data: s } of sessions)
    candidate(s.userId, s.displayName, s.expires ?? now, "session");
  for (const { data: r } of await store.list<any>("room"))
    for (const m of r.slots ?? [])
      if (m?.userId) candidate(m.userId, m.displayName, 0, "room");
  let cursor = "";
  while (true) {
    const rows = await store.scanMatches(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      for (const p of row.data.players ?? [])
        if (p.userId)
          candidate(p.userId, p.displayName, row.data.createdAt ?? 0, "match");
    }
  }
  await store.transaction(async (tx) => {
    for (const [id, u] of users)
      await tx.query(
        "INSERT INTO auth_users(user_id,display_name,kind,created_at) VALUES(?,?,'GUEST',?) ON CONFLICT(user_id) DO NOTHING",
        [id, u.name, now],
      );
    for (const { id, data: s } of sessions)
      if (users.has(s.userId))
        await tx.query(
          "INSERT INTO auth_sessions(token_hash,user_id,auth_version,environment,created_at,expires_at,revoked_at) VALUES(?,?,0,?,?,?,NULL) ON CONFLICT(token_hash) DO NOTHING",
          [
            id,
            s.userId,
            config.environment,
            Math.max(0, (s.expires ?? now) - 30 * 86400000),
            s.expires ?? 0,
          ],
        );
    for (const userId of conflicts)
      await tx.query(
        "INSERT INTO auth_migration_issues(user_id,reason) VALUES(?,'DISPLAY_NAME_CONFLICT_SESSION_THEN_LATEST_SNAPSHOT') ON CONFLICT(user_id,reason) DO NOTHING",
        [userId],
      );
    await tx.query(
      "INSERT INTO auth_migrations(name,applied_at,details) VALUES('users-v3',?,?)",
      [
        now,
        JSON.stringify({
          users: users.size,
          sessions: sessions.length,
          conflicts: conflicts.size,
        }),
      ],
    );
  });
  return {
    users: users.size,
    sessions: sessions.length,
    conflicts: conflicts.size,
  };
}
