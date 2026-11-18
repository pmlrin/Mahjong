/**
 * AI 自对局对比：`node --import tsx scripts/ai-ladder.ts [场数] [EAST_ONLY|HANCHAN] [档位,档位,档位,档位]`
 * 默认四档各一席，按场次轮换座位；结果写入 reports/ai-ladder-<赛制>.json。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createGame,
  quad,
  assertInvariants,
  project,
  apply,
  advanceResult,
} from "../backend/src/engine.ts";
import { chooseBot } from "../backend/src/bot.ts";
import { MASTER_TUNE } from "../backend/src/bot-strong.ts";
import {
  BOT_LEVELS,
  BOT_LEVEL_LABELS,
  BOT_POLICY_VERSION,
  type BotLevel,
  type MatchFormat,
  type Seat,
} from "../shared/types.ts";

const count = Number(process.argv[2] ?? 200),
  format = (process.argv[3] ?? "EAST_ONLY") as MatchFormat,
  lineup = (process.argv[4]?.split(",") ?? BOT_LEVELS) as BotLevel[];
if (!["EAST_ONLY", "HANCHAN"].includes(format)) throw Error("Unknown format");
// Tuning: MASTER_TUNE='{"tax":0.02}' overrides MASTER's weights for this run.
if (process.env.MASTER_TUNE)
  Object.assign(MASTER_TUNE, JSON.parse(process.env.MASTER_TUNE));
if (lineup.length !== 4 || lineup.some((l) => !BOT_LEVELS.includes(l)))
  throw Error("Lineup needs four levels");
const levels = BOT_LEVELS.filter((l) => lineup.includes(l));
const blank = () => ({
  seats: 0,
  rankSum: 0,
  ranks: [0, 0, 0, 0],
  pointSum: 0,
  hands: 0,
  wins: 0,
  winPoints: 0,
  dealIns: 0,
  dealInPoints: 0,
  riichi: 0,
  calls: 0,
  decisions: 0,
  ms: 0,
  maxMs: 0,
});
const stats = Object.fromEntries(levels.map((l) => [l, blank()])) as Record<
  BotLevel,
  ReturnType<typeof blank>
>;
const start = performance.now();
let totalHands = 0;
for (let seed = 1; seed <= count; seed++) {
  const at = (s: Seat) => lineup[(s + seed) % 4];
  const g = createGame(
    "ladder",
    quad((s) => ({
      memberId: String(s),
      userId: null,
      displayName: "AI " + s,
      participantKind: "BOT",
      ready: true,
      connected: true,
      botLevel: at(s),
      botPolicyVersion: BOT_POLICY_VERSION,
    })),
    undefined,
    Date.now(),
    seed,
    format,
  );
  let actions = 0;
  while (g.phase !== "MATCH_RESULT") {
    if (actions++ > 20000) throw Error(`Stalled seed ${seed}`);
    if (g.phase === "HAND_RESULT") {
      const r = g.lastResult!;
      totalHands++;
      for (const s of [0, 1, 2, 3] as Seat[]) {
        const st = stats[at(s)],
          p = g.players[s];
        st.hands++;
        if (p.riichi !== "NONE") st.riichi++;
        if (p.melds.some((m) => m.type !== "ANKAN")) st.calls++;
        if (r.wins.some((w) => w.winnerSeat === s)) {
          st.wins++;
          st.winPoints += r.delta[s];
        }
        if (r.wins.some((w) => w.method === "RON" && w.sourceSeat === s)) {
          st.dealIns++;
          st.dealInPoints -= r.delta[s];
        }
      }
      advanceResult(g);
      continue;
    }
    const s = g.decisions.findIndex((d) => d && !d.choice) as Seat;
    if (s < 0) throw Error("No decision");
    const t = performance.now();
    const choice = chooseBot(project(g, s));
    const ms = performance.now() - t,
      st = stats[at(s)];
    st.decisions++;
    st.ms += ms;
    st.maxMs = Math.max(st.maxMs, ms);
    apply(g, s, choice);
  }
  assertInvariants(g);
  for (const s of [0, 1, 2, 3] as Seat[]) {
    const st = stats[at(s)],
      rank = g.matchResult!.ranks[s];
    st.seats++;
    st.rankSum += rank;
    st.ranks[rank - 1]++;
    st.pointSum += g.matchResult!.finalPoints[s];
  }
  if (seed % 50 === 0) console.error(`${seed}/${count}`);
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const rows = levels.map((l) => {
  const s = stats[l];
  return {
    level: l,
    label: BOT_LEVEL_LABELS[l],
    seats: s.seats,
    averageRank: Math.round((s.rankSum / s.seats) * 1000) / 1000,
    firstRate: pct(s.ranks[0], s.seats),
    lastRate: pct(s.ranks[3], s.seats),
    averagePoints: Math.round(s.pointSum / s.seats),
    winRate: pct(s.wins, s.hands),
    dealInRate: pct(s.dealIns, s.hands),
    averageWin: Math.round(s.winPoints / Math.max(1, s.wins)),
    averageDealIn: Math.round(s.dealInPoints / Math.max(1, s.dealIns)),
    riichiRate: pct(s.riichi, s.hands),
    callRate: pct(s.calls, s.hands),
    decisionMsAvg: Math.round((s.ms / s.decisions) * 100) / 100,
    decisionMsMax: Math.round(s.maxMs),
  };
});
const result = {
  at: new Date().toISOString(),
  botPolicyVersion: BOT_POLICY_VERSION,
  format,
  lineup,
  matches: count,
  hands: totalHands,
  elapsedMs: Math.round(performance.now() - start),
  rows,
};
mkdirSync("reports", { recursive: true });
writeFileSync(
  `reports/ai-ladder-${format}${process.argv[4] ? "-" + lineup.join("-") : ""}.json`,
  JSON.stringify(result, null, 2),
);
console.table(rows);
console.log(
  JSON.stringify({
    matches: count,
    hands: totalHands,
    elapsedMs: result.elapsedMs,
  }),
);
