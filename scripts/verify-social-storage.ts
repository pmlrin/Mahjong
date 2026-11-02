// Destructive fixture writes are limited to a new, empty mahjong_v4_test_* DB.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fixture, password } from "../tests/social-fixture.ts";
const f = await fixture(process.env.V4_TEST_DATABASE_URL);
const checks: string[] = [];
try {
  const codes = [...f.codes];
  await f.auth.initialize();
  assert.deepEqual(
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        f.social.profile(f.ctx(i)).then((p) => p.friendCode),
      ),
    ),
    codes,
  );
  checks.push("migration rerun preserves codes, user IDs, names and sessions");
  await f.social.updateProfile(f.ctx(0), {
    displayName: "资料验证",
    avatarId: "crane",
    expectedProfileVersion: 1,
  });
  assert.equal(
    f.auth.resolveHash(f.users[0].tokenHash)!.displayName,
    "资料验证",
  );
  checks.push("profile CAS commits with authoritative identity cache");
  const [a, b] = await Promise.all([
    f.social.sendRequest(f.ctx(0), f.codes[1]),
    f.social.sendRequest(f.ctx(1), f.codes[0]),
  ]);
  assert.equal(a.requestId, b.requestId);
  await f.social.requestAction(f.ctx(1), a.requestId, "ACCEPTED", 1);
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 1);
  checks.push("crossed request uniqueness and reciprocal friendship");
  const room = await f.room([0]);
  const i = await f.social.invite(f.ctx(0), {
    recipientFriendCode: f.codes[1],
    roomId: room.roomId,
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  const ctx = f.ctx(1);
  await f.social.invitationAction(ctx, i.invitationId, "JOINED", 1);
  await f.social.invitationAction(ctx, i.invitationId, "JOINED", 1);
  assert.equal(
    (await f.store.get<any>("room", room.roomId)).slots.filter(Boolean).length,
    2,
  );
  checks.push("invitation join, room, revision and receipt commit once");
  const tx = f.store.transaction.bind(f.store);
  let inject = true;
  f.store.transaction = (fn) =>
    tx(async (q) => {
      const result = await fn(q);
      if (inject && !(await q.one("SELECT pair_key FROM friendships"))) {
        inject = false;
        throw Error("ROLLBACK_TEST");
      }
      return result;
    });
  await assert.rejects(f.social.block(f.ctx(0), f.codes[1]), /ROLLBACK_TEST/);
  f.store.transaction = tx;
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 1);
  checks.push(
    "failed transaction rolls back block, friendship and receipts together",
  );
  await f.social.block(f.ctx(0), f.codes[1]);
  await assert.rejects(
    f.social.lookup(f.ctx(1), f.codes[0]),
    (e: any) => e.code === "NOT_FOUND",
  );
  checks.push("block privacy and shared room preserved");
  const remote = await f.auth.login("test0@example.com", password, false, {
    tokenHash: null,
    flowId: randomUUID(),
    requestId: randomUUID(),
    ip: "192.0.2.99",
  });
  const sessions = await f.social.devices(f.ctx(0));
  await f.social.revokeDevices(
    f.ctx(0),
    password,
    sessions.items.find((s) => !s.current)!.sessionId,
    randomUUID(),
  );
  assert.equal(f.auth.resolveToken(remote.token!), null);
  assert(f.auth.resolveHash(f.users[0].tokenHash));
  checks.push(
    "session revocation preserves current session and authoritative cache",
  );
  await f.friend(2, 3);
  const otherRoom = await f.room([2]);
  const otherInvite = await f.social.invite(f.ctx(2), {
    recipientFriendCode: f.codes[3],
    roomId: otherRoom.roomId,
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  const originalTransaction = f.store.transaction.bind(f.store);
  let unknownCommit = true;
  f.store.transaction = async (fn) => {
    const result = await originalTransaction(fn);
    if (
      unknownCommit &&
      (await originalTransaction((q) =>
        q.one(
          "SELECT invitation_id FROM room_invitations WHERE invitation_id=? AND state='JOINED'",
          [otherInvite.invitationId],
        ),
      ))
    ) {
      unknownCommit = false;
      throw Error("INJECTED_COMMIT_ACK_LOST");
    }
    return result;
  };
  const joining = f.ctx(3);
  try {
    await assert.rejects(
      f.social.invitationAction(joining, otherInvite.invitationId, "JOINED", 1),
      /INJECTED_COMMIT_ACK_LOST/,
    );
  } finally {
    f.store.transaction = originalTransaction;
  }
  assert.equal(f.rooms.get(otherRoom.roomId)!.slots.filter(Boolean).length, 2);
  await f.social.invitationAction(
    joining,
    otherInvite.invitationId,
    "JOINED",
    1,
  );
  assert.equal(
    (await f.store.get<any>("room", otherRoom.roomId)).roomVersion,
    2,
  );
  checks.push(
    "injected lost COMMIT acknowledgement reloads authoritative room and replay commits no duplicate seat",
  );
  f.advance(60001);
  await f.social.invite(f.ctx(2), {
    recipientFriendCode: f.codes[3],
    roomId: otherRoom.roomId,
    lobbyGeneration: 1,
    expectedRoomVersion: 2,
  });
  await f.social.sendRequest(f.ctx(0), f.codes[2]);
  const frozenRooms = JSON.stringify(await f.store.list("room"));
  f.advance(121 * 86400000);
  await f.social.cleanup(100);
  await f.auth.initialize();
  for (const table of [
    "social_sessions",
    "friend_requests",
    "room_invitations",
  ])
    assert.equal(
      Number(
        (await f.store.transaction((q) =>
          q.one("SELECT COUNT(*) AS n FROM " + table),
        ))!.n,
      ),
      0,
    );
  assert.equal(
    Number(
      (await f.store.transaction((q) =>
        q.one("SELECT COUNT(*) AS n FROM friendships"),
      ))!.n,
    ),
    1,
  );
  assert.equal(
    Number(
      (await f.store.transaction((q) =>
        q.one("SELECT COUNT(*) AS n FROM auth_sessions"),
      ))!.n,
    ),
    5,
  );
  assert.equal(JSON.stringify(await f.store.list("room")), frozenRooms);
  checks.push(
    "121-day cleanup expires inactive requests and invitations; restart does not recreate device metadata; friendship and auth session records remain",
  );
  const counts = await f.store.transaction(async (q) => {
    const tables = f.store.pool
      ? await q.rows(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      : await q.rows(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
    const summary = [];
    for (const row of tables) {
      assert(/^[a-z_]+$/.test(row.name));
      const data = await q.rows("SELECT * FROM " + row.name);
      const h = createHash("sha256")
        .update(
          data
            .map((r) => JSON.stringify(r))
            .sort()
            .join("\n"),
        )
        .digest("hex");
      summary.push({ table: row.name, rows: data.length, sha256: h });
    }
    return summary;
  });
  console.log(
    JSON.stringify({
      version: "0.4.0",
      database: f.store.pool ? "PostgreSQL" : "SQLite",
      isolated: true,
      checks,
      tables: counts,
      passed: true,
    }),
  );
} finally {
  await f.close();
}
