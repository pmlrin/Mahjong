// 等级分结算。规则在 shared/rating.ts，说明见 docs/等级分规则.md。
import type { Sql } from "./sql.ts";
import type { GameState } from "./engine.ts";
import type { Quad } from "../../shared/types.ts";
import {
  BOT_RATINGS,
  INITIAL_RATING,
  RATING_FLOOR,
  rateMatch,
  type RatingChange,
} from "../../shared/rating.ts";

export const RATING_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS player_ratings (user_id TEXT PRIMARY KEY,rating INTEGER NOT NULL,matches INTEGER NOT NULL,updated_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rating_settlements (match_id TEXT PRIMARY KEY,settled_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rating_changes (match_id TEXT NOT NULL,user_id TEXT NOT NULL,seat INTEGER NOT NULL,before_rating INTEGER NOT NULL,after_rating INTEGER NOT NULL,delta INTEGER NOT NULL,settled_at BIGINT NOT NULL,PRIMARY KEY(match_id,user_id))",
  "CREATE INDEX IF NOT EXISTS rating_changes_user ON rating_changes(user_id,settled_at DESC)",
];

/** The payload of a `kind: "rating"` write. */
export interface RatingSettlement {
  matchId: string;
  settledAt: number;
  entries: { userId: string; seat: number; delta: number }[];
}

/** Rating a seat counts with: a human's current rating, or a bot's fixed one. */
export function seatRating(
  p: GameState["players"][number],
  ratingOf: (userId: string) => number,
) {
  if (p.participantKind === "BOT") return BOT_RATINGS[p.botLevel ?? "STANDARD"];
  return p.userId ? ratingOf(p.userId) : INITIAL_RATING;
}

/**
 * Computes this match's rating changes once and keeps them on the match
 * result, so every later save, view and restart reuses the same numbers.
 * Only a normally FINISHED match is rated; ABORTED never is.
 */
export function attachRating(
  g: GameState,
  ratingOf: (userId: string) => number,
): RatingSettlement | null {
  const r = g.matchResult;
  if (g.status !== "FINISHED" || !r) return null;
  if (!r.ratingChanges) {
    r.ratingChanges = rateMatch(
      g.players.map((p, s) => ({
        rating: seatRating(p, ratingOf),
        fixed: p.participantKind === "BOT" || !p.userId,
        rank: r.ranks[s],
        finalPoints: r.finalPoints[s],
      })) as Quad<{
        rating: number;
        fixed: boolean;
        rank: number;
        finalPoints: number;
      }>,
      g.format ?? "EAST_ONLY",
    );
  }
  const changes = r.ratingChanges as Quad<RatingChange>;
  return {
    matchId: g.matchId,
    settledAt: g.finishedAt ?? Date.now(),
    entries: g.players.flatMap((p, seat) =>
      p.participantKind === "HUMAN" && p.userId && !changes[seat].fixed
        ? [{ userId: p.userId, seat, delta: changes[seat].delta }]
        : [],
    ),
  };
}

/**
 * Applies a settlement inside the caller's transaction. The settlement row is
 * the idempotency key: a repeated save, retry or restart changes nothing.
 * Returns the ratings after the settlement, or null if it was already applied.
 */
export async function settleRating(
  tx: Sql,
  s: RatingSettlement,
): Promise<Map<string, number> | null> {
  const claimed = await tx.query(
    "INSERT INTO rating_settlements(match_id,settled_at) VALUES(?,?) ON CONFLICT(match_id) DO NOTHING",
    [s.matchId, s.settledAt],
  );
  if (!claimed.changes) return null;
  const after = new Map<string, number>();
  for (const e of s.entries) {
    const row = await tx.one<{ rating: number; matches: number }>(
      "SELECT rating,matches FROM player_ratings WHERE user_id=?",
      [e.userId],
    );
    const before = row ? Number(row.rating) : INITIAL_RATING;
    const next = Math.max(RATING_FLOOR, before + e.delta);
    await tx.query(
      "INSERT INTO player_ratings(user_id,rating,matches,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET rating=excluded.rating,matches=excluded.matches,updated_at=excluded.updated_at",
      [e.userId, next, (row ? Number(row.matches) : 0) + 1, s.settledAt],
    );
    await tx.query(
      "INSERT INTO rating_changes(match_id,user_id,seat,before_rating,after_rating,delta,settled_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(match_id,user_id) DO NOTHING",
      [s.matchId, e.userId, e.seat, before, next, next - before, s.settledAt],
    );
    after.set(e.userId, next);
  }
  return after;
}

export async function loadRatings(tx: Sql) {
  const rows = await tx.rows<{
    user_id: string;
    rating: number;
    matches: number;
  }>("SELECT user_id,rating,matches FROM player_ratings");
  return new Map(
    rows.map((r) => [
      r.user_id,
      { rating: Number(r.rating), matches: Number(r.matches) },
    ]),
  );
}
