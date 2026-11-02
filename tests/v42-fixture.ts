import { createGame, project, quad } from "../backend/src/engine.ts";
import type { Frame } from "../shared/types.ts";
export function fixture(): Frame {
  const g = createGame(
    "v42",
    quad((s) => ({
      memberId: String(s),
      userId: String(s),
      displayName: `玩家${s}`,
      participantKind: "HUMAN",
      ready: true,
      connected: true,
      botLevel: null,
    })),
  );
  const v = project(g, 0);
  v.matchId = "match-v42";
  v.hand.handId = "hand-v42";
  v.hand.window!.windowId = "window-v42";
  v.self.decision!.windowId = "window-v42";
  v.self.decision!.decisionId = "decision-v42";
  v.hand.window!.deadlineAt = 16000;
  v.self.decision!.deadlineAt = 16000;
  // Deterministic physical copies: red five and normal five in hand, a third copy drawn.
  v.self.concealedTiles = [0, 4, 8, 12, 16, 17, 20, 24, 28, 32, 36, 40, 44];
  v.self.drawnTile = 18;
  v.self.decision!.options = [...v.self.concealedTiles, v.self.drawnTile].map(
    (tile) => ({ type: "DISCARD", optionId: `discard-${tile}`, tile }),
  );
  return {
    protocolVersion: "2.0",
    serverTime: 1000,
    serverEpoch: 1,
    matchId: v.matchId,
    streamId: "stream",
    viewSeq: 1,
    syncId: null,
    state: v,
  };
}
