import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { AuthService } from "./service.ts";
import { authConfig } from "./config.ts";
// This command may initialize schemas, so accept restored copies only.
const database = process.env.DATABASE_URL;
if (
  !database ||
  !/^\/mahjong_v3_(release_restore|formal_migration)_\d{8}$/.test(
    new URL(database).pathname,
  )
)
  throw Error(
    "Restore verification requires a dedicated restored-copy database",
  );
const store = new Store();
await store.open();
try {
  const config = { ...authConfig(), enabled: false, emailEnabled: false };
  const auth = new AuthService(store, config, {
    serialize: (fn) => fn(),
    assertReleased() {},
    async invalidate() {},
  });
  await auth.initialize();
  if (process.argv.includes("--expect-account")) assert(auth.accounts.size > 0);
  let oldVersions = 0,
    oldVersionsDenied = 0,
    validAccounts = 0,
    validGuests = 0;
  for (const account of auth.accounts.values())
    assert.equal(auth.profiles.get(account.userId)?.kind, "ACCOUNT");
  for (const session of auth.sessions.values()) {
    const account = auth.accounts.get(session.userId),
      identity = auth.resolveHash(session.tokenHash);
    if (account && session.authVersion < account.authVersion) {
      oldVersions++;
      if (!identity) oldVersionsDenied++;
    }
    if (identity?.kind === "ACCOUNT") validAccounts++;
    if (identity?.kind === "GUEST") validGuests++;
  }
  assert.equal(oldVersionsDenied, oldVersions);
  if (auth.accounts.size > 0)
    assert.equal(auth.capabilities().passwordLogin, true);
  console.log(
    JSON.stringify({
      environment: config.environment,
      accounts: auth.accounts.size,
      profiles: auth.profiles.size,
      validAccountSessions: validAccounts,
      validGuestSessions: validGuests,
      oldVersionSessions: oldVersions,
      oldVersionSessionsDenied: oldVersionsDenied,
      registrationClosed: true,
      accountDowngrade: false,
      passed: true,
    }),
  );
} finally {
  await store.close();
}
