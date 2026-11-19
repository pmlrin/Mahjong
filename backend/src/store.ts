import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import type {
  HistorySummary,
  MatchFormat,
  MatchMode,
  MatchStats,
} from "../../shared/types.ts";
import { encodeCursor } from "./history.ts";
import { Sql } from "./sql.ts";
import {
  RATING_SCHEMA,
  settleRating,
  loadRatings,
  type RatingSettlement,
} from "./rating.ts";
export interface Write {
  kind: string;
  id: string;
  data: unknown;
}
function summaryRow(row: any, postgres: boolean): HistorySummary | null {
  if (!row) return null;
  const s: HistorySummary = postgres ? row.payload : JSON.parse(row.payload);
  return { ...s, replayAvailable: s.replayAvailable && !!row.has_replay };
}
export class Store {
  roomWriteHook?: (tx: Sql, room: any) => Promise<void>;
  private writeTail: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(fn);
    this.writeTail = result.catch(() => {});
    return result;
  }
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const client = this.pool ? await this.pool.connect() : null;
      try {
        if (client) await client.query("BEGIN");
        else this.sqlite!.exec("BEGIN IMMEDIATE");
        const result = await fn(new Sql(client, this.sqlite));
        if (client) await client.query("COMMIT");
        else this.sqlite!.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          if (client) await client.query("ROLLBACK");
          else this.sqlite!.exec("ROLLBACK");
        } catch {
          // COMMIT may have succeeded before the connection failed. Preserve
          // the original failure so auth can reload authoritative state.
        }
        throw e;
      } finally {
        client?.release();
      }
    });
  }
  sqlite: DatabaseSync | null = null;
  pool: pg.Pool | null = null;
  lock: pg.PoolClient | null = null;
  async open() {
    if (process.env.DATABASE_URL) {
      this.pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
      });
      this.lock = await this.pool.connect();
      const r = await this.lock.query(
        "SELECT pg_try_advisory_lock(849273161) AS locked",
      );
      if (!r.rows[0].locked)
        throw Error("Another Mahjong process owns the database");
      await this.pool.query(
        "CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,payload JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(kind,id))",
      );
    } else {
      if (process.env.NODE_ENV === "production")
        throw Error("Production requires DATABASE_URL (PostgreSQL)");
      const path = resolve(process.env.SQLITE_PATH ?? "data/mahjong.sqlite");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.sqlite = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.sqlite.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id));",
      );
    }
  }
  async initV2() {
    const statements = [
      "CREATE TABLE IF NOT EXISTS history_summaries (match_id TEXT PRIMARY KEY,finished_at BIGINT NOT NULL,format TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,payload " +
        (this.pool ? "JSONB" : "TEXT") +
        " NOT NULL)",
      "CREATE TABLE IF NOT EXISTS history_members (user_id TEXT NOT NULL,match_id TEXT NOT NULL,seat INTEGER NOT NULL,finished_at BIGINT NOT NULL,format TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,rank INTEGER,net_points INTEGER NOT NULL,PRIMARY KEY(user_id,match_id))",
      "CREATE INDEX IF NOT EXISTS history_user_time ON history_members(user_id,finished_at DESC,match_id DESC)",
      "CREATE INDEX IF NOT EXISTS history_user_filter ON history_members(user_id,format,mode,finished_at DESC,match_id DESC)",
      "CREATE TABLE IF NOT EXISTS replay_positions (user_id TEXT NOT NULL,match_id TEXT NOT NULL,payload " +
        (this.pool ? "JSONB" : "TEXT") +
        " NOT NULL,PRIMARY KEY(user_id,match_id))",
      "CREATE TABLE IF NOT EXISTS migration_issues (match_id TEXT PRIMARY KEY,reason TEXT NOT NULL)",
      ...RATING_SCHEMA,
    ];
    for (const sql of statements) {
      if (this.pool) await this.pool.query(sql);
      else this.sqlite!.exec(sql);
    }
  }
  async get<T>(kind: string, id: string): Promise<T | null> {
    if (this.pool) {
      const r = await this.pool.query(
        "SELECT payload FROM documents WHERE kind=$1 AND id=$2",
        [kind, id],
      );
      return r.rows[0]?.payload ?? null;
    }
    const r = this.sqlite!.prepare(
      "SELECT payload FROM documents WHERE kind=? AND id=?",
    ).get(kind, id) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) : null;
  }
  async activeGames<T>(): Promise<{ id: string; data: T }[]> {
    const sql = this.pool
      ? "SELECT id,payload FROM documents WHERE kind='match' AND (payload->>'status'='RUNNING' OR payload->>'phase'='HAND_RESULT')"
      : "SELECT id,payload FROM documents WHERE kind='match' AND (json_extract(payload,'$.status')='RUNNING' OR json_extract(payload,'$.phase')='HAND_RESULT')";
    const rows = this.pool
      ? (await this.pool.query(sql)).rows
      : this.sqlite!.prepare(sql).all();
    return rows.map((r: any) => ({
      id: r.id,
      data: this.pool ? r.payload : JSON.parse(r.payload),
    }));
  }
  async scanMatches(
    after: string,
    limit = 50,
  ): Promise<{ id: string; data: any }[]> {
    const rows = this.pool
      ? (
          await this.pool.query(
            "SELECT id,payload FROM documents WHERE kind='match' AND id>$1 ORDER BY id LIMIT $2",
            [after, limit],
          )
        ).rows
      : this.sqlite!.prepare(
          "SELECT id,payload FROM documents WHERE kind='match' AND id>? ORDER BY id LIMIT ?",
        ).all(after, limit);
    return rows.map((r: any) => ({
      id: r.id,
      data: this.pool ? r.payload : JSON.parse(r.payload),
    }));
  }
  async summary(
    matchId: string,
    userId?: string,
  ): Promise<HistorySummary | null> {
    const values = [matchId];
    let sql =
      "SELECT s.payload,EXISTS(SELECT 1 FROM documents d WHERE d.kind='match' AND d.id=s.match_id) AS has_replay FROM history_summaries s";
    if (userId) {
      sql +=
        " JOIN history_members m ON m.match_id=s.match_id WHERE s.match_id=? AND m.user_id=?";
      values.push(userId);
    } else sql += " WHERE s.match_id=?";
    if (this.pool) {
      let i = 0;
      sql = sql.replace(/\?/g, () => "$" + ++i);
      const r = await this.pool.query(sql, values);
      return summaryRow(r.rows[0], true);
    }
    const r = this.sqlite!.prepare(sql).get(...values) as
      { payload: string } | undefined;
    return summaryRow(r, false);
  }
  async history(
    userId: string,
    filter: {
      format?: MatchFormat;
      mode?: MatchMode;
      cursor?: { time: number; id: string } | null;
    },
  ) {
    const values: (string | number)[] = [userId];
    let where = "m.user_id=?";
    for (const key of ["format", "mode"] as const)
      if (filter[key]) {
        where += " AND m." + key + "=?";
        values.push(filter[key]!);
      }
    if (filter.cursor) {
      where += " AND (m.finished_at<? OR (m.finished_at=? AND m.match_id<?))";
      values.push(filter.cursor.time, filter.cursor.time, filter.cursor.id);
    }
    let sql =
      "SELECT s.payload,EXISTS(SELECT 1 FROM documents d WHERE d.kind='match' AND d.id=s.match_id) AS has_replay FROM history_members m JOIN history_summaries s ON s.match_id=m.match_id WHERE " +
      where +
      " ORDER BY m.finished_at DESC,m.match_id DESC LIMIT 21";
    let rows: any[];
    if (this.pool) {
      let i = 0;
      sql = sql.replace(/\?/g, () => "$" + ++i);
      rows = (await this.pool.query(sql, values)).rows;
    } else rows = this.sqlite!.prepare(sql).all(...values);
    const all: HistorySummary[] = rows.map((r) => summaryRow(r, !!this.pool)!),
      items = all.slice(0, 20);
    return {
      items,
      nextCursor: all.length > 20 ? encodeCursor(items.at(-1)!) : null,
    };
  }
  async stats(
    userId: string,
    filter: {
      format?: MatchFormat;
      mode?: MatchMode;
      from: number;
      to: number;
    },
  ): Promise<MatchStats> {
    const values: (string | number)[] = [userId, filter.from, filter.to];
    let where =
      "user_id=? AND status='FINISHED' AND finished_at>=? AND finished_at<=?";
    for (const k of ["format", "mode"] as const)
      if (filter[k]) {
        where += " AND " + k + "=?";
        values.push(filter[k]!);
      }
    let sql =
      "SELECT rank,COUNT(*) AS n,SUM(net_points) AS net FROM history_members WHERE " +
      where +
      " GROUP BY rank";
    let rows: any[];
    if (this.pool) {
      let i = 0;
      sql = sql.replace(/\?/g, () => "$" + ++i);
      rows = (await this.pool.query(sql, values)).rows;
    } else rows = this.sqlite!.prepare(sql).all(...values);
    const count = rows.reduce((n, r) => n + Number(r.n), 0),
      net = rows.reduce((n, r) => n + Number(r.net), 0),
      sum = rows.reduce((n, r) => n + Number(r.rank) * Number(r.n), 0);
    const distribution = [1, 2, 3, 4].map((rank) => {
      const n = Number(rows.find((r) => Number(r.rank) === rank)?.n ?? 0);
      return { rank, count: n, rate: count ? n / count : null };
    });
    return {
      count,
      firstPlaceRate: count ? distribution[0].count / count : null,
      averageRank: count ? sum / count : null,
      averageNetPoints: count ? net / count : null,
      distribution,
      from: filter.from,
      to: filter.to,
      format: filter.format ?? null,
      mode: filter.mode ?? null,
    };
  }
  async position(userId: string, matchId: string) {
    if (this.pool) {
      return (
        (
          await this.pool.query(
            "SELECT payload FROM replay_positions WHERE user_id=$1 AND match_id=$2",
            [userId, matchId],
          )
        ).rows[0]?.payload ?? null
      );
    }
    const r = this.sqlite!.prepare(
      "SELECT payload FROM replay_positions WHERE user_id=? AND match_id=?",
    ).get(userId, matchId) as { payload: string } | undefined;
    return r ? JSON.parse(r.payload) : null;
  }
  async setPosition(userId: string, matchId: string, data: unknown) {
    if (this.pool)
      await this.pool.query(
        "INSERT INTO replay_positions(user_id,match_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(user_id,match_id) DO UPDATE SET payload=EXCLUDED.payload",
        [userId, matchId, JSON.stringify(data)],
      );
    else
      this.sqlite!.prepare(
        "INSERT INTO replay_positions(user_id,match_id,payload) VALUES(?,?,?) ON CONFLICT(user_id,match_id) DO UPDATE SET payload=excluded.payload",
      ).run(userId, matchId, JSON.stringify(data));
  }
  async list<T>(kind: string): Promise<{ id: string; data: T }[]> {
    if (this.pool) {
      const r = await this.pool.query(
        "SELECT id,payload FROM documents WHERE kind=$1",
        [kind],
      );
      return r.rows.map((r) => ({ id: r.id, data: r.payload }));
    }
    return (
      this.sqlite!.prepare("SELECT id,payload FROM documents WHERE kind=?").all(
        kind,
      ) as { id: string; payload: string }[]
    ).map((r) => ({ id: r.id, data: JSON.parse(r.payload) }));
  }
  commit(writes: Write[]) {
    return this.exclusive(() => this.commitUnlocked(writes));
  }
  private async commitUnlocked(writes: Write[]) {
    if (this.pool) {
      const c = await this.pool.connect();
      try {
        await c.query("BEGIN");
        for (const w of writes) {
          if (w.kind === "room")
            await this.roomWriteHook?.(new Sql(c, null), w.data);
          if (w.kind === "replay_position") {
            const d = w.data as any;
            await c.query(
              "INSERT INTO replay_positions(user_id,match_id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(user_id,match_id) DO UPDATE SET payload=EXCLUDED.payload",
              [d.userId, d.matchId, JSON.stringify(d.position)],
            );
            continue;
          }
          if (w.kind === "history") {
            await this.writeHistory(c, w.data as HistorySummary);
            continue;
          }
          if (w.kind === "rating") {
            await settleRating(new Sql(c, null), w.data as RatingSettlement);
            continue;
          }
          await c.query(
            "INSERT INTO documents(kind,id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()",
            [w.kind, w.id, JSON.stringify(w.data)],
          );
        }
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    } else {
      this.sqlite!.exec("BEGIN IMMEDIATE");
      try {
        const q = this.sqlite!.prepare(
          "INSERT INTO documents(kind,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
        );
        for (const w of writes) {
          if (w.kind === "room")
            await this.roomWriteHook?.(new Sql(null, this.sqlite), w.data);
          if (w.kind === "replay_position") {
            const d = w.data as any;
            this.sqlite!.prepare(
              "INSERT INTO replay_positions(user_id,match_id,payload) VALUES(?,?,?) ON CONFLICT(user_id,match_id) DO UPDATE SET payload=excluded.payload",
            ).run(d.userId, d.matchId, JSON.stringify(d.position));
            continue;
          }
          if (w.kind === "history") {
            await this.writeHistory(null, w.data as HistorySummary);
            continue;
          }
          if (w.kind === "rating") {
            await settleRating(
              new Sql(null, this.sqlite),
              w.data as RatingSettlement,
            );
            continue;
          }
          q.run(w.kind, w.id, JSON.stringify(w.data), Date.now());
        }
        this.sqlite!.exec("COMMIT");
      } catch (e) {
        this.sqlite!.exec("ROLLBACK");
        throw e;
      }
    }
  }
  private async writeHistory(c: pg.PoolClient | null, s: HistorySummary) {
    const run = async (sql: string, values: (string | number | null)[]) => {
      if (c) {
        let i = 0;
        await c.query(
          sql.replace(/\?/g, () => "$" + ++i),
          values,
        );
      } else this.sqlite!.prepare(sql).run(...values);
    };
    await run(
      "INSERT INTO history_summaries(match_id,finished_at,format,mode,status,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET payload=excluded.payload",
      [s.matchId, s.finishedAt, s.format, s.mode, s.status, JSON.stringify(s)],
    );
    for (const m of s.members.filter((m) => m.userId))
      await run(
        "INSERT INTO history_members(user_id,match_id,seat,finished_at,format,mode,status,rank,net_points) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,match_id) DO NOTHING",
        [
          m.userId!,
          s.matchId,
          m.seat,
          s.finishedAt,
          s.format,
          s.mode,
          s.status,
          m.rank,
          m.netPoints,
        ],
      );
  }
  async ratings() {
    if (!this.pool) return loadRatings(new Sql(null, this.sqlite));
    const c = await this.pool.connect();
    try {
      return await loadRatings(new Sql(c, null));
    } finally {
      c.release();
    }
  }
  async migrationIssue(id: string, reason: string) {
    if (this.pool)
      await this.pool.query(
        "INSERT INTO migration_issues(match_id,reason) VALUES($1,$2) ON CONFLICT(match_id) DO UPDATE SET reason=EXCLUDED.reason",
        [id, reason],
      );
    else
      this.sqlite!.prepare(
        "INSERT INTO migration_issues(match_id,reason) VALUES(?,?) ON CONFLICT(match_id) DO UPDATE SET reason=excluded.reason",
      ).run(id, reason);
  }
  async close() {
    this.sqlite?.close();
    this.sqlite = null;
    if (this.lock) {
      await this.lock.query("SELECT pg_advisory_unlock(849273161)");
      this.lock.release();
    }
    await this.pool?.end();
  }
}
