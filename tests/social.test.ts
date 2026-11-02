import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, password } from "./social-fixture.ts";
import {
  friendCodeSchema,
  nicknameSchema,
  AVATARS,
  avatarSchema,
} from "../shared/social.ts";
import { ensureSocialProfile } from "../backend/src/social/schema.ts";
import { SocialService } from "../backend/src/social/service.ts";
const code = (value: string) => (e: any) => e.code === value;
const DAY = 86400000;
test("V4 T02/T03/T11: exact friend codes, Unicode names and closed avatar catalog", () => {
  assert.equal(AVATARS.length, 12);
  assert.equal(new Set(AVATARS.map((a) => a.id)).size, 12);
  assert.equal(nicknameSchema.parse(" e\u0301😀 "), "é😀");
  assert(nicknameSchema.safeParse("😀".repeat(16)).success);
  for (const v of ["", "😀".repeat(17), "a\nb", "a\u202eb", "a\u0000b"])
    assert(!nicknameSchema.safeParse(v).success);
  assert(!avatarSchema.safeParse("https://evil.example/a.svg").success);
  assert.equal(friendCodeSchema.parse(" abcd-efgh-jklm "), "ABCDEFGHJKLM");
  for (const v of [
    "123456",
    "ABCDEFGHIJKL",
    "a@example.com",
    "张三",
    "*",
    "ſBCDEFGHJKLM",
    "ßCDEFGHJKLM",
  ])
    assert(!friendCodeSchema.safeParse(v).success);
});
test("V4 T01/T04/T05/T06: profile CAS, rename budget, avatar-only update, occupancy and immutable old records", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const p = await f.social.profile(f.ctx(0));
  const before = f.users[0].tokenHash;
  const old = { players: [{ userId: f.users[0].id, displayName: "旧昵称" }] };
  await f.store.commit([{ kind: "match", id: "legacy", data: old }]);
  const ctx = f.ctx(0);
  await f.social.updateProfile(ctx, {
    displayName: "新昵称",
    avatarId: "plum",
    expectedProfileVersion: p.profileVersion,
  });
  assert.equal((await f.social.profile(f.ctx(0))).profileVersion, 2);
  await f.social.updateProfile(ctx, {
    displayName: "新昵称",
    avatarId: "plum",
    expectedProfileVersion: 1,
  });
  assert.equal(f.auth.resolveHash(before)!.displayName, "新昵称");
  assert.deepEqual(await f.store.get("match", "legacy"), old);
  await assert.rejects(
    f.social.updateProfile(f.ctx(0), {
      displayName: "另一名",
      avatarId: "plum",
      expectedProfileVersion: 1,
    }),
    code("PROFILE_VERSION_CONFLICT"),
  );
  await assert.rejects(
    f.social.updateProfile(f.ctx(0), {
      displayName: "另一名",
      avatarId: "plum",
      expectedProfileVersion: 2,
    }),
    code("NICKNAME_COOLDOWN"),
  );
  await f.social.updateProfile(f.ctx(0), {
    displayName: "新昵称",
    avatarId: "moon",
    expectedProfileVersion: 2,
  });
  const r = await f.room([0]);
  await assert.rejects(
    f.social.updateProfile(f.ctx(0), {
      displayName: "新昵称",
      avatarId: "sun",
      expectedProfileVersion: 3,
    }),
    code("PROFILE_CHANGE_IN_ROOM"),
  );
  r.status = "CLOSED";
  await f.store.commit([{ kind: "room", id: r.roomId, data: r }]);
  f.advance(DAY);
  await f.social.updateProfile(f.ctx(0), {
    displayName: "另一名",
    avatarId: "moon",
    expectedProfileVersion: 3,
  });
  const guest = await f.auth.createGuest("游客", randomUUID());
  await assert.rejects(
    f.social.profile({ ...f.ctx(0), tokenHash: guest.identity.tokenHash }),
    code("ACCOUNT_REQUIRED"),
  );
});
test("V4 T11: random code unique conflict retries and repeat migration preserve all codes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.store.transaction(async (tx) => {
    const id = "new";
    await tx.query("INSERT INTO auth_users VALUES(?,'new','ACCOUNT',?)", [
      id,
      f.now(),
    ]);
    await tx.query(
      "INSERT INTO auth_accounts SELECT ?,?,?,email_verified_at,password_hash,auth_version,updated_at FROM auth_accounts LIMIT 1",
      [id, "new@example.com", "new@example.com"],
    );
    let i = 0;
    await ensureSocialProfile(tx, id, () =>
      i++ === 0 ? f.codes[0] : "ZZZZZZZZZZZZ",
    );
    assert.equal(
      (await tx.one("SELECT friend_code FROM social_profiles WHERE user_id=?", [
        id,
      ]))!.friend_code,
      "ZZZZZZZZZZZZ",
    );
  });
  await f.auth.initialize();
  assert.deepEqual(
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        f.social.profile(f.ctx(i)).then((p) => p.friendCode),
      ),
    ),
    f.codes,
  );
});
test("V4 T12/T13/T14: minimal lookup, duplicate and crossed requests, explicit accept and replay", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const found = await f.social.lookup(f.ctx(0), f.codes[1]);
  assert.deepEqual(Object.keys(found).sort(), [
    "avatarId",
    "displayName",
    "friendCode",
    "relationship",
  ]);
  assert.equal(
    (await f.social.lookup(f.ctx(0), f.codes[0])).relationship,
    "SELF",
  );
  const [a, b] = await Promise.all([
    f.social.sendRequest(f.ctx(0), f.codes[1]),
    f.social.sendRequest(f.ctx(1), f.codes[0]),
  ]);
  assert.equal(a.requestId, b.requestId);
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 0);
  const ctx = f.ctx(1);
  await f.social.requestAction(ctx, a.requestId, "ACCEPTED", 1);
  await f.social.requestAction(ctx, a.requestId, "ACCEPTED", 1);
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 1);
  assert.equal((await f.social.snapshot(f.ctx(1))).friends.length, 1);
  await assert.rejects(
    f.social.requestAction(f.ctx(0), a.requestId, "CANCELED", 1),
    code("REQUEST_STATE_CONFLICT"),
  );
  await assert.rejects(
    f.social.requestAction(f.ctx(2), a.requestId, "ACCEPTED", 1),
    code("NOT_FOUND"),
  );
});
test("V4 T13/T15: exact expiration, refusal cooldown, account limits and durable rolling lookup rate", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const r = await f.social.sendRequest(f.ctx(0), f.codes[1]);
  await f.social.requestAction(f.ctx(1), r.requestId, "REJECTED", 1);
  await assert.rejects(
    f.social.sendRequest(f.ctx(0), f.codes[1]),
    code("SOCIAL_COOLDOWN"),
  );
  f.advance(DAY);
  const again = await f.social.sendRequest(f.ctx(0), f.codes[1]);
  f.advance(7 * DAY);
  await assert.rejects(
    f.social.requestAction(f.ctx(1), again.requestId, "ACCEPTED", 1),
    code("REQUEST_STATE_CONFLICT"),
  );
  assert.equal((await f.social.snapshot(f.ctx(1))).receivedRequests.length, 0);
  f.social.limits.lookupMinute = 2;
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      f.social.lookup(f.ctx(0), "ZZZZZZZZZZZZ"),
      code("NOT_FOUND"),
    );
  await assert.rejects(
    f.social.lookup(f.ctx(0), f.codes[1]),
    code("SOCIAL_RATE_LIMITED"),
  );
  f.advance(60000);
  assert.equal(
    (await f.social.lookup(f.ctx(0), f.codes[1])).friendCode,
    f.codes[1],
  );
});
test("V4 T16/T17: blocks atomically remove reciprocal friendship and invitations, remain in room and unlock never restores", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  const r = await f.room([0, 1]);
  const invite = await f.social.invite(f.ctx(0), {
    roomId: r.roomId,
    recipientFriendCode: f.codes[1],
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  await f.social.block(f.ctx(1), f.codes[0]);
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 0);
  assert.equal((await f.social.snapshot(f.ctx(1))).friends.length, 0);
  assert.equal(
    (await f.social.snapshot(f.ctx(1))).receivedInvitations.length,
    0,
  );
  assert.equal(
    (await f.store.get<any>("room", r.roomId)).slots.filter(Boolean).length,
    2,
  );
  await assert.rejects(
    f.social.lookup(f.ctx(0), f.codes[1]),
    code("NOT_FOUND"),
  );
  await assert.rejects(
    f.social.sendRequest(f.ctx(0), f.codes[1]),
    code("NOT_FOUND"),
  );
  await assert.rejects(
    f.social.invitationAction(f.ctx(1), invite.invitationId, "JOINED", 1),
    code("REQUEST_STATE_CONFLICT"),
  );
  assert.equal((await f.social.blocks(f.ctx(1))).items.length, 1);
  await f.social.block(f.ctx(1), f.codes[0], true);
  await assert.rejects(
    f.social.sendRequest(f.ctx(1), f.codes[0]),
    code("SOCIAL_COOLDOWN"),
  );
  assert.equal((await f.social.snapshot(f.ctx(1))).friends.length, 0);
});
test("V4 T19/T20/T21/T22: last-seat race, idempotent join and existing target membership preserves readiness", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  await f.friend(0, 2);
  const r = await f.room([0, 3]);
  r.slots[2] = {
    ...f.member(3),
    userId: null,
    participantKind: "BOT",
    botLevel: "STANDARD",
  };
  await f.store.commit([{ kind: "room", id: r.roomId, data: r }]);
  const a = await f.social.invite(f.ctx(0), {
      roomId: r.roomId,
      recipientFriendCode: f.codes[1],
      lobbyGeneration: 1,
      expectedRoomVersion: 1,
    }),
    b = await f.social.invite(f.ctx(0), {
      roomId: r.roomId,
      recipientFriendCode: f.codes[2],
      lobbyGeneration: 1,
      expectedRoomVersion: 1,
    });
  const key = f.ctx(1);
  const result = await Promise.allSettled([
    f.social.invitationAction(key, a.invitationId, "JOINED", 1),
    f.social.invitationAction(f.ctx(2), b.invitationId, "JOINED", 1),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const committed = await f.store.get<any>("room", r.roomId);
  assert.equal(committed.slots.filter(Boolean).length, 4);
  const version = committed.roomVersion;
  await f.social.invitationAction(key, a.invitationId, "JOINED", 1);
  assert.equal((await f.store.get<any>("room", r.roomId)).roomVersion, version);
  assert.equal(
    (await f.social.snapshot(f.ctx(2))).receivedInvitations.length,
    0,
  );
});
test("V4 T21/T23: another room cannot be left implicitly; host transfer and rematch invalidate invites transactionally", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  const r = await f.room([0]);
  await f.room([1]);
  const invite = await f.social.invite(f.ctx(0), {
    roomId: r.roomId,
    recipientFriendCode: f.codes[1],
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  await assert.rejects(
    f.social.invitationAction(f.ctx(1), invite.invitationId, "JOINED", 1),
    code("ALREADY_IN_ROOM"),
  );
  assert.equal(
    (await f.social.snapshot(f.ctx(1))).receivedInvitations.length,
    1,
  );
  r.lobbyGeneration++;
  await f.store.commit([{ kind: "room", id: r.roomId, data: r }]);
  assert.equal(
    (await f.social.snapshot(f.ctx(1))).receivedInvitations.length,
    0,
  );
  await assert.rejects(
    f.social.invitationAction(f.ctx(1), invite.invitationId, "JOINED", 1),
    code("REQUEST_STATE_CONFLICT"),
  );
});
test("V4 T07/T08/T09/T10: coarse session data, current-session protection, cross-account rejection, password failure and scoped revocation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first = await f.social.devices(f.ctx(0));
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].createdAt, null);
  assert.equal(first.items[0].current, true);
  assert(!JSON.stringify(first).includes(f.users[0].tokenHash));
  const login = await f.auth.login("test0@example.com", password, false, {
    tokenHash: null,
    requestId: randomUUID(),
    flowId: randomUUID(),
    ip: "192.0.2.20",
    device: { browser: "SAFARI", os: "IOS" },
  });
  const remote = f.auth.resolveToken(login.token!)!;
  const devices = await f.social.devices(f.ctx(0));
  assert.equal(devices.items.length, 2);
  const target = devices.items.find((d) => !d.current)!;
  assert.equal(target.browser, "SAFARI");
  assert.equal(target.os, "IOS");
  const own = devices.items.find((d) => d.current)!;
  await assert.rejects(
    f.social.revokeDevices(f.ctx(0), password, own.sessionId, randomUUID()),
    code("CURRENT_SESSION_NOT_ALLOWED"),
  );
  await assert.rejects(
    f.social.revokeDevices(f.ctx(1), password, target.sessionId, randomUUID()),
    code("NOT_FOUND"),
  );
  await assert.rejects(
    f.social.revokeDevices(f.ctx(0), "wrong", target.sessionId, randomUUID()),
    code("PASSWORD_INVALID"),
  );
  assert(f.auth.resolveHash(remote.tokenHash));
  const ctx = f.ctx(0),
    flow = randomUUID();
  await f.social.revokeDevices(ctx, password, target.sessionId, flow);
  await f.social.revokeDevices(ctx, password, target.sessionId, flow);
  assert.equal(f.auth.resolveHash(remote.tokenHash), null);
  assert(f.auth.resolveHash(f.users[0].tokenHash));
  assert(f.invalidated.includes(remote.tokenHash));
});
test("V4 T18/T24: multiple passive connections, grace, revocation and friends-only presence", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  f.social.connect("one", f.auth.resolveHash(f.users[1].tokenHash)!);
  assert.equal((await f.social.snapshot(f.ctx(0))).friends[0].status, "ONLINE");
  const r = await f.room([1]);
  assert.equal(
    (await f.social.snapshot(f.ctx(0))).friends[0].status,
    "WAITING",
  );
  f.social.connect("two", f.auth.resolveHash(f.users[1].tokenHash)!);
  f.social.disconnect("one");
  assert.equal(
    (await f.social.snapshot(f.ctx(0))).friends[0].status,
    "WAITING",
  );
  f.social.disconnect("two");
  f.advance(29999);
  assert.equal(
    (await f.social.snapshot(f.ctx(0))).friends[0].status,
    "WAITING",
  );
  f.advance(1);
  await f.social.presenceTick();
  assert.equal(
    (await f.social.snapshot(f.ctx(0))).friends[0].status,
    "OFFLINE",
  );
  assert.equal((await f.social.snapshot(f.ctx(2))).friends.length, 0);
  assert(
    !JSON.stringify((await f.social.snapshot(f.ctx(0))).friends).includes(
      r.roomId,
    ),
  );
});
test("V4 T26: injected precommit rollback leaves no half-friendship, no memory room publish and retries commit once", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  const r = await f.room([0]);
  const i = await f.social.invite(f.ctx(0), {
    roomId: r.roomId,
    recipientFriendCode: f.codes[1],
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  const transaction = f.store.transaction.bind(f.store);
  let inject = true;
  f.store.transaction = (fn) =>
    transaction(async (tx) => {
      const result = await fn(tx);
      if (
        inject &&
        (await tx.one(
          "SELECT invitation_id FROM room_invitations WHERE state='JOINED'",
        ))
      ) {
        inject = false;
        throw Error("INJECTED");
      }
      return result;
    });
  const ctx = f.ctx(1);
  await assert.rejects(
    f.social.invitationAction(ctx, i.invitationId, "JOINED", 1),
    /INJECTED/,
  );
  assert.equal(
    (await f.store.get<any>("room", r.roomId)).slots.filter(Boolean).length,
    1,
  );
  assert.equal(f.rooms.get(r.roomId)!.slots.filter(Boolean).length, 1);
  f.store.transaction = transaction;
  await f.social.invitationAction(ctx, i.invitationId, "JOINED", 1);
  assert.equal(
    (await f.store.get<any>("room", r.roomId)).slots.filter(Boolean).length,
    2,
  );
});
test("V4 T31: bounded cleanup retains active relations, fresh receipts and current sessions", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  await f.social.cleanup(1);
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 1);
  assert(f.auth.resolveHash(f.users[0].tokenHash));
  const audit = await f.store.transaction((tx) =>
    tx.rows("SELECT * FROM social_audit"),
  );
  assert(audit.length);
  assert(!JSON.stringify(audit).includes(password));
});

