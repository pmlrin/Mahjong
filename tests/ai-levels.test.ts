import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceResult,
  apply,
  assertInvariants,
  createGame,
  project,
  quad,
} from "../backend/src/engine.ts";
import { botLevelOf, chooseBot } from "../backend/src/bot.ts";
import { dangerRate } from "../backend/src/bot-strong.ts";
import {
  AUTOPILOT_BOT_LEVEL,
  BOT_LEVELS,
  BOT_LEVEL_LABELS,
  BOT_POLICY_VERSION,
  botLevelLabel,
  type BotLevel,
  type Seat,
} from "../shared/types.ts";
import { describe, position, type Position } from "./ai-fixture.ts";

const play = (p: Position, level: BotLevel) => {
  const { view } = position({ ...p, level });
  return describe(view, chooseBot(view));
};
const all = (p: Position) =>
  Object.fromEntries(BOT_LEVELS.map((l) => [l, play(p, l)])) as Record<
    BotLevel,
    string
  >;

test("四档按强弱排列，名称为初级／中级／高级／大师级，托管固定为中级", () => {
  assert.deepEqual(BOT_LEVELS, ["BASIC", "STANDARD", "ADVANCED", "MASTER"]);
  assert.deepEqual(
    BOT_LEVELS.map((l) => BOT_LEVEL_LABELS[l]),
    ["初级", "中级", "高级", "大师级"],
  );
  assert.equal(AUTOPILOT_BOT_LEVEL, "STANDARD");
  assert.equal(botLevelLabel(null), "中级");
});

// 二向听的散牌，对家立直。手里的白和九万是现物，五索无筋。
const riichiFold: Position = {
  hand: "m1299p3467s3558z5" + "z2",
  discards: { 2: "z5m9p1z3s9z1", 0: "z6z7" },
  riichi: [2],
};
test("初级不防守：立直之下仍按牌效率切牌，中级起改切现物", () => {
  const r = all(riichiFold);
  assert.equal(r.BASIC, "DISCARD z2");
  for (const l of ["STANDARD", "ADVANCED", "MASTER"] as BotLevel[])
    assert.match(r[l], /^DISCARD (z5|m9)$/, l);
});

test("托管的真人座位用中级：与中级 AI 同手，而不是初级", () => {
  const { view } = position({ ...riichiFold, hosted: true });
  assert.equal(view.players[0].participantKind, "HUMAN");
  assert.equal(view.players[0].botLevel, null);
  assert.equal(botLevelOf(view), "STANDARD");
  assert.equal(describe(view, chooseBot(view)), play(riichiFold, "STANDARD"));
  assert.notEqual(describe(view, chooseBot(view)), play(riichiFold, "BASIC"));
});

test("初级见听就立直；中级在终局领先时默听保位", () => {
  const p: Position = {
    hand: "m123456p123s78z11" + "z7",
    riichiOn: "z7",
    points: [35000, 25000, 20000, 20000],
    round: { wind: "SOUTH", number: 4 },
  };
  assert.equal(play(p, "BASIC"), "RIICHI_DISCARD z7");
  assert.equal(play(p, "STANDARD"), "DISCARD z7");
  assert.equal(play(p, "ADVANCED"), "DISCARD z7");
  assert.equal(play(p, "MASTER"), "DISCARD z7");
});

test("中级只认现物；高级没有现物时会读筋和字牌", () => {
  // 没有现物。四筒是 1-4-7 的两面筋，发是对子；五索无筋。
  const p: Position = {
    hand: "m2378p4s23467z66" + "s5",
    discards: { 2: "p1p7z3m9s9z1" },
    riichi: [2],
  };
  assert.equal(play(p, "STANDARD"), "DISCARD p4", "中级照常按效率切");
  assert.equal(
    play(p, "ADVANCED"),
    "DISCARD z6",
    "高级弃和，拆最安全的字牌对子",
  );
  // 立直者的舍牌让同一张牌的危险度逐级下降。
  const seen = Array(34).fill(0);
  const none = dangerRate(seen, new Set(), 12),
    half = dangerRate(seen, new Set([9]), 12),
    suji = dangerRate(seen, new Set([9, 15]), 12),
    genbutsu = dangerRate(seen, new Set([12]), 12);
  assert(none > half && half > suji && suji > genbutsu);
  assert.equal(genbutsu, 0);
});

test("高级考虑打点：满贯以上的默听不立直，便宜的听牌照常立直", () => {
  // 断幺、平和、三色加两张宝牌，不立直也有满贯。
  const big: Position = {
    hand: "m234p234s23478m66" + "z1",
    dora: "m5",
    riichiOn: "z1",
  };
  assert.equal(play(big, "STANDARD"), "RIICHI_DISCARD z1");
  assert.equal(play(big, "ADVANCED"), "DISCARD z1");
  const cheap: Position = { hand: "m123p456s23478m99" + "z1", riichiOn: "z1" };
  assert.equal(play(cheap, "ADVANCED"), "RIICHI_DISCARD z1");
  assert.equal(play(cheap, "MASTER"), "RIICHI_DISCARD z1");
});

