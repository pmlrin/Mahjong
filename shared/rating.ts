// 等级分（rating）规则。前后端共用，说明见 docs/等级分规则.md。
import type { BotLevel, MatchFormat, Quad } from "./types.ts";

/** 新玩家的初始等级分（一尾，与一尾假想妖同分）。 */
export const INITIAL_RATING = 900;
/** 等级分不低于此值。 */
export const RATING_FLOOR = 0;
/** 一场东风战里，位次部分的最大幅度系数。 */
export const RATING_K = 60;
/** 半庄战比东风战长，加减乘以此倍数。 */
export const FORMAT_WEIGHT: Record<MatchFormat, number> = {
  EAST_ONLY: 1,
  HANCHAN: 1.5,
};
/** Elo 期望里分差的上限：再大的差距也按 400 分计。 */
export const RATING_DIFF_CAP = 400;
/** 每多（少）这么多点，点数修正加（减）1 分。 */
export const POINTS_PER_RATING = 2000;
/** 点数修正的上下限。 */
export const POINT_ADJUST_CAP = 10;

/** 四档假想妖的固定等级分，各在自己尾数档位的中间。AI 的分不会变。 */
export const BOT_RATINGS: Record<BotLevel, number> = {
  BASIC: 900, // 一尾
  STANDARD: 1300, // 三尾
  ADVANCED: 1900, // 六尾
  MASTER: 2500, // 九尾
};

export const TAIL_NAMES = [
  "一尾",
  "二尾",
  "三尾",
  "四尾",
  "五尾",
  "六尾",
  "七尾",
  "八尾",
  "九尾",
  "十尾",
] as const;

/** 第 n 尾（1–10）的下限；一尾没有下限。 */
export const tierFloor = (tier: number) =>
  tier <= 1 ? RATING_FLOOR : 1000 + (tier - 2) * 200;

/** 等级分对应的尾数（1–10）：一尾 <1000，之后每 200 分一档，十尾 ≥2600。 */
export function ratingTier(rating: number): number {
  if (!Number.isFinite(rating) || rating < 1000) return 1;
  return Math.min(10, Math.floor((rating - 1000) / 200) + 2);
}
export const tierName = (rating: number) => TAIL_NAMES[ratingTier(rating) - 1];

export interface RatingChange {
  before: number;
  after: number;
  delta: number;
  /** 假想妖：固定分，不变动。 */
  fixed: boolean;
}

export interface RatingSeat {
  /** 本场开始前的等级分（人类为当前分，假想妖为固定分）。 */
  rating: number;
  /** 假想妖座位不结算。托管或断线的人类座位照常结算。 */
  fixed: boolean;
  rank: number;
  finalPoints: number;
}

/** Elo 期望：i 对 j 赢的概率。 */
export function expected(ri: number, rj: number) {
  const d = Math.max(-RATING_DIFF_CAP, Math.min(RATING_DIFF_CAP, rj - ri));
  return 1 / (1 + 10 ** (d / 400));
}

/** 位次部分：与另外三家逐一比较，实际（名次在前记 1，在后记 0）减期望，取平均再乘 K。 */
export function placementDelta(seats: Quad<RatingSeat>, i: number) {
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    if (j === i) continue;
    const actual = seats[i].rank < seats[j].rank ? 1 : 0;
    sum += actual - expected(seats[i].rating, seats[j].rating);
  }
  return (RATING_K * sum) / 3;
}

/** 点数部分：以 25000 为基准，每 2000 点 1 分，上下限 ±10。 */
export function pointAdjust(finalPoints: number) {
  const v = (finalPoints - 25000) / POINTS_PER_RATING;
  return Math.max(-POINT_ADJUST_CAP, Math.min(POINT_ADJUST_CAP, v));
}

/** 一场正常结束的对局，四个座位各自的等级分变化。 */
export function rateMatch(
  seats: Quad<RatingSeat>,
  format: MatchFormat = "EAST_ONLY",
): Quad<RatingChange> {
  if (new Set(seats.map((s) => s.rank)).size !== 4)
    throw Error("INVALID_RANKS");
  const weight = FORMAT_WEIGHT[format] ?? 1;
  return seats.map((s, i) => {
    const before = Math.round(s.rating);
    if (s.fixed) return { before, after: before, delta: 0, fixed: true };
    const raw =
      (placementDelta(seats, i) + pointAdjust(s.finalPoints)) * weight;
    const after = Math.max(RATING_FLOOR, before + Math.round(raw));
    return { before, after, delta: after - before, fixed: false };
  }) as Quad<RatingChange>;
}
