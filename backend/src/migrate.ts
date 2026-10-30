import { createHash } from "node:crypto";
import { Store } from "./store.ts";
import { backfill } from "./migration.ts";
const store = new Store();
await store.open();
async function digest() {
  const hash = createHash("sha256");
  let cursor = "",
    count = 0;
  while (true) {
    const rows = await store.scanMatches(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      hash.update(JSON.stringify(row));
      count++;
    }
  }
  return { count, sha256: hash.digest("hex") };
}
try {
  const before = await digest();
  const result = await backfill(store, process.argv.includes("--rebuild"));
  const after = await digest();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error("RAW_MATCHES_CHANGED");
  console.log(
    JSON.stringify({
      migration: "v2",
      ...result,
      rawUnchanged: true,
      before,
      after,
    }),
  );
} finally {
  await store.close();
}
