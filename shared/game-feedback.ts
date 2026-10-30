import { kind, type MatchView, type Option, type Seat } from "./types.ts";
export interface TileSource {
  seat: Seat;
  tile: number;
  displayName: string;
  relation: string;
  source: "DISCARD" | "KAN";
  discardId: string | null;
}
export function sourceFor(
  view: MatchView,
  seat: Seat,
  tile: number,
  source: "DISCARD" | "KAN",
  discardId: string | null,
): TileSource {
  return {
    seat,
    tile,
    displayName: view.players[seat].displayName,
    relation: ["你", "下家", "对家", "上家"][(seat - view.viewerSeat + 4) % 4],
    source,
    discardId,
  };
}
/** Match the current response window, never reuse an unrelated old discard. */
export function responseTarget(view: MatchView): TileSource | null {
  const w = view.hand.window;
  if (w?.kind === "CALL_RESPONSE") {
    const d = view.hand.seats[w.actorSeat].discards.find(
      (d) => d.discardId === w.sourceDiscardId,
    );
    return d
      ? sourceFor(view, w.actorSeat, d.tile, "DISCARD", d.discardId)
      : null;
  }
  if (w?.kind === "KAN_RESPONSE" && view.hand.pendingKan) {
    const k = view.hand.pendingKan;
    return sourceFor(view, k.seat, k.robbableTile, "KAN", null);
  }
  return null;
}
export function callTiles(option: Option, targetTile: number): number[] {
  return [...(option.consumedTiles ?? []), targetTile].sort(
    (a, b) => kind(a) - kind(b) || a - b,
  );
}
