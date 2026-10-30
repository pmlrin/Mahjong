import type { Room } from "../../shared/types.ts";
export function checkGeneration(r: Room, generation: unknown) {
  if (!Number.isSafeInteger(generation) || generation !== r.lobbyGeneration)
    throw Error("LOBBY_GENERATION_CONFLICT");
}
export function clearPreparation(r: Room) {
  for (const m of r.slots) if (m?.participantKind === "HUMAN") m.ready = false;
}
export function removeMember(r: Room, userId: string) {
  const slot = r.slots.findIndex((m) => m?.userId === userId);
  if (slot < 0) return;
  const id = r.slots[slot]!.memberId;
  r.slots[slot] = null;
  r.memberJoinOrder = r.memberJoinOrder.filter((x) => x !== id);
  delete r.offlineSince[userId];
  const humans = r.slots.filter((m) => m?.participantKind === "HUMAN");
  if (!humans.length) r.status = "CLOSED";
  else if (r.hostUserId === userId) {
    const first = r.memberJoinOrder.find((id) =>
      humans.some((m) => m!.memberId === id),
    );
    r.hostUserId =
      humans.find((m) => m!.memberId === first)?.userId ?? humans[0]!.userId!;
  }
  clearPreparation(r);
}
export function openRematch(r: Room, now = Date.now()) {
  if (r.status !== "FINISHED" || !r.matchId)
    throw Error("REMATCH_NOT_AVAILABLE");
  r.previousMatchIds.push(r.matchId);
  r.matchId = null;
  r.lobbyGeneration++;
  r.isRematchLobby = true;
  r.status = "WAITING";
  r.offlineSince = {};
  for (const m of r.slots)
    if (m?.participantKind === "HUMAN" && !m.connected)
      r.offlineSince[m.userId!] = now;
  clearPreparation(r);
}
export function expireOffline(r: Room, now = Date.now(), ttl = 30000) {
  if (r.status !== "WAITING" || !r.isRematchLobby) return false;
  let changed = false;
  for (const m of [...r.slots])
    if (
      m?.participantKind === "HUMAN" &&
      !m.connected &&
      r.offlineSince[m.userId!] !== undefined &&
      now - r.offlineSince[m.userId!] >= ttl
    ) {
      removeMember(r, m.userId!);
      changed = true;
    }
  return changed;
}
