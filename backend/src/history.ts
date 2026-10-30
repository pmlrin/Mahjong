import type { GameState } from "./engine.ts";
import {
  PROTOCOL,
  type HistorySummary,
  type HistoryMember,
  type MatchFormat,
  type MatchMode,
} from "../../shared/types.ts";
export function summarize(g: GameState): HistorySummary | null {
  if (!["FINISHED", "ABORTED"].includes(g.status)) return null;
  if (
    !Array.isArray(g.players) ||
    g.players.length !== 4 ||
    new Set(g.players.filter((p) => p.userId).map((p) => p.userId)).size !==
      g.players.filter((p) => p.userId).length
  )
    throw Error("INVALID_MEMBERS");
  if (g.protocolVersion && !["1.0", "2.0"].includes(g.protocolVersion))
    throw Error("UNKNOWN_PROTOCOL");
  if (g.format && !["EAST_ONLY", "HANCHAN"].includes(g.format))
    throw Error("UNKNOWN_FORMAT");
  const legacy = !g.protocolVersion || g.protocolVersion === "1.0";
  const format: MatchFormat = g.format ?? "EAST_ONLY";
  const mode: MatchMode =
    g.mode ??
    (g.players.filter((p) => p.participantKind === "HUMAN").length === 1
      ? "AI_PRACTICE"
      : "FRIENDS");
  if (
    !Number.isSafeInteger(g.createdAt) ||
    !Number.isSafeInteger(g.finishedAt ?? g.events.at(-1)?.at)
  )
    throw Error("INVALID_TIME");
  const r = g.matchResult;
  if (
    g.status === "FINISHED" &&
    (!r ||
      r.finalPoints.length !== 4 ||
      r.ranks.length !== 4 ||
      r.finalPoints.some((p) => !Number.isSafeInteger(p)) ||
      r.finalPoints.reduce((a, b) => a + b, 0) !== 100000 ||
      new Set(r.ranks).size !== 4 ||
      r.ranks.some((n) => ![1, 2, 3, 4].includes(n)))
  )
    throw Error("INVALID_RESULT");
  const members: HistoryMember[] = g.players.map((p, seat) => ({
    seat: seat as 0 | 1 | 2 | 3,
    userId: p.userId,
    displayName: p.displayName,
    participantKind: p.participantKind,
    botLevel:
      p.participantKind === "BOT"
        ? (p.botLevel ?? (legacy ? "STANDARD" : null))
        : null,
    botPolicyVersion:
      p.participantKind === "BOT"
        ? (p.botPolicyVersion ?? (legacy ? "legacy-v1" : null))
        : null,
    points: g.status === "FINISHED" ? r!.finalPoints[seat] : p.points,
    rank: g.status === "FINISHED" ? r!.ranks[seat] : null,
    netPoints: g.status === "FINISHED" ? r!.finalPoints[seat] - 25000 : 0,
  }));
  if (
    members.some(
      (m) =>
        (m.participantKind === "HUMAN" && !m.userId) ||
        (m.participantKind === "BOT" && (!m.botLevel || !m.botPolicyVersion)),
    )
  )
    throw Error("INVALID_MEMBER_POLICY");
  const hands: HistorySummary["hands"] = [];
  const seen = new Set<string>();
  let handIndex = 0;
  const info = new Map<
    string,
    { handIndex: number; round: number; roundNumber: number; honba: number }
  >();
  for (const e of g.events) {
    if (e.type === "DEAL") {
      const d = e.data as { round: number; roundNumber: number; honba: number };
      info.set(e.handId, { handIndex: ++handIndex, ...d });
    }
    if (e.type === "HAND_SETTLED") {
      const d = e.data as NonNullable<GameState["lastResult"]>;
      if (seen.has(d.settlementId)) continue;
      seen.add(d.settlementId);
      const h = info.get(e.handId);
      if (h)
        hands.push({
          handId: e.handId,
          handIndex: h.handIndex,
          roundWind: ["EAST", "SOUTH", "WEST"][h.round],
          roundNumber: h.roundNumber,
          honba: h.honba,
          reason: d.reason,
          delta: d.delta,
          pointsAfter: d.pointsAfter,
        });
    }
  }
  return {
    matchId: g.matchId,
    roomId: g.roomId,
    format,
    mode,
    status: g.status as "FINISHED" | "ABORTED",
    createdAt: g.createdAt,
    finishedAt: g.finishedAt ?? g.events.at(-1)!.at,
    rulesetId: "riichi-4p-v1.0",
    protocolVersion: g.protocolVersion ?? "1.0",
    replayVersion: legacy ? "1.0" : "2.0",
    replayAvailable:
      g.status === "FINISHED" && g.events.some((e) => e.type === "DEAL"),
    source: legacy ? "LEGACY_V1" : "NATIVE_V2",
    members,
    reason: r?.reason ?? "TECHNICAL_FAILURE",
    hands,
  };
}
export function publicSummary(
  s: HistorySummary,
  userId: string,
): HistorySummary {
  return {
    ...s,
    members: s.members.map((m) => ({
      ...m,
      userId: m.userId === userId ? userId : null,
    })),
  };
}
export function decodeCursor(
  cursor: string | undefined,
): { time: number; id: string } | null {
  if (!cursor) return null;
  try {
    const d = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      !Number.isSafeInteger(d.time) ||
      typeof d.id !== "string" ||
      d.id.length > 128
    )
      throw Error();
    return d;
  } catch {
    throw Error("INVALID_CURSOR");
  }
}
export const encodeCursor = (s: HistorySummary) =>
  Buffer.from(JSON.stringify({ time: s.finishedAt, id: s.matchId })).toString(
    "base64url",
  );
export function replayMetadata(raw: Record<string, unknown>) {
  if (!["1.0", "2.0"].includes(String(raw.replayVersion)))
    throw Error("REPLAY_VERSION_UNSUPPORTED");
  return {
    ...raw,
    format: raw.format ?? "EAST_ONLY",
    protocolVersion: raw.protocolVersion ?? "1.0",
  };
}
