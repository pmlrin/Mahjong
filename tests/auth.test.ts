import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Store } from "../backend/src/store.ts";
import { AuthService } from "../backend/src/auth/service.ts";
import { MailQueue, type MailMessage } from "../backend/src/auth/mail.ts";
import { authConfig, type AuthConfig } from "../backend/src/auth/config.ts";
import {
  digest,
  Passwords,
  email,
  validatePassword,
  unseal,
  mac,
} from "../backend/src/auth/crypto.ts";
import { AuthError, type AuthContext } from "../backend/src/auth/types.ts";
import { createGame, quad } from "../backend/src/engine.ts";
import { summarize } from "../backend/src/history.ts";
const password = "  twelve-密碼🔐 spaces  ";
async function fixture(
  options: {
    legacy?: boolean;
    code?: string;
    environment?: "preview" | "production";
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "mj-auth-")),
    saved = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = join(dir, "auth.sqlite");
  const store = new Store();
  await store.open();
  await store.initV2();
  if (saved === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = saved;
  let now = Date.now();
  const config: AuthConfig = {
    ...authConfig({}),
    enabled: true,
    emailEnabled: true,
    environment: options.environment ?? "preview",
    requestSecret: randomBytes(32).toString("base64url"),
    otpSecret: randomBytes(32).toString("base64url"),
    encryptionKey: randomBytes(32).toString("base64"),
    smtpPassword: "isolated-test-password",
    allowlist: new Set(["player+one@example.com", "other@example.com"]),
    providerBudgetPath: join(dir, "provider-budget.sqlite"),
    mailDailyLimit: 100,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const controlled = new Set<string>(),
    revoked: string[] = [],
    messages: MailMessage[] = [],
    logs: unknown[] = [];
  if (options.legacy) {
    await store.commit([
      {
        kind: "session",
        id: digest("legacy-token"),
        data: {
          userId: "legacy-user",
          displayName: "旧游客",
          expires: now + 86400000,
        },
      },
      {
        kind: "session",
        id: digest("expired-token"),
        data: {
          userId: "expired-user",
          displayName: "过期游客",
          expires: now - 100,
        },
      },
    ]);
  }
  const auth = new AuthService(
    store,
    config,
    {
      serialize<T>(fn: () => Promise<T>) {
        const p = tail.then(fn);
        tail = p.catch(() => {});
        return p;
      },
      assertReleased(s) {
        if (controlled.has(s.tokenHash))
          throw new AuthError(
            "CONTROL_RELEASE_REQUIRED",
            "请先托管释放控制",
            409,
          );
      },
      async invalidate(hashes) {
        revoked.push(...hashes);
      },
    },
    () => now,
    options.code ? () => options.code! : undefined,
  );
  await auth.initialize();
  const queue = new MailQueue(
    auth,
    {
      send: async (m) => {
        messages.push(m);
        return { accepted: true, providerId: "test-only-id" };
      },
    },
    (e) => logs.push(e),
  );
  return {
    store,
    auth,
    queue,
    config,
    controlled,
    revoked,
    messages,
    logs,
    now: () => now,
    advance: (ms: number) => (now += ms),
    ctx: (
      token: string | null,
      flow: string = randomUUID(),
      id: string = randomUUID(),
    ): AuthContext => ({
      tokenHash: token ? digest(token) : null,
      flowId: flow,
      requestId: id,
      ip: "192.0.2.1",
    }),
    async close() {
      await queue.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function request(
  f: Awaited<ReturnType<typeof fixture>>,
  purpose: "REGISTER" | "RESET_PASSWORD",
  ctx: AuthContext,
  address = "Player+One@Example.com",
) {
  const reply = await f.auth.requestCode(purpose, address, ctx);
  await f.queue.tick();
  const message = f.messages.at(-1)!;
  const code = message.text.match(/\b\d{6}\b/)?.[0];
  assert(code, "fake SMTP test mailbox must receive the generated code");
  return { challengeId: reply.data.challengeId as string, code: code! };
}
async function register(
  f: Awaited<ReturnType<typeof fixture>>,
  token: string,
  address = "player+one@example.com",
) {
  const ctx = f.ctx(token);
  const c = await request(f, "REGISTER", ctx, address);
  const verified = await f.auth.verify("REGISTER", c.challengeId, c.code, {
    ...ctx,
    requestId: randomUUID(),
  });
  const completed = await f.auth.complete(
    "REGISTER",
    verified.data.grant,
    password,
    password,
    { ...ctx, requestId: randomUUID() },
  );
  return {
    token: completed.token!,
    userId: completed.data.userId as string,
    ctx,
    challenge: c,
  };
}
test("V3 T01/T02/T27/T29: old guests migrate without changing ID or history; register preserves replay position", async () => {
  const f = await fixture({ legacy: true });
  try {
    const before = f.auth.resolveToken("legacy-token")!;
    assert.equal(before.userId, "legacy-user");
    assert.equal(f.auth.resolveToken("expired-token"), null);
    const game = createGame(
      "old-room",
      quad((s) => ({
        memberId: "m" + s,
        userId: s === 0 ? "legacy-user" : "other" + s,
        displayName: "snapshot" + s,
        participantKind: "HUMAN",
        ready: true,
        connected: false,
        botLevel: null,
      })),
    );
    game.status = "FINISHED";
    game.finishedAt = f.now();
    game.matchResult = {
      matchId: game.matchId,
      reason: "SCHEDULE_COMPLETE",
      finalPoints: [35000, 25000, 22000, 18000],
      netPoints: [10000, 0, -3000, -7000],
      ranks: [1, 2, 3, 4],
      replayAvailable: true,
    };
    await f.store.commit([
      { kind: "match", id: game.matchId, data: game },
      { kind: "history", id: game.matchId, data: summarize(game)! },
    ]);
    await f.store.setPosition("legacy-user", game.matchId, {
      handId: game.handId,
      eventIndex: 0,
      viewerSeat: 0,
    });
    const raw = JSON.stringify(await f.store.get("match", game.matchId));
    const done = await register(f, "legacy-token");
    assert.equal(done.userId, "legacy-user");
    assert.equal(f.auth.resolveToken("legacy-token"), null);
    assert.equal(f.auth.resolveToken(done.token)!.kind, "ACCOUNT");
    assert.equal(
      (await f.store.summary(game.matchId, done.userId))!.members[0].rank,
      1,
    );
    assert.equal(
      (await f.store.position(done.userId, game.matchId)).viewerSeat,
      0,
    );
    assert.equal(JSON.stringify(await f.store.get("match", game.matchId)), raw);
    assert.equal(
      (await f.store.get<any>("session", digest("legacy-token")))!.expires,
      0,
    );
    assert.equal(await f.store.summary(game.matchId, "unknown"), null);
  } finally {
    await f.close();
  }
});
test("V3 T03/T06/T07: purpose, flow, session, expiry and single-use credentials; verification retry replaces grant without extending authorization", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      b = await f.auth.createGuest("b", randomUUID()),
      ctx = f.ctx(a.token);
    const c = await request(f, "REGISTER", ctx);
    await assert.rejects(
      f.auth.verify("RESET_PASSWORD", c.challengeId, c.code, {
        ...ctx,
        requestId: randomUUID(),
      }),
    );
    await assert.rejects(
      f.auth.verify(
        "REGISTER",
        c.challengeId,
        c.code,
        f.ctx(b.token, ctx.flowId),
      ),
    );
    await assert.rejects(
      f.auth.verify("REGISTER", c.challengeId, c.code, f.ctx(a.token)),
    );
    const id = randomUUID(),
      vctx = { ...ctx, requestId: id };
    const one = await f.auth.verify("REGISTER", c.challengeId, c.code, vctx);
    const deadline = one.data.expiresAt;
    f.advance(1000);
    const two = await f.auth.verify("REGISTER", c.challengeId, c.code, vctx);
    assert.notEqual(one.data.grant, two.data.grant);
    assert.equal(two.data.expiresAt, deadline);
    await assert.rejects(
      f.auth.complete("REGISTER", one.data.grant, password, password, {
        ...ctx,
        requestId: randomUUID(),
      }),
      /失效/,
    );
    await assert.rejects(
      f.auth.verify("REGISTER", c.challengeId, c.code, {
        ...ctx,
        requestId: randomUUID(),
      }),
    );
    f.advance(5 * 60000);
    await assert.rejects(
      f.auth.complete("REGISTER", two.data.grant, password, password, {
        ...ctx,
        requestId: randomUUID(),
      }),
    );
    f.advance(60000);
    const next = await request(f, "REGISTER", {
      ...ctx,
      requestId: randomUUID(),
    });
    f.advance(10 * 60000);
    await assert.rejects(
      f.auth.verify("REGISTER", next.challengeId, next.code, {
        ...ctx,
        requestId: randomUUID(),
      }),
    );
  } finally {
    await f.close();
  }
});
test("V3 T04: database failure rolls back binding and grant; concurrent completion creates exactly one account", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      ctx = f.ctx(a.token),
      c = await request(f, "REGISTER", ctx),
      v = await f.auth.verify("REGISTER", c.challengeId, c.code, {
        ...ctx,
        requestId: randomUUID(),
      });
    await f.store.transaction((tx) =>
      tx.query(
        "CREATE TRIGGER forced_auth_failure BEFORE INSERT ON auth_accounts BEGIN SELECT RAISE(ABORT,'forced transaction failure'); END",
      ),
    );
    await assert.rejects(
      f.auth.complete("REGISTER", v.data.grant, password, password, {
        ...ctx,
        requestId: randomUUID(),
      }),
    );
    assert.equal(f.auth.resolveToken(a.token)!.kind, "GUEST");
    assert.equal(f.auth.accounts.size, 0);
    await f.store.transaction((tx) =>
      tx.query("DROP TRIGGER forced_auth_failure"),
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.auth.complete("REGISTER", v.data.grant, password, password, {
          ...ctx,
          requestId: randomUUID(),
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.auth.accounts.size, 1);
    assert.equal(
      (await f.store.transaction((tx) =>
        tx.one("SELECT count(*) AS n FROM auth_accounts"),
      ))!.n,
      1,
    );
  } finally {
    await f.close();
  }
});
test("V3 T05/T09/T10/T11: registered email proof offers login; other guest history is never merged; bad passwords have uniform errors", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      done = await register(f, a.token);
    f.advance(60000);
    const b = await f.auth.createGuest("b", randomUUID()),
      ctx = f.ctx(b.token),
      c = await request(f, "REGISTER", ctx),
      v = await f.auth.verify("REGISTER", c.challengeId, c.code, {
        ...ctx,
        requestId: randomUUID(),
      });
    assert.equal(v.data.alreadyRegistered, true);
    assert.equal(f.auth.resolveToken(b.token)!.kind, "GUEST");
    await assert.rejects(
      f.auth.login("PLAYER+ONE@example.com", password, false, f.ctx(b.token)),
      { code: "GUEST_SWITCH_CONFIRM" },
    );
    assert.equal(f.auth.resolveToken(b.token)!.userId, b.identity.userId);
    const signed = await f.auth.login(
      "PLAYER+ONE@example.com",
      password,
      true,
      f.ctx(b.token),
    );
    assert.equal(f.auth.resolveToken(signed.token!)!.userId, done.userId);
    assert.notEqual(done.userId, b.identity.userId);
    const other = await f.auth.login(
      "Player+One@example.com",
      password,
      false,
      f.ctx(null),
    );
    assert.equal(f.auth.resolveToken(other.token!)!.userId, done.userId);
    for (const address of ["player+one@example.com", "missing@example.com"])
      await assert.rejects(
        f.auth.login(address, "not-the-password", false, f.ctx(null)),
        { code: "LOGIN_INVALID", message: "邮箱或密码不正确" },
      );
  } finally {
    await f.close();
  }
});
test("V3 T07/T08/T23/T24: persistent guessing and resend limits survive reload, repeated key does not charge twice, latest code only", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      ctx = f.ctx(a.token),
      c = await request(f, "REGISTER", ctx);
    assert.equal(
      (await f.auth.requestCode("REGISTER", "player+one@example.com", ctx)).data
        .challengeId,
      c.challengeId,
    );
    assert.equal(f.messages.length, 1);
    await assert.rejects(
      f.auth.requestCode("REGISTER", "player+one@example.com", {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "CODE_COOLDOWN" },
    );
    const wrong = c.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        f.auth.verify("REGISTER", c.challengeId, wrong, {
          ...ctx,
          requestId: randomUUID(),
        }),
        { code: "CODE_INVALID" },
      );
    await assert.rejects(
      f.auth.verify("REGISTER", c.challengeId, c.code, {
        ...ctx,
        requestId: randomUUID(),
      }),
    );
    f.advance(60000);
    const next = await request(f, "REGISTER", {
      ...ctx,
      requestId: randomUUID(),
    });
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        f.auth.verify(
          "REGISTER",
          next.challengeId,
          next.code === "000000" ? "000001" : "000000",
          { ...ctx, requestId: randomUUID() },
        ),
      );
    f.advance(60000);
    const third = await request(f, "REGISTER", {
      ...ctx,
      requestId: randomUUID(),
    });
    const reloaded = new AuthService(
      f.store,
      f.config,
      { serialize: (fn) => fn(), assertReleased() {}, async invalidate() {} },
      f.now,
    );
    await reloaded.initialize();
    await assert.rejects(
      reloaded.verify("REGISTER", third.challengeId, third.code, {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "AUTH_RATE_LIMITED" },
    );
    await assert.rejects(
      f.auth.requestCode("REGISTER", "other@example.com", {
        ...ctx,
        requestId: ctx.requestId,
      }),
      { code: "REQUEST_ID_CONFLICT" },
    );
  } finally {
    await f.close();
  }
});
test("V3 T12/T13/T14/T15/T17/T18/T30: logout one device; reset revokes every old session; change keeps only new current session; disabled entry never downgrades accounts", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      done = await register(f, a.token);
    const second = await f.auth.login(
      "player+one@example.com",
      password,
      false,
      f.ctx(null),
    );
    f.controlled.add(digest(done.token));
    await assert.rejects(f.auth.logout(f.ctx(done.token)), {
      code: "CONTROL_RELEASE_REQUIRED",
    });
    f.controlled.clear();
    await f.auth.logout(f.ctx(done.token));
    assert.equal(f.auth.resolveToken(done.token), null);
    assert(f.auth.resolveToken(second.token!));
    f.advance(60000);
    const resetCtx = f.ctx(null),
      reset = await request(f, "RESET_PASSWORD", resetCtx),
      proof = await f.auth.verify(
        "RESET_PASSWORD",
        reset.challengeId,
        reset.code,
        { ...resetCtx, requestId: randomUUID() },
      );
    const newer = "a brand new password 🔒";
    const result = await f.auth.complete(
      "RESET_PASSWORD",
      proof.data.grant,
      newer,
      newer,
      { ...resetCtx, requestId: randomUUID() },
    );
    assert.equal(result.token, undefined);
    assert.equal(result.data.loginRequired, true);
    assert.equal(f.auth.resolveToken(second.token!), null);
    await assert.rejects(
      f.auth.login("player+one@example.com", password, false, f.ctx(null)),
      { code: "LOGIN_INVALID" },
    );
    const login = await f.auth.login(
      "player+one@example.com",
      newer,
      false,
      f.ctx(null),
    );
    const another = await f.auth.login(
      "player+one@example.com",
      newer,
      false,
      f.ctx(null),
    );
    await assert.rejects(
      f.auth.changePassword(
        "wrong-password",
        password,
        password,
        f.ctx(login.token!),
      ),
      { code: "PASSWORD_INVALID" },
    );
    const changed = await f.auth.changePassword(
      newer,
      password,
      password,
      f.ctx(login.token!),
    );
    assert(f.auth.resolveToken(changed.token!));
    assert.equal(f.auth.resolveToken(another.token!), null);
    assert.equal(f.auth.resolveToken(login.token!), null);
    f.config.enabled = false;
    assert.equal(f.auth.resolveToken(changed.token!)!.kind, "ACCOUNT");
    assert.equal(f.auth.capabilities().registration, false);
    assert.equal(f.auth.capabilities().passwordLogin, true);
    const relogin = await f.auth.login(
      "player+one@example.com",
      password,
      false,
      f.ctx(null),
    );
    assert.equal(f.auth.resolveToken(relogin.token!)!.userId, done.userId);
  } finally {
    await f.close();
  }
});
test("V3 T15/T25/T26: absent reset accounts and non-allowlisted recipients create no SMTP attempts or account oracle", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx(null);
    const result = await f.auth.requestCode(
      "RESET_PASSWORD",
      "missing@example.com",
      ctx,
    );
    await f.queue.tick();
    assert.equal(f.messages.length, 0);
    assert.equal(result.data.message, "若该邮箱已注册，将收到验证码");
    const a = await f.auth.createGuest("a", randomUUID());
    await f.auth.requestCode(
      "REGISTER",
      "unlisted@example.com",
      f.ctx(a.token),
    );
    await f.queue.tick();
    assert.equal(f.messages.length, 0);
    const count = await f.store.transaction((tx) =>
      tx.one("SELECT count(*) AS n FROM auth_mail_jobs"),
    );
    assert.equal(count!.n, 0);
  } finally {
    await f.close();
  }
});
test("V3 T21/T22/T23: asynchronous SMTP retries reuse the code, budget includes retries, ciphertext is purged and error logs redact secrets", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      ctx = f.ctx(a.token);
    await f.auth.requestCode("REGISTER", "player+one@example.com", ctx);
    const sent: MailMessage[] = [];
    const queue = new MailQueue(
      f.auth,
      {
        send: async (m) => {
          sent.push(m);
          if (sent.length < 3)
            throw Object.assign(new Error("never log this body: " + m.text), {
              code: "ETIMEDOUT",
            });
          return { accepted: true };
        },
      },
      (e) => f.logs.push(e),
    );
    await queue.tick();
    f.advance(5000);
    await queue.tick();
    f.advance(15000);
    await queue.tick();
    assert.equal(sent.length, 3);
    assert.equal(new Set(sent.map((m) => m.text)).size, 1);
    const job = await f.store.transaction((tx) =>
      tx.one("SELECT * FROM auth_mail_jobs"),
    );
    assert.equal(job!.status, "ACCEPTED");
    assert.equal(job!.ciphertext, null);
    const budget = await f.store.transaction((tx) =>
      f.auth.bucket(
        tx,
        mac(f.config.requestSecret, f.config.environment, "smtp-day", "all"),
        86400000,
      ),
    );
    assert(budget);
    assert(!JSON.stringify(f.logs).includes(sent[0].text));
    assert(sent[0].subject.includes("预览环境"));
    await queue.close();
    f.advance(60000);
    f.config.mailDailyLimit = 3;
    await assert.rejects(
      f.auth.requestCode("REGISTER", "other@example.com", f.ctx(a.token)),
      { code: "MAIL_UNAVAILABLE" },
    );
  } finally {
    await f.close();
  }
});
test("V3 crypto: Unicode password lengths, no trimming, ASCII email rules, Argon2id parameters and bounded asynchronous work", async () => {
  assert.equal(email(" A.B+Tag@EXAMPLE.com ").key, "a.b+tag@example.com");
  assert.throws(() => email("含字@example.com"));
  assert.throws(() => email("a..b@example.com"));
  validatePassword("🔒".repeat(12), "🔒".repeat(12));
  assert.throws(() => validatePassword("🔒".repeat(129), "🔒".repeat(129)));
  const p = new Passwords(2),
    encoded = await p.hash(password);
  assert(encoded.startsWith("$argon2id$v=19$m=19456,t=2,p=1$"));
  assert(await p.verify(password, encoded));
  assert(!(await p.verify(password.trim(), encoded)));
  let ticks = 0,
    maxActive = 0;
  const timer = setInterval(() => {
      ticks++;
      maxActive = Math.max(maxActive, p.active);
    }, 1),
    start = performance.now();
  await Promise.all(
    Array.from({ length: 6 }, () => p.hash("another valid password")),
  );
  clearInterval(timer);
  assert(maxActive <= 2);
  assert(ticks > 0);
  writeFileSync(
    "reports/v4-password-benchmark.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        node: process.version,
        argon2id: { memoryKiB: 19456, passes: 2, parallelism: 1 },
        concurrency: 2,
        hashes: 6,
        elapsedMs: performance.now() - start,
        eventLoopTicks: ticks,
        maxActive,
      },
      null,
      2,
    ),
  );
});

