import {
  createGame,
  quad,
  log,
  assertInvariants,
  type GameState,
} from "./engine.ts";
// Quarantine keeps the original document. This safe terminal state has no playable hand or result.
export function recoverable(g: GameState) {
  if (
    !["1.0", "2.0"].includes(g.protocolVersion) ||
    !["EAST_ONLY", "HANCHAN"].includes(g.format)
  )
    throw Error("UNSUPPORTED_STATE");
  if (!Array.isArray(g.events) || g.players.length !== 4)
    throw Error("INVALID_STATE");
  assertInvariants(g);
}
export function technicalAbort(source: GameState, now = Date.now()): GameState {
  const g = createGame(
    source.roomId,
    source.players,
    undefined,
    source.createdAt,
    null,
    source.format,
  );
  g.matchId = source.matchId;
  g.protocolVersion = source.protocolVersion;
  g.mode = source.mode;
  g.status = "ABORTED";
  g.phase = "MATCH_ABORTED";
  g.serverEpoch = source.serverEpoch + 1;
  g.handId = source.handId;
  g.handIndex = source.handIndex;
  g.round = source.round;
  g.roundNumber = source.roundNumber;
  g.dealer = source.dealer;
  g.honba = source.honba;
  g.window = null;
  g.decisions = quad(() => null);
  g.matchResult = null;
  g.lastResult = null;
  g.finishedAt = now;
  g.wall = g.shuffled.slice(0, 122);
  g.dead = g.shuffled.slice(122);
  g.kyotaku = Number.isSafeInteger(source.kyotaku) ? source.kyotaku : 0;
  for (const p of g.players) {
    p.tiles = [];
    p.drawn = null;
    p.points = Number.isSafeInteger(source.players[p.seat].points)
      ? source.players[p.seat].points
      : 0;
  }
  g.events = Array.isArray(source.events) ? structuredClone(source.events) : [];
  log(g, "MATCH_ABORTED", { reason: "TECHNICAL_FAILURE" });
  return g;
}
