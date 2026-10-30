import type { Store } from "./store.ts";
import { summarize } from "./history.ts";
import type { GameState } from "./engine.ts";
import type { Room } from "../../shared/types.ts";
export function normalizeRoom(r: Room): Room {
  r.lobbyGeneration ??= 1;
  r.previousMatchIds ??= [];
  r.isRematchLobby ??= false;
  r.memberJoinOrder ??= r.slots
    .filter((m) => m?.participantKind === "HUMAN")
    .map((m) => m!.memberId);
  r.offlineSince ??= {};
  return r;
}
export function normalizeGame(g: GameState): GameState {
  g.format ??= "EAST_ONLY";
  g.mode ??=
    g.players.filter((p) => p.participantKind === "HUMAN").length === 1
      ? "AI_PRACTICE"
      : "FRIENDS";
  g.protocolVersion ??= "1.0";
  for (const p of g.players)
    if (p.participantKind === "BOT") p.botPolicyVersion ??= "legacy-v1";
  return g;
}
export async function backfill(store: Store, force = false) {
  await store.initV2();
  if (!force && (await store.get("migration", "history-v2")))
    return { indexed: 0, issues: 0, alreadyApplied: true };
  let cursor = "",
    indexed = 0,
    issues = 0;
  while (true) {
    const rows = await store.scanMatches(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      try {
        const summary = summarize(row.data);
        if (summary) {
          await store.commit([{ kind: "history", id: row.id, data: summary }]);
          indexed++;
        }
      } catch (e) {
        await store.migrationIssue(row.id, (e as Error).message);
        issues++;
      }
    }
  }
  await store.commit([
    {
      kind: "migration",
      id: "history-v2",
      data: { at: Date.now(), indexed, issues },
    },
  ]);
  return { indexed, issues };
}
