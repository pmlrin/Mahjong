import type pg from "pg";
import type { DatabaseSync } from "node:sqlite";
export type Value = string | number | null;
export class Sql {
  constructor(
    private client: pg.PoolClient | null,
    private sqlite: DatabaseSync | null,
  ) {}
  async query<T = Record<string, any>>(
    sql: string,
    values: Value[] = [],
  ): Promise<{ rows: T[]; changes: number }> {
    if (this.client) {
      let index = 0;
      const r = await this.client.query(
        sql.replace(/\?/g, () => "$" + ++index),
        values,
      );
      return { rows: r.rows, changes: r.rowCount ?? 0 };
    }
    const q = this.sqlite!.prepare(sql);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql))
      return { rows: q.all(...values) as T[], changes: 0 };
    const r = q.run(...values);
    return { rows: [], changes: Number(r.changes) };
  }
  async rows<T = Record<string, any>>(sql: string, values: Value[] = []) {
    return (await this.query<T>(sql, values)).rows;
  }
  async one<T = Record<string, any>>(
    sql: string,
    values: Value[] = [],
  ): Promise<T | null> {
    return (await this.rows<T>(sql, values))[0] ?? null;
  }
}
