import { createHash } from "node:crypto";
import { Store } from "../store.ts";
import { migrateAuth } from "./migration.ts";
import { authConfig } from "./config.ts";
const store = new Store();
await store.open();
async function digest() {
  const h = createHash("sha256");
  let cursor = "",
    count = 0;
  while (true) {
    const rows = await store.scanMatches(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      h.update(JSON.stringify(row));
      count++;
    }
  }
  for (const kind of ["room", "session"])
    for (const row of (await store.list(kind)).sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      h.update(JSON.stringify(row));
      count++;
    }
  return { documents: count, sha256: h.digest("hex") };
}
try {
  const before = await digest();
  const migration = await migrateAuth(store, authConfig());
  const after = await digest();
  if (before.sha256 !== after.sha256) throw Error("LEGACY_DATA_CHANGED");
  console.log(
    JSON.stringify({
      migration: "auth-v3",
      environment: authConfig().environment,
      ...migration,
      legacyUnchanged: true,
      before,
      after,
    }),
  );
} finally {
  await store.close();
}
