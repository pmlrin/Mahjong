import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
if (process.env.DATABASE_URL)
  throw Error("Production backup: run deploy/backup.sh on the server.");
const db = new DatabaseSync(
  resolve(process.env.SQLITE_PATH ?? "data/mahjong.sqlite"),
);
mkdirSync("backups", { recursive: true, mode: 0o700 });
const target = resolve(
  "backups",
  `mahjong-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
db.close();
chmodSync(target, 0o600);
console.log(target);
