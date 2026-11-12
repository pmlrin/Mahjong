// What just happened at the table, worked out by comparing two snapshots.
// The server only sends whole views, so sounds and table effects read these
// events instead. Pure: no React, DOM or audio here.
import type { Frame, MatchView, Meld, Seat } from "../../shared/types";

export type CallType = Meld["type"];
export type MatchEvent =
  | {
      type: "discard";
      seat: Seat;
      tile: number;
      tsumogiri: boolean;
      riichi: boolean;
    }
  | { type: "call"; seat: Seat; call: CallType; from: Seat | null }
  | { type: "riichi"; seat: Seat }
  | { type: "riichi-stick"; seat: Seat }
  | { type: "dora"; tile: number }
  | {
      type: "win";
      seat: Seat;
      method: "TSUMO" | "RON" | "NAGASHI_MANGAN";
      from: Seat | null;
    }
  | { type: "draw"; reason: string };

/** More changes than this in one step means we missed frames: do not replay. */
export const MAX_STEP_EVENTS = 6;

const isPrefix = <T>(a: readonly T[], b: readonly T[]) =>
  a.length <= b.length && a.every((x, i) => x === b[i]);

/**
 * Events between two frames of one viewer's stream. Only the very next frame
 * is a step of play: a frame answering a sync (attach after a reconnect, a
 * page coming back to the front) or one after a gap in the sequence is shown
 * as it is, never replayed (null).
 */
export function frameEvents(before: Frame, after: Frame): MatchEvent[] | null {
  if (
    after.syncId ||
    after.streamId !== before.streamId ||
    after.viewSeq !== before.viewSeq + 1
  )
    return null;
  return matchEvents(before.state, after.state);
}

/**
 * Events between two views of the same match, in the order they happened, or
 * null when the step is not one continuous move (a new match, a reconnect that
 * skipped ahead, a resync that rewrote history) and should just be shown.
 * A new hand gives no events: its deal is shown as it is.
 */
export function matchEvents(
  before: MatchView,
  after: MatchView,
): MatchEvent[] | null {
  if (before.matchId !== after.matchId) return null;
  const a = before.hand,
    b = after.hand;
  if (a.handId !== b.handId) return [];
  // Several seats can change in one step; list them in the order play runs:
  // a riichi is declared with its discard, calls answer a discard, the stick
  // goes down once the discard passes, a kan turns a dora, then the result.
  const declared: MatchEvent[] = [],
    discards: MatchEvent[] = [],
    calls: MatchEvent[] = [],
    sticks: MatchEvent[] = [],
    ending: MatchEvent[] = [];
  for (let s = 0; s < 4; s++) {
    const seat = s as Seat,
      was = a.seats[s],
      now = b.seats[s];
    const ids = (d: typeof was.discards) => d.map((x) => x.discardId);
    if (!isPrefix(ids(was.discards), ids(now.discards))) return null;
    // A meld may grow (pon to added kan) but never vanish or reorder.
    if (
      !isPrefix(
        was.melds.map((m) => m.meldId),
        now.melds.map((m) => m.meldId),
      )
    )
      return null;
    if (was.riichi === "NONE" && now.riichi !== "NONE")
      declared.push({ type: "riichi", seat });
    for (const d of now.discards.slice(was.discards.length))
      discards.push({
        type: "discard",
        seat,
        tile: d.tile,
        tsumogiri: d.tsumogiri,
        riichi: d.riichiDeclaration,
      });
    if (was.riichi !== "ESTABLISHED" && now.riichi === "ESTABLISHED")
      sticks.push({ type: "riichi-stick", seat });
    for (const m of now.melds) {
      const old = was.melds.find((x) => x.meldId === m.meldId);
      const fresh = !old || (old.type === "PON" && m.type === "KAKAN");
      if (!fresh) continue;
      // A closed or added kan was already announced when it was proposed.
      const proposed =
        (m.type === "ANKAN" || m.type === "KAKAN") &&
        a.pendingKan?.seat === seat &&
        a.pendingKan.type === m.type;
      if (!proposed)
        calls.push({ type: "call", seat, call: m.type, from: m.sourceSeat });
    }
  }
  const k = b.pendingKan;
  if (k && !(a.pendingKan?.seat === k.seat && a.pendingKan.type === k.type))
    calls.push({ type: "call", seat: k.seat, call: k.type, from: null });
  if (!isPrefix(a.doraIndicators, b.doraIndicators)) return null;
  const dora: MatchEvent[] = b.doraIndicators
    .slice(a.doraIndicators.length)
    .map((tile) => ({ type: "dora", tile }));
  const result = after.lastHandResult;
  if (
    a.phase !== "HAND_RESULT" &&
    b.phase === "HAND_RESULT" &&
    result?.handId === b.handId
  ) {
    for (const w of result.wins)
      ending.push({
        type: "win",
        seat: w.winnerSeat,
        method: w.method,
        from: w.sourceSeat,
      });
    if (!result.wins.length || result.reason === "NAGASHI_MANGAN")
      ending.push({ type: "draw", reason: result.reason });
  }
  const events = [
    ...declared,
    ...discards,
    ...calls,
    ...sticks,
    ...dora,
    ...ending,
  ];
  return events.length > MAX_STEP_EVENTS ? null : events;
}
