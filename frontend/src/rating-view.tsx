import React from "react";
import { ratingTier, tierName, type RatingChange } from "../../shared/rating";

export const signedRating = (n: number) =>
  n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "±0";

/** 「三尾 1320」：尾数在前，数值在后。 */
export const ratingLabel = (rating: number) => `${tierName(rating)} ${rating}`;

/** 名牌、座位上的尾数小签。 */
export function TailBadge({
  rating,
  withValue = false,
}: {
  rating: number | null | undefined;
  withValue?: boolean;
}) {
  if (rating == null) return null;
  return (
    <em className="tail-badge" title={`等级分 ${rating}`}>
      {withValue ? ratingLabel(rating) : tierName(rating)}
    </em>
  );
}

/** 结算表里每一家的等级分：假想妖只写尾数，玩家写尾数和本场加减。 */
export function RatingDeltaCell({ change }: { change?: RatingChange | null }) {
  if (!change) return null;
  return (
    <span className="rating-cell" title={`等级分 ${change.after}`}>
      {tierName(change.after)}
      {!change.fixed && (
        <b className={change.delta >= 0 ? "up" : "down"}>
          {signedRating(change.delta)}
        </b>
      )}
    </span>
  );
}

/** 结算里给自己的一句：本场加减、现在的分和尾数。 */
export function RatingSummary({ change }: { change?: RatingChange | null }) {
  if (!change || change.fixed) return null;
  const before = ratingTier(change.before),
    after = ratingTier(change.after);
  const tail =
    after > before
      ? `升到${tierName(change.after)}`
      : after < before
        ? `回到${tierName(change.after)}`
        : tierName(change.after);
  return (
    <p className="rating-summary">
      等级分 {signedRating(change.delta)}，现在 {change.after}，{tail}
    </p>
  );
}
