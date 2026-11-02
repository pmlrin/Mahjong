import { createHash } from "node:crypto";
import { Store } from "../store.ts";
import { migrateAuth } from "../auth/migration.ts";
import { authConfig } from "../auth/config.ts";
const store = new Store();
await store.open();
async function digest() {
  const data = [];
  for (const kind of ["session", "room", "match"]) {
    for (const row of (await store.list(kind)).sort((a, b) =>
      a.id.localeCompare(b.id),
    ))
      data.push(JSON.stringify([kind, row.id, row.data]));
  }
  return {
    documents: data.length,
    sha256: createHash("sha256").update(data.join("\n")).digest("hex"),
  };
}
try {
  const before = await digest();
  const migrated = await migrateAuth(store, authConfig());
  const after = await digest();
  if (before.sha256 !== after.sha256) throw Error("LEGACY_DOCUMENTS_CHANGED");
  const count = await store.transaction((tx) =>
    tx.one("SELECT COUNT(*) AS n FROM social_profiles"),
  );
  console.log(
    JSON.stringify({
      migration: "social-v4",
      environment: authConfig().environment,
      accountsWithFriendCode: Number(count!.n),
      before,
      after,
      legacyUnchanged: true,
      authMigration: migrated,
    }),
  );
} finally {
  await store.close();
}