test("V3 T04/T18: uncertain commit reloads authoritative revocation and safe replay returns committed account, not a second binding", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      ctx = f.ctx(a.token),
      c = await request(f, "REGISTER", ctx),
      v = await f.auth.verify("REGISTER", c.challengeId, c.code, {
        ...ctx,
        requestId: randomUUID(),
      });
    const completeCtx = { ...ctx, requestId: randomUUID() },
      original = f.store.transaction.bind(f.store);
    let fail = true;
    f.store.transaction = async (fn) => {
      const result = await original(fn);
      const account = await original((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM auth_accounts"),
      );
      if (fail && Number(account?.n) > 0) {
        fail = false;
        throw Error("simulated connection loss after COMMIT");
      }
      return result;
    };
    await assert.rejects(
      f.auth.complete(
        "REGISTER",
        v.data.grant,
        password,
        password,
        completeCtx,
      ),
    );
    assert.equal(f.auth.resolveToken(a.token), null);
    assert.equal(f.auth.accounts.size, 1);
    const retry = await f.auth.complete(
      "REGISTER",
      v.data.grant,
      password,
      password,
      completeCtx,
    );
    assert.equal(retry.data.completed, true);
    assert.equal(retry.data.loginRequired, true);
    assert.equal(retry.token, undefined);
    assert.equal(f.auth.accounts.size, 1);
    const login = await f.auth.login(
      "player+one@example.com",
      password,
      false,
      f.ctx(null),
    );
    assert.equal(f.auth.resolveToken(login.token!)!.userId, a.identity.userId);
  } finally {
    await f.close();
  }
});
test("V3 T23: abandoned SENDING lease resumes after restart, never extends code expiry and scrubs terminal ciphertext", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID());
    await f.auth.requestCode(
      "REGISTER",
      "player+one@example.com",
      f.ctx(a.token),
    );
    await f.store.transaction((tx) =>
      tx.query(
        "UPDATE auth_mail_jobs SET status='SENDING',attempts=1,lease_until=?",
        [f.now() - 1],
      ),
    );
    await f.queue.tick();
    assert.equal(f.messages.length, 1);
    const row = await f.store.transaction((tx) =>
      tx.one("SELECT * FROM auth_mail_jobs"),
    );
    assert.equal(row!.attempts, 2);
    assert.equal(row!.status, "ACCEPTED");
    assert.equal(row!.ciphertext, null);
    f.advance(60000);
    await f.auth.requestCode("REGISTER", "other@example.com", f.ctx(a.token));
    f.advance(10 * 60000);
    await f.queue.tick();
    const expired = await f.store.transaction((tx) =>
      tx.one("SELECT * FROM auth_mail_jobs WHERE status='EXPIRED'"),
    );
    assert(expired);
    assert.equal(expired.ciphertext, null);
    assert.equal(f.messages.length, 1);
  } finally {
    await f.close();
  }
});
test("V3 T21/T25: shared provider budget cannot be doubled by preview and production processes", async () => {
  const { ProviderBudget } =
    await import("../backend/src/auth/provider-budget.ts");
  const dir = mkdtempSync(join(tmpdir(), "mj-provider-"));
  const a = new ProviderBudget(join(dir, "budget.sqlite"), "same-sender"),
    b = new ProviderBudget(join(dir, "budget.sqlite"), "same-sender");
  try {
    const now = Date.now();
    assert.equal(a.reserve(now, 2), "RESERVED");
    assert.equal(b.reserve(now, 2), "RESERVED");
    assert.equal(a.reserve(now, 2), "EXHAUSTED");
    assert.equal(b.reserve(now + 86400001, 2), "RESERVED");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("V3 T21/T22: SMTP auth failure is terminal, clears body, disables mail only and keeps password login available", async () => {
  const f = await fixture();
  try {
    const a = await f.auth.createGuest("a", randomUUID()),
      done = await register(f, a.token);
    f.advance(60000);
    const b = await f.auth.createGuest("b", randomUUID());
    await f.auth.requestCode("REGISTER", "other@example.com", f.ctx(b.token));
    let attempts = 0;
    const broken = new MailQueue(
      f.auth,
      {
        send: async () => {
          attempts++;
          throw Object.assign(
            new Error("sensitive SMTP text must not reach audit"),
            { code: "EAUTH" },
          );
        },
      },
      (e) => f.logs.push(e),
    );
    await broken.tick();
    f.advance(60000);
    await broken.tick();
    assert.equal(attempts, 1);
    const job = await f.store.transaction((tx) =>
      tx.one("SELECT * FROM auth_mail_jobs WHERE status='FAILED'"),
    );
    assert(job);
    assert.equal(job.ciphertext, null);
    assert.equal(f.auth.capabilities().mailAvailable, false);
    assert.equal(f.auth.capabilities().passwordLogin, true);
    const signed = await f.auth.login(
      "player+one@example.com",
      password,
      false,
      f.ctx(null),
    );
    assert.equal(f.auth.resolveToken(signed.token!)!.userId, done.userId);
    assert(!JSON.stringify(f.logs).includes("sensitive SMTP"));
    await broken.close();
  } finally {
    await f.close();
  }
});

test("V3 T06/T25: leading-zero code verifies, expires at ten minutes and wrong environment cannot reopen database", async () => {
  const f = await fixture({ code: "000042" });
  try {
    const g = await f.auth.createGuest("zero", randomUUID()),
      ctx = f.ctx(g.token);
    const challenge = await request(f, "REGISTER", ctx);
    assert.equal(challenge.code, "000042");
    const verified = await f.auth.verify(
      "REGISTER",
      challenge.challengeId,
      challenge.code,
      { ...ctx, requestId: randomUUID() },
    );
    assert(verified.data.grant);
    f.advance(60000);
    const expired = await request(f, "REGISTER", {
      ...ctx,
      requestId: randomUUID(),
    });
    f.advance(600000);
    await assert.rejects(
      f.auth.verify("REGISTER", expired.challengeId, expired.code, {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "CODE_INVALID" },
    );
    const wrong = new AuthService(
      f.store,
      { ...f.config, environment: "production" },
      { serialize: (fn) => fn(), assertReleased() {}, async invalidate() {} },
    );
    await assert.rejects(wrong.initialize(), /AUTH_ENVIRONMENT_MISMATCH/);
  } finally {
    await f.close();
  }
});

test("V3 T24: rolling limits do not reset at wall-clock boundaries; email, IP and login budgets persist", async () => {
  const f = await fixture();
  try {
    const g = await f.auth.createGuest("limits", randomUUID()),
      ctx = f.ctx(g.token);
    for (let i = 0; i < 5; i++) {
      await f.auth.requestCode("REGISTER", "player+one@example.com", {
        ...ctx,
        requestId: randomUUID(),
      });
      f.advance(60000);
    }
    await assert.rejects(
      f.auth.requestCode("REGISTER", "player+one@example.com", {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "AUTH_RATE_LIMITED" },
    );
    for (let i = 0; i < 15; i++)
      await f.auth.requestCode("REGISTER", `unique${i}@example.com`, {
        ...ctx,
        requestId: randomUUID(),
      });
    await assert.rejects(
      f.auth.requestCode("REGISTER", "unique20@example.com", {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "AUTH_RATE_LIMITED" },
    );
    f.advance(Math.ceil(f.now() / 900000) * 900000 - 1000 - f.now());
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        f.auth.login("unknown@example.com", password, true, {
          ...ctx,
          requestId: randomUUID(),
        }),
        { code: "LOGIN_INVALID" },
      );
    f.advance(2000); // Cross the wall-clock quarter-hour without expiring the rolling window.
    const reload = new AuthService(
      f.store,
      f.config,
      { serialize: (fn) => fn(), assertReleased() {}, async invalidate() {} },
      f.now,
    );
    await reload.initialize();
    await assert.rejects(
      reload.login("another@example.com", password, true, {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "AUTH_RATE_LIMITED" },
    );
    f.advance(15 * 60000);
    await assert.rejects(
      reload.login("another@example.com", password, true, {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "LOGIN_INVALID" },
    );
  } finally {
    await f.close();
  }
});

test("V3 T30: SQLite backup restores accounts, legacy revocation and new-session identity without downgrading", async () => {
  const f = await fixture({ legacy: true });
  const dir = mkdtempSync(join(tmpdir(), "mj-auth-restore-"));
  let restored: Store | undefined;
  try {
    const done = await register(f, "legacy-token");
    const path = join(dir, "restored.sqlite");
    f.store.sqlite!.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const saved = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path;
    restored = new Store();
    await restored.open();
    if (saved === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = saved;
    const auth = new AuthService(
      restored,
      { ...f.config, enabled: false, emailEnabled: false },
      { serialize: (fn) => fn(), assertReleased() {}, async invalidate() {} },
    );
    await auth.initialize();
    assert.equal(auth.resolveToken("legacy-token"), null);
    assert.equal(auth.resolveToken(done.token)!.userId, "legacy-user");
    assert.equal(auth.resolveToken(done.token)!.kind, "ACCOUNT");
    const login = await auth.login(
      "player+one@example.com",
      password,
      false,
      f.ctx(null),
    );
    assert.equal(login.data.userId, "legacy-user");
    assert.equal(
      (await restored.get<any>("session", digest("legacy-token")))!.expires,
      0,
    );
  } finally {
    await restored?.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("V3 T21/T22: a pending SMTP connection holds no game/auth transaction; permanent refusal and corrupt outbox never retry", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  let blocked: MailQueue | undefined;
  try {
    const g = await f.auth.createGuest("owner", randomUUID());
    await register(f, g.token);
    f.advance(60000);
    const other = await f.auth.createGuest("other", randomUUID());
    await f.auth.requestCode(
      "REGISTER",
      "other@example.com",
      f.ctx(other.token),
    );
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    blocked = new MailQueue(
      f.auth,
      {
        send: async () => {
          started();
          await new Promise<void>((resolve) => (finish = resolve));
          return { accepted: true };
        },
      },
      () => {},
    );
    pending = blocked.tick();
    await ready;
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("SMTP blocked the application queue")),
        1000,
      );
      timer.unref();
    });
    const created = await Promise.race([
      f.auth.createGuest("still responsive", randomUUID()),
      deadline,
    ]);
    assert.equal(created.identity.kind, "GUEST");
    const logged = await Promise.race([
      f.auth.login("player+one@example.com", password, false, f.ctx(null)),
      deadline,
    ]);
    assert(logged.token);
    finish!();
    await pending;
    await blocked.close();
    blocked = undefined;
    f.advance(60000);
    await f.auth.requestCode(
      "REGISTER",
      "other@example.com",
      f.ctx(other.token),
    );
    let sends = 0;
    const refused = new MailQueue(
      f.auth,
      {
        send: async () => {
          sends++;
          throw Object.assign(new Error("provider detail"), {
            responseCode: 550,
          });
        },
      },
      () => {},
    );
    await refused.tick();
    f.advance(60000);
    await refused.tick();
    await refused.close();
    assert.equal(sends, 1);
    await f.auth.requestCode(
      "REGISTER",
      "other@example.com",
      f.ctx(other.token),
    );
    await f.store.transaction((tx) =>
      tx.query(
        "UPDATE auth_mail_jobs SET ciphertext='corrupt' WHERE status='QUEUED'",
      ),
    );
    const corrupt = new MailQueue(
      f.auth,
      {
        send: async () => {
          sends++;
          return { accepted: true };
        },
      },
      () => {},
    );
    await corrupt.tick();
    f.advance(60000);
    await corrupt.tick();
    await corrupt.close();
    assert.equal(sends, 1);
    assert.equal(f.auth.capabilities().mailAvailable, false);
    assert.equal(
      Number(
        (await f.store.transaction((tx) =>
          tx.one(
            "SELECT COUNT(*) AS n FROM auth_mail_jobs WHERE ciphertext IS NOT NULL",
          ),
        ))!.n,
      ),
      0,
    );
  } finally {
    finish?.();
    await pending;
    await blocked?.close();
    await f.close();
  }
});

test("V3 T03/T10: invalid and cross-context completion grants never consume a password worker; completed retries still return the receipt", async () => {
  const f = await fixture();
  const hash = f.auth.passwords.hash.bind(f.auth.passwords);
  let hashes = 0;
  f.auth.passwords.hash = async (value) => {
    hashes++;
    return hash(value);
  };
  try {
    const guest = await f.auth.createGuest("proof first", randomUUID()),
      ctx = f.ctx(guest.token);
    for (const purpose of ["REGISTER", "RESET_PASSWORD"] as const)
      await assert.rejects(
        f.auth.complete(
          purpose,
          randomBytes(32).toString("base64url"),
          password,
          password,
          ctx,
        ),
        { code: "GRANT_INVALID" },
      );
    const challenge = await request(f, "REGISTER", ctx);
    const verified = await f.auth.verify(
      "REGISTER",
      challenge.challengeId,
      challenge.code,
      { ...ctx, requestId: randomUUID() },
    );
    await assert.rejects(
      f.auth.complete("REGISTER", verified.data.grant, password, password, {
        ...ctx,
        flowId: randomUUID(),
        requestId: randomUUID(),
      }),
      { code: "GRANT_INVALID" },
    );
    assert.equal(hashes, 0);
    const doneContext = { ...ctx, requestId: randomUUID() };
    const completed = await f.auth.complete(
      "REGISTER",
      verified.data.grant,
      password,
      password,
      doneContext,
    );
    assert(completed.token);
    assert.equal(hashes, 1);
    const repeat = await f.auth.complete(
      "REGISTER",
      verified.data.grant,
      password,
      password,
      doneContext,
    );
    assert.equal(repeat.data.completed, true);
    assert.equal(repeat.data.loginRequired, true);
    assert.equal(hashes, 1);
    await assert.rejects(
      f.auth.complete(
        "REGISTER",
        verified.data.grant,
        password + "different",
        password + "different",
        doneContext,
      ),
      { code: "REQUEST_ID_CONFLICT" },
    );
    assert.equal(hashes, 1);
  } finally {
    await f.close();
  }
});

test("V3 T03/T18: completion proof is rechecked after hashing and cannot outlive its original five-minute authorization", async () => {
  const f = await fixture();
  try {
    const guest = await f.auth.createGuest("expiring proof", randomUUID()),
      ctx = f.ctx(guest.token);
    const challenge = await request(f, "REGISTER", ctx);
    const verified = await f.auth.verify(
      "REGISTER",
      challenge.challengeId,
      challenge.code,
      { ...ctx, requestId: randomUUID() },
    );
    const hash = f.auth.passwords.hash.bind(f.auth.passwords);
    f.auth.passwords.hash = async (value) => {
      const encoded = await hash(value);
      f.advance(300000);
      return encoded;
    };
    await assert.rejects(
      f.auth.complete("REGISTER", verified.data.grant, password, password, {
        ...ctx,
        requestId: randomUUID(),
      }),
      { code: "GRANT_INVALID" },
    );
    assert.equal(f.auth.accounts.size, 0);
    assert.equal(f.auth.resolveToken(guest.token)!.kind, "GUEST");
  } finally {
    await f.close();
  }
});

test("V3 T25/T26: production registration uses the requested recipient and does not claim the preview allowlist restriction", async () => {
  const f = await fixture({ environment: "production" });
  try {
    f.config.applicationURL = "https://mahjong.yangjm.cn/";
    const guest = await f.auth.createGuest("production fixture", randomUUID());
    const response = await f.auth.requestCode(
      "REGISTER",
      "actual-recipient@example.invalid",
      f.ctx(guest.token),
    );
    await f.queue.tick();
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].to, "actual-recipient@example.invalid");
    assert(!String(response.data.message).includes("preview"));
    assert(
      !String(response.data.message).includes(
        String.fromCodePoint(0x9884, 0x89c8),
      ),
    );
    assert(
      !f.messages[0].subject.includes(String.fromCodePoint(0x9884, 0x89c8)),
    );
    assert(f.messages[0].text.includes("https://mahjong.yangjm.cn/"));
    assert.equal(f.auth.capabilities().previewRestricted, false);
  } finally {
    await f.close();
  }
});
