import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
// Only aggregate SMTP reservations are shared. No identity, email challenge or session crosses environments.
export class ProviderBudget {
  private db: DatabaseSync;
  constructor(
    path: string,
    private accountKey: string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS provider_attempts (id TEXT PRIMARY KEY,account_key TEXT NOT NULL,at BIGINT NOT NULL);CREATE INDEX IF NOT EXISTS provider_attempt_time ON provider_attempts(account_key,at)",
    );
  }
  reserve(now: number, maximum: number): "RESERVED" | "EXHAUSTED" | "BUSY" {
    let transaction = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const row = this.db
        .prepare(
          "SELECT count(*) AS n FROM provider_attempts WHERE account_key=? AND at>?",
        )
        .get(this.accountKey, now - 86400000) as { n: number };
      if (row.n >= maximum) {
        this.db.exec("ROLLBACK");
        return "EXHAUSTED";
      }
      this.db
        .prepare(
          "INSERT INTO provider_attempts(id,account_key,at) VALUES(?,?,?)",
        )
        .run(randomUUID(), this.accountKey, now);
      this.db
        .prepare("DELETE FROM provider_attempts WHERE at<?")
        .run(now - 2 * 86400000);
      this.db.exec("COMMIT");
      return "RESERVED";
    } catch (e) {
      if (transaction) this.db.exec("ROLLBACK");
      if ((e as any).errcode === 5 || (e as Error).message.includes("locked"))
        return "BUSY";
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