test("高级不为便宜的断幺拆掉门前一向听；初级、中级见能进就吃", () => {
  // 应答窗口里没有摸牌，手牌是 13 张。
  const p: Position = {
    hand: "m234567p3467s558",
    call: {
      from: 3,
      tile: "p5",
      options: [
        { type: "CHI", tiles: "p46" },
        { type: "CHI", tiles: "p34" },
        { type: "CHI", tiles: "p67" },
      ],
    },
  };
  const r = all(p);
  assert.equal(r.BASIC, "CHI");
  assert.equal(r.STANDARD, "CHI");
  assert.equal(r.ADVANCED, "PASS");
  assert.equal(r.MASTER, "PASS");
  // 役牌的碰四档都要。
  const pon: Position = {
    hand: "m2345p3467s559z77",
    call: { from: 2, tile: "z7", options: [{ type: "PON", tiles: "z77" }] },
  };
  for (const l of BOT_LEVELS) assert.equal(play(pon, l), "PON", l);
});

test("大师级知道立直后通过的牌是安全牌；高级只能拆字牌", () => {
  // 对家第三巡立直。之后上家切过五索，没被荣和。
  const p: Position = {
    hand: "m2378p46s23467z6" + "s5",
    discards: {
      2: "z1z3m9s9z2z4",
      3: "z1z2z3m1s5p6",
      1: "z4z3m1p9s1p1",
    },
    riichi: [2],
    riichiAt: { 2: 2 },
  };
  assert.equal(play(p, "ADVANCED"), "DISCARD z6");
  assert.equal(play(p, "MASTER"), "DISCARD s5");
  // 若五索是立直之前切的，就不算安全。
  const early: Position = {
    ...p,
    discards: { ...p.discards, 3: "s5p6z1z2z3m1" },
    riichiAt: { 2: 5 },
  };
  assert.notEqual(play(early, "MASTER"), "DISCARD s5");
});

test("大师级读壁：四张八筒都见了，九筒只剩单骑和双碰能中", () => {
  const p: Position = {
    hand: "m2378p9s234678z6" + "m5",
    discards: { 2: "z1z3m9s9z2z4", 1: "p8p8", 3: "p8p8" },
    riichi: [2],
  };
  assert.equal(play(p, "ADVANCED"), "DISCARD z6");
  assert.equal(play(p, "MASTER"), "DISCARD p9");
});

test("大师级把两副露的他家当作威胁；高级要到三副露才警觉", () => {
  // 下家碰了白、中，已切十张。北是他的现物，西不是。
  const p: Position = {
    hand: "m1289p3467s3558" + "z2z3",
    dora: "z4",
    discards: { 3: "z3m9p1z6s9z1m4p9s1z1" },
    melds: {
      3: [
        { type: "PON", tiles: "z555" },
        { type: "PON", tiles: "z777" },
      ],
    },
  };
  assert.equal(play(p, "ADVANCED"), "DISCARD z2");
  assert.equal(play(p, "MASTER"), "DISCARD z3");
});

test("大师级按役种路线鸣牌：手里还有幺九也敢走断幺", () => {
  // 吃五筒后切掉九索、南、西就是断幺；其余三档要求整手已无幺九才肯吃。
  const p: Position = {
    hand: "m2345p3467s559z2z3",
    wall: 30,
    call: { from: 3, tile: "p5", options: [{ type: "CHI", tiles: "p46" }] },
  };
  const r = all(p);
  assert.equal(r.MASTER, "CHI");
  for (const l of ["BASIC", "STANDARD", "ADVANCED"] as BotLevel[])
    assert.equal(r[l], "PASS", l);
});

test("四档同桌可以把半庄和东风战打完，点数与牌守恒，单步不超时", () => {
  for (const [seed, format] of [
    [11, "EAST_ONLY"],
    [12, "HANCHAN"],
  ] as const) {
    const g = createGame(
      "ai",
      quad((s) => ({
        memberId: String(s),
        userId: null,
        displayName: "AI " + s,
        participantKind: "BOT",
        ready: true,
        connected: true,
        botLevel: BOT_LEVELS[(s + seed) % 4],
        botPolicyVersion: BOT_POLICY_VERSION,
      })),
      undefined,
      Date.now(),
      seed,
      format,
    );
    let steps = 0,
      slowest = 0;
    while (g.phase !== "MATCH_RESULT") {
      assert(steps++ < 20000, `seed ${seed} stalled`);
      if (g.phase === "HAND_RESULT") {
        advanceResult(g);
        continue;
      }
      const s = g.decisions.findIndex((d) => d && !d.choice) as Seat;
      const view = project(g, s),
        started = performance.now();
      const choice = chooseBot(view);
      slowest = Math.max(slowest, performance.now() - started);
      assert(view.self.decision!.options.some((o) => o.optionId === choice));
      apply(g, s, choice);
      assertInvariants(g);
    }
    assert.equal(
      g.players.reduce((n, p) => n + p.points, 0),
      100000,
    );
    // The worker pool gives up on a decision after 3 s.
    assert(slowest < 1000, `slowest decision ${Math.round(slowest)}ms`);
  }
});
