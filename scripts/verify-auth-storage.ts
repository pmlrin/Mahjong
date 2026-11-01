import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../backend/src/store.ts";
import { AuthService } from "../backend/src/auth/service.ts";
import { authConfig } from "../backend/src/auth/config.ts";
import { digest, unseal } from "../backend/src/auth/crypto.ts";
import type { AuthContext } from "../backend/src/auth/types.ts";
// Run only against an empty disposable database, never a live website database.
if (
  process.env.DATABASE_URL &&
  !/^mahjong_v3_auth_test_[a-z0-9_]+$/.test(
    new URL(process.env.DATABASE_URL).pathname.slice(1),
  )
)
  throw Error("An isolated mahjong_v3_auth_test_* database is required");
const dir = mkdtempSync(join(tmpdir(), "mj-auth-storage-"));
if (!process.env.DATABASE_URL)
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
const store = new Store();
await store.open();
await store.initV2();
const checks: string[] = [];
try {
  assert.equal((await store.list("session")).length, 0);
  assert.equal((await store.list("room")).length, 0);
  const config = {
    ...authConfig({}),
    enabled: true,
    emailEnabled: true,
    environment: "preview" as const,
    requestSecret: randomBytes(32).toString("base64url"),
    otpSecret: randomBytes(32).toString("base64url"),
    encryptionKey: randomBytes(32).toString("base64"),
    smtpPassword: "isolated-storage-test",
    allowlist: new Set(["storage@example.com"]),
  };
  await store.commit([
    {
      kind: "session",
      id: digest("legacy-storage-test"),
      data: {
        userId: "storage-user",
        displayName: "旧游客",
        expires: Date.now() + 86400000,
      },
    },
    {
      kind: "room",
      id: "storage-room",
      data: { slots: [{ userId: "storage-user", displayName: "原快照昵称" }] },
    },
  ]);
  const before = JSON.stringify(await store.list("room"));
  const hooks = {
    serialize: <T>(fn: () => Promise<T>) => fn(),
    assertReleased() {},
    async invalidate() {},
  };
  const auth = new AuthService(store, config, hooks);
  await auth.initialize();
  assert.equal(
    auth.resolveToken("legacy-storage-test")!.userId,
    "storage-user",
  );
  assert.equal(JSON.stringify(await store.list("room")), before);
  const restarted = new AuthService(store, config, hooks);
  assert.equal((await restarted.initialize()).alreadyApplied, true);
  assert.equal(auth.resolveToken("legacy-storage-test")!.kind, "GUEST");
  checks.push(
    "legacy migration preserves userId, snapshots and session; rerun is idempotent",
  );
  const context: AuthContext = {
    tokenHash: digest("legacy-storage-test"),
    flowId: randomUUID(),
    requestId: randomUUID(),
    ip: "192.0.2.15",
  };
  const codeReply = await auth.requestCode(
    "REGISTER",
    "storage@example.com",
    context,
  );
  const job = await store.transaction((tx) =>
    tx.one("SELECT * FROM auth_mail_jobs WHERE challenge_id=?", [
      String(codeReply.data.challengeId),
    ]),
  );
  const message = unseal<{ text: string }>(
    config.encryptionKey,
    job!.ciphertext,
    [config.environment, job!.challenge_id, job!.purpose, job!.job_id].join(
      ":",
    ),
  );
  const code = message.text.match(/\b\d{6}\b/)![0];
  const verified = await auth.verify(
    "REGISTER",
    String(codeReply.data.challengeId),
    code,
    { ...context, requestId: randomUUID() },
  );
  const pw = "storage-test-密码-12345",
    complete = { ...context, requestId: randomUUID() };
  const transaction = store.transaction.bind(store);
  let inject = true;
  store.transaction = (fn) =>
    transaction(async (tx) => {
      const result = await fn(tx);
      if (
        inject &&
        Number((await tx.one("SELECT COUNT(*) AS n FROM auth_accounts"))!.n) > 0
      ) {
        inject = false;
        throw Error("INJECTED_PRECOMMIT_FAILURE");
      }
      return result;
    });
  await assert.rejects(
    auth.complete("REGISTER", verified.data.grant, pw, pw, complete),
    /INJECTED_PRECOMMIT_FAILURE/,
  );
  assert.equal(
    Number(
      (await transaction((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM auth_accounts"),
      ))!.n,
    ),
    0,
  );
  assert.equal(auth.resolveToken("legacy-storage-test")!.kind, "GUEST");
  checks.push(
    "failed transaction rolls back account, profile, session revocation and grant consumption",
  );
  store.transaction = transaction;
  const done = await auth.complete(
    "REGISTER",
    verified.data.grant,
    pw,
    pw,
    complete,
  );
  assert.equal(done.data.userId, "storage-user");
  assert.equal(auth.resolveToken("legacy-storage-test"), null);
  assert.equal(auth.resolveToken(done.token!)!.kind, "ACCOUNT");
  assert.equal(JSON.stringify(await store.list("room")), before);
  const retry = await auth.complete(
    "REGISTER",
    verified.data.grant,
    pw,
    pw,
    complete,
  );
  assert.equal(retry.data.completed, true);
  assert.equal(
    Number(
      (await transaction((tx) =>
        tx.one("SELECT COUNT(*) AS n FROM auth_accounts"),
      ))!.n,
    ),
    1,
  );
  checks.push(
    "original user upgraded once; retry cannot create a second account",
  );
  await assert.rejects(
    transaction(async (tx) => {
      await tx.query(
        "INSERT INTO auth_users(user_id,display_name,kind,created_at) VALUES('duplicate-user','dup','ACCOUNT',?)",
        [Date.now()],
      );
      await tx.query(
        "INSERT INTO auth_accounts(user_id,email_key,email_address,email_verified_at,password_hash,auth_version,updated_at) SELECT 'duplicate-user',email_key,email_address,email_verified_at,password_hash,auth_version,updated_at FROM auth_accounts LIMIT 1",
      );
    }),
  );
  assert.equal(
    await transaction((tx) =>
      tx.one("SELECT * FROM auth_users WHERE user_id='duplicate-user'"),
    ),
    null,
  );
  checks.push(
    "database unique email constraint rejects competing binding atomically",
  );
  const reopened = new AuthService(
    store,
    { ...config, enabled: false, emailEnabled: false },
    hooks,
  );
  await reopened.initialize();
  assert.equal(reopened.resolveToken(done.token!)!.kind, "ACCOUNT");
  const logged = await reopened.login("storage@example.com", pw, false, {
    tokenHash: null,
    flowId: randomUUID(),
    requestId: randomUUID(),
    ip: "192.0.2.16",
  });
  assert.equal(logged.data.userId, "storage-user");
  checks.push(
    "restart and disabled new-registration flag preserve account authentication",
  );
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      database: store.pool ? "PostgreSQL" : "SQLite",
      passed: true,
      realSMTP: false,
      checks,
    }),
  );
} finally {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
}
