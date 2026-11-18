// What 大师级 MASTER learned from Tenhou 鳳凰卓 game records: how often a tile
// deals in, how often a player who has not declared riichi is already tenpai,
// and what a deal-in costs. The numbers live in bot-learned-data.ts, written by
// scripts/learn-tenhou.ts; this file holds the features both sides share, so the
// script groups situations exactly the way the AI looks them up.
import { LEARNED } from "./bot-learned-data.ts";

/** Riichi player's discards so far, grouped into stages of the hand. */
export const stageOf = (discards: number) =>
  discards <= 6 ? 0 : discards <= 9 ? 1 : discards <= 12 ? 2 : 3;

/**
 * The class of a tile against one riichi player, from what the deciding player
 * can see: `seen` counts every copy they can see (own hand included), `safe` is
 * what the riichi player can no longer win on (現物 and tiles that passed after
 * the riichi). Null for a safe tile.
 *
 * Number tiles: how far from the edge (1–5) and how many two-sided waits could
 * still take it (筋 and 壁 close a side); with no side open, whether every copy
 * is already visible. Honors: how many copies are still unaccounted for.
 */
export function dangerKey(
  seen: number[],
  safe: Set<number>,
  k: number,
): string | null {
  if (safe.has(k)) return null;
  const left = Math.max(0, 4 - seen[k]);
  if (k >= 27) return `z${left}`;
  const n = (k % 9) + 1,
    base = k - (n - 1);
  const gone = (m: number) => safe.has(base + m - 1);
  const wall = (m: number) => seen[base + m - 1] >= 4;
  const lower = n >= 4 && !gone(n - 3) && !wall(n - 1) && !wall(n - 2);
  const upper = n <= 6 && !gone(n + 3) && !wall(n + 1) && !wall(n + 2);
  const sides = Number(lower) + Number(upper),
    edge = Math.min(n, 10 - n);
  return `n${edge}${sides}${sides === 0 && left === 0 ? "x" : ""}`;
}

/**
 * Chance that this tile deals in to a tenpai riichi player, or undefined when
 * the records hold too few cases of its class.
 */
export function learnedDanger(
  seen: number[],
  safe: Set<number>,
  k: number,
  discards: number,
): number | undefined {
  const key = dangerKey(seen, safe, k);
  if (key === null) return 0;
  return LEARNED.danger[key]?.[stageOf(discards)];
}

/** A player's discards so far, grouped for the tenpai table. */
export const turnOf = (discards: number) =>
  Math.min(5, Math.floor(discards / 3));

/**
 * Chance a player who has not declared riichi is tenpai, by open sets (not
 * counting closed kans, 0–4) and discards so far.
 */
export const learnedTenpai = (open: number, discards: number) =>
  LEARNED.tenpai[Math.min(4, open)][turnOf(discards)];

/** Points a ron costs (before honba), by who wins it. */
export const learnedLoss = {
  riichi: (dealer: boolean) => LEARNED.loss.riichi[dealer ? 1 : 0],
  /** A closed hand that did not declare riichi. */
  dama: (dealer: boolean) => LEARNED.loss.dama[dealer ? 1 : 0],
  /** An open hand, by the han its sets show (役牌 and dora in them, 0–4+). */
  open: (han: number, dealer: boolean) =>
    LEARNED.loss.open[Math.min(4, Math.max(0, Math.floor(han)))][
      dealer ? 1 : 0
    ],
};