test("V4 T15/T22: incoming/friend limits and block-versus-accept have one legal outcome", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.social.limits.pendingRequests = 1;
  const a = await f.social.sendRequest(f.ctx(0), f.codes[1]);
  await assert.rejects(
    f.social.sendRequest(f.ctx(2), f.codes[1]),
    code("REQUEST_LIMIT_REACHED"),
  );
  f.social.limits.friends = 1;
  await f.friend(1, 3);
  await assert.rejects(
    f.social.requestAction(f.ctx(1), a.requestId, "ACCEPTED", 1),
    code("FRIEND_LIMIT_REACHED"),
  );
  assert.equal((await f.social.snapshot(f.ctx(1))).receivedRequests.length, 1);
  await f.social.block(f.ctx(1), f.codes[0]);
  await assert.rejects(
    f.social.requestAction(f.ctx(1), a.requestId, "ACCEPTED", 1),
    code("REQUEST_STATE_CONFLICT"),
  );
  assert.equal((await f.social.snapshot(f.ctx(0))).friends.length, 0);
});
test("V4 T20/T21: exact invite expiry and already-in-target full room do not reset ready or duplicate seats", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  const r = await f.room([0, 1]);
  const i = await f.social.invite(f.ctx(0), {
    roomId: r.roomId,
    recipientFriendCode: f.codes[1],
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  r.slots[0]!.ready = true;
  r.slots[1]!.ready = true;
  r.slots[2] = {
    ...f.member(2),
    userId: null,
    participantKind: "BOT",
    botLevel: "BASIC",
  };
  r.slots[3] = {
    ...f.member(3),
    userId: null,
    participantKind: "BOT",
    botLevel: "BASIC",
  };
  await f.store.commit([{ kind: "room", id: r.roomId, data: r }]);
  await f.social.invitationAction(f.ctx(1), i.invitationId, "JOINED", 1);
  const actual = await f.store.get<any>("room", r.roomId);
  assert(actual.slots[0].ready && actual.slots[1].ready);
  assert.equal(actual.roomVersion, 1);
});
test("V4 T26: unknown COMMIT reloads authoritative room; replay returns original join without duplicating", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.friend(0, 1);
  const r = await f.room([0]);
  const i = await f.social.invite(f.ctx(0), {
    roomId: r.roomId,
    recipientFriendCode: f.codes[1],
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  const transaction = f.store.transaction.bind(f.store);
  let inject = true;
  f.store.transaction = async (fn) => {
    const result = await transaction(fn);
    if (
      inject &&
      (await transaction((tx) =>
        tx.one(
          "SELECT invitation_id FROM room_invitations WHERE state='JOINED'",
        ),
      ))
    ) {
      inject = false;
      throw Error("COMMIT_UNKNOWN");
    }
    return result;
  };
  const ctx = f.ctx(1);
  await assert.rejects(
    f.social.invitationAction(ctx, i.invitationId, "JOINED", 1),
    /COMMIT_UNKNOWN/,
  );
  assert.equal(f.rooms.get(r.roomId)!.slots.filter(Boolean).length, 2);
  f.store.transaction = transaction;
  await f.social.invitationAction(ctx, i.invitationId, "JOINED", 1);
  assert.equal((await f.store.get<any>("room", r.roomId)).roomVersion, 2);
});

test("V4 T31: inactive expiration, cleanup and restart preserve relations without recreating old device metadata", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const r = await f.social.sendRequest(f.ctx(0), f.codes[1]);
  await f.social.requestAction(f.ctx(1), r.requestId, "ACCEPTED", 1);
  await f.social.sendRequest(f.ctx(2), f.codes[3]);
  const room = await f.room([0]);
  await f.social.invite(f.ctx(0), {
    recipientFriendCode: f.codes[1],
    roomId: room.roomId,
    lobbyGeneration: 1,
    expectedRoomVersion: 1,
  });
  const before = JSON.stringify(await f.store.get("room", room.roomId));
  f.advance(121 * DAY);
  await f.social.cleanup(100);
  const tables = await f.store.transaction(async (tx) => ({
    friends: Number((await tx.one("SELECT COUNT(*) AS n FROM friendships"))!.n),
    audit: Number((await tx.one("SELECT COUNT(*) AS n FROM social_audit"))!.n),
    sessions: Number(
      (await tx.one("SELECT COUNT(*) AS n FROM auth_sessions"))!.n,
    ),
    metadata: Number(
      (await tx.one("SELECT COUNT(*) AS n FROM social_sessions"))!.n,
    ),
    requests: Number(
      (await tx.one("SELECT COUNT(*) AS n FROM friend_requests"))!.n,
    ),
    invites: Number(
      (await tx.one("SELECT COUNT(*) AS n FROM room_invitations"))!.n,
    ),
  }));
  assert.deepEqual(tables, {
    friends: 1,
    audit: 0,
    sessions: 4,
    metadata: 0,
    requests: 0,
    invites: 0,
  });
  assert.equal(JSON.stringify(await f.store.get("room", room.roomId)), before);
  await f.auth.initialize();
  assert.equal(
    Number(
      (await f.store.transaction((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM social_sessions"),
      ))!.n,
    ),
    0,
  );
  const logged = await f.auth.login("test1@example.com", password, false, {
    tokenHash: null,
    ip: "192.0.2.11",
    requestId: randomUUID(),
    flowId: randomUUID(),
  });
  const ctx = {
    ...f.ctx(1),
    tokenHash: f.auth.resolveToken(logged.token!)!.tokenHash,
  };
  await assert.rejects(
    f.social.requestAction(ctx, r.requestId, "ACCEPTED", 1),
    code("NOT_FOUND"),
  );
  assert.equal((await f.social.snapshot(ctx)).friends.length, 1);
});
