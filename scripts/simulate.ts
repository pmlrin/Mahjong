import { writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createGame,
  quad,
  assertInvariants,
  project,
  apply,
  advanceResult,
  shuffled,
  type GameState,
} from "../backend/src/engine.ts";
import { chooseBot } from "../backend/src/bot.ts";
import {
  BOT_POLICY_VERSION,
  type MatchFormat,
  type Seat,
} from "../shared/types.ts";
const count = Number(process.argv[2] ?? 100),
  start = performance.now(),
  format = (process.argv[3] ?? "EAST_ONLY") as MatchFormat;
if (!["EAST_ONLY", "HANCHAN"].includes(format)) throw Error("Unknown format");
const report = [];
for (let seed = 1; seed <= count; seed++) {
  let rng = seed;
  const random = (n: number) => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) % n;
  };
  const g = createGame(
    "simulation",
    quad((s) => ({
      memberId: String(s),
      userId: null,
      displayName: "AI " + s,
      participantKind: "BOT",
      ready: true,
      connected: true,
      botLevel: s % 2 ? "STANDARD" : "BASIC",
      botPolicyVersion: BOT_POLICY_VERSION,
    })),
    undefined,
    Date.now(),
    seed,
    format,
  );
  let actions = 0;
  while (g.phase !== "MATCH_RESULT") {
    assertInvariants(g);
    if (actions > 20000) throw Error(`Stalled seed ${seed}`);
    if (g.phase === "HAND_RESULT") {
      advanceResult(g);
      continue;
    }
    const s = g.decisions.findIndex((d) => d && !d.choice) as Seat;
    if (s < 0) throw Error("No decision");
    apply(g, s, chooseBot(project(g, s)));
    actions++;
  }
  assertInvariants(g);
  report.push({
    seed,
    hands: g.handIndex,
    actions,
    points: g.players.map((p) => p.points),
    reason: g.matchResult!.reason,
  });
  if (seed % 10 === 0) console.log(`${seed}/${count} matches completed`);
}
mkdirSync("reports", { recursive: true });
const result = {
  at: new Date().toISOString(),
  version: "0.2.0",
  format,
  botPolicies: ["BASIC", "STANDARD"],
  matches: count,
  elapsedMs: Math.round(performance.now() - start),
  report,
};
writeFileSync(
  `reports/v2-simulation-${format}.json`,
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    matches: count,
    elapsedMs: result.elapsedMs,
    totalHands: report.reduce((n, r) => n + r.hands, 0),
    actions: report.reduce((n, r) => n + r.actions, 0),
  }),
);
