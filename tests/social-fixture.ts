import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../backend/src/store.ts";
import { AuthService } from "../backend/src/auth/service.ts";
import { authConfig } from "../backend/src/auth/config.ts";
import { digest } from "../backend/src/auth/crypto.ts";
import { ensureSocialProfile } from "../backend/src/social/schema.ts";
import {
  SocialService,
  type SocialContext,
} from "../backend/src/social/service.ts";
import type { Room, Member } from "../shared/types.ts";
export const password = "V4 fixture password 🔒";
export async function fixture(databaseURL?: string) {
  if (
    databaseURL &&
    !/^\/mahjong_v4_test_[a-z0-9_]+$/.test(new URL(databaseURL).pathname)
  )
    throw Error("Dedicated V4 test database required");
  const dir = mkdtempSync(join(tmpdir(), "mj-social-")),
    prior = process.env.SQLITE_PATH,
    url = process.env.DATABASE_URL;
  process.env.SQLITE_PATH = join(dir, "db.sqlite");
  if (databaseURL) process.env.DATABASE_URL = databaseURL;
  else delete process.env.DATABASE_URL;
  const store = new Store();
  await store.open();
  await store.initV2();
  if ((await store.list("session")).length)
    throw Error("An empty disposable database is required");
  if (prior === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = prior;
  if (url !== undefined) process.env.DATABASE_URL = url;
  else delete process.env.DATABASE_URL;
  let now = 1800000000000,
    tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
  const invalidated: string[] = [],
    published: any[] = [],
    rooms = new Map<string, Room>();
  const auth = new AuthService(
    store,
    {
      ...authConfig({}),
      requestSecret: randomBytes(32).toString("base64url"),
      environment: "preview",
      enabled: true,
    },
    {
      serialize,
      assertReleased() {},
      async invalidate(h) {
        invalidated.push(...h);
      },
    },
    () => now,
  );
  await auth.initialize();
  const hash = await auth.passwords.hash(password);
  const users: { id: string; token: string; tokenHash: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const id = "account-" + i,
      token = randomBytes(32).toString("base64url"),
      tokenHash = digest(token);
    await store.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO auth_users(user_id,display_name,kind,created_at) VALUES(?,?,'ACCOUNT',?)",
        [id, "用户" + i, now],
      );
      await tx.query(
        "INSERT INTO auth_accounts(user_id,email_key,email_address,email_verified_at,password_hash,auth_version,updated_at) VALUES(?,?,?,?,?,1,?)",
        [id, `test${i}@example.com`, `test${i}@example.com`, now, hash, now],
      );
      await tx.query(
        "INSERT INTO auth_sessions(token_hash,user_id,auth_version,environment,created_at,expires_at,revoked_at) VALUES(?,?,1,'preview',?,?,NULL)",
        [tokenHash, id, now, now + 30 * 86400000],
      );
      await ensureSocialProfile(tx, id);
    });
    users.push({ id, token, tokenHash });
  }
  await auth.initialize();
  const social = new SocialService(
    store,
    auth,
    {
      serialize,
      roomChanged: (r) => rooms.set(r.roomId, r),
      async reloadRooms() {
        rooms.clear();
        for (const row of await store.list<Room>("room"))
          rooms.set(row.id, row.data);
      },
      connected: () => false,
      notify: (id, data) => published.push({ id, data }),
    },
    () => now,
    {},
  );
  store.roomWriteHook = (tx, r) => social.reconcileRoom(tx, r);
  const ctx = (
    i: number,
    requestId = randomUUID() as string,
  ): SocialContext => ({
    tokenHash: users[i].tokenHash,
    requestId,
    ip: "192.0.2." + (i + 1),
  });
  const codes = await Promise.all(
    users.map((_, i) => social.profile(ctx(i)).then((p) => p.friendCode)),
  );
  const member = (i: number): Member => ({
    memberId: randomUUID(),
    userId: users[i].id,
    displayName: "用户" + i,
    avatarId: "bamboo",
    participantKind: "HUMAN",
    ready: false,
    connected: false,
    botLevel: null,
  });
  const room = async (indices: number[]) => {
    const r: Room = {
      roomId: randomUUID(),
      inviteCode: "ABC123",
      status: "WAITING",
      lobbyGeneration: 1,
      previousMatchIds: [],
      isRematchLobby: false,
      memberJoinOrder: [],
      offlineSince: {},
      roomVersion: 1,
      presenceVersion: 1,
      roomViewSeq: 1,
      hostUserId: users[indices[0]].id,
      config: {
        rulesetId: "riichi-4p-v1.0",
        format: "EAST_ONLY",
        timePresetId: "standard-v1",
      },
      slots: [null, null, null, null],
      matchId: null,
    };
    indices.forEach((i, s) => (r.slots[s] = member(i)));
    r.memberJoinOrder = r.slots.filter(Boolean).map((m) => m!.memberId);
    await store.commit([{ kind: "room", id: r.roomId, data: r }]);
    rooms.set(r.roomId, r);
    return r;
  };
  const friend = async (a: number, b: number) => {
    const r = await social.sendRequest(ctx(a), codes[b]);
    await social.requestAction(ctx(b), r.requestId, "ACCEPTED", r.version);
  };
  return {
    dir,
    path: join(dir, "db.sqlite"),
    store,
    auth,
    social,
    users,
    codes,
    ctx,
    member,
    room,
    friend,
    rooms,
    invalidated,
    published,
    now: () => now,
    advance: (n: number) => (now += n),
    async close() {
      await tail;
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
