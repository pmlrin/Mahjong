import test from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  quad,
  project,
  assertInvariants,
  selfOptions,
  responseOptions,
  winFor,
  furiten,
  apply,
  resolve,
  settle,
  ending,
  paymentLedger,
  indicators,
  type GameState,
} from "../backend/src/engine.ts";
import {
  score,
  waits,
  strictRiichiKan,
  type ScoreContext,
} from "../backend/src/rules.ts";
import { kind, type Seat, type Win, type Meld } from "../shared/types.ts";
export function tiles(text: string): number[] {
  const used = new Map<number, number>(),
    out: number[] = [];
  for (const [, s, ns] of text.matchAll(/([mpsz])([0-9]+)/g))
    for (const ch of ns) {
      const n = Number(ch) || 5,
        k = s === "z" ? 26 + n : ["m", "p", "s"].indexOf(s) * 9 + n - 1,
        c = used.get(k) ?? 0;
      if (c >= 4) throw Error("5th tile");
      out.push(k * 4 + c);
      used.set(k, c + 1);
    }
  return out;
}
function context(
  text: string,
  extra: Partial<ScoreContext> = {},
): ScoreContext {
  const a = tiles(text);
  return {
    seat: 1,
    dealer: 0,
    round: 0,
    tiles: a.slice(0, -1),
    drawn: null,
    melds: [],
    winningTile: a.at(-1)!,
    source: 0,
    riichi: 0,
    ippatsu: false,
    haitei: false,
    rinshan: false,
    chankan: false,
    first: false,
    indicators: [132],
    ura: [],
    ...extra,
  };
}
function game() {
  return createGame(
    "test",
    quad((s) => ({
      memberId: String(s),
      userId: String(s),
      displayName: "player" + s,
      participantKind: "HUMAN",
      ready: true,
      connected: true,
      botLevel: null,
    })),
  );
}
function setHand(g: GameState, s: Seat, text: string, draw = false) {
  const ts = tiles(text),
    p = g.players[s];
  p.tiles = draw ? ts.slice(0, -1) : ts;
  p.drawn = draw ? ts.at(-1)! : null;
  p.drawSource = draw ? "LIVE_WALL" : null;
  p.discards = [];
  p.melds = [];
  return p;
}
function noFirst(g: GameState) {
  g.interrupted = true;
  for (const p of g.players) p.draws = 3;
}
function sampleWin(extra: Partial<Win> = {}): Win {
  return {
    winnerSeat: 1,
    sourceSeat: 0,
    winningTile: 0,
    method: "RON",
    yaku: [],
    fu: 30,
    han: 1,
    yakumanMultiplier: 0,
    limit: "NONE",
    dora: { omote: 0, ura: 0, aka: 0 },
    basePoints: 240,
    fuDetails: [],
    decomposition: null,
    pao: [],
    ...extra,
  };
}
test("R01: 136 unique physical tiles, three red fives, initial 14/13 hands and 69 live tiles", () => {
  const g = game();
  assert.equal(new Set(g.shuffled).size, 136);
  assert.deepEqual(
    g.players.map((p) => p.tiles.length + (p.drawn !== null ? 1 : 0)),
    [14, 13, 13, 13],
  );
  assert.equal(g.wall.length, 69);
  assertInvariants(g);
});
test("R02: dora cannot make a no-yaku hand legal", () => {
  assert.equal(
    score(context("m123456p789s123z22", { indicators: [108] })),
    null,
  );
});
test("R03: open tanyao is a yaku", () => {
  const m: Meld = {
    meldId: "a",
    type: "CHI",
    tiles: tiles("m234"),
    sourceSeat: 0,
    sourceDiscardId: "d",
    calledTile: 4,
    addedTile: null,
  };
  const w = score(context("m678p234s456p55", { melds: [m] }));
  assert(w?.yaku.some((y) => y.yakuId === "TANYAO"));
});
test("R04: double east triplet scores two separate winds; pair contributes four fu", () => {
  const w = score(
    context("m123p123s789z11122", { seat: 0, dealer: 0, source: 1, riichi: 1 }),
  );
  assert(w);
  assert.equal(w.yaku.filter((y) => y.yakuId.startsWith("YAKUHAI_")).length, 2);
  const p = score(
    context("m123p123s789m456z11", {
      seat: 0,
      dealer: 0,
      source: 1,
      riichi: 1,
    }),
  );
  assert(p);
  assert(p.fuDetails.some((x) => x.code === "PAIR" && x.value === 4));
});
test("R05: pinfu tsumo fixed 20 fu; ron fixed 30", () => {
  const c = context("m234567p123s234p55", { winningTile: 12 });
  c.tiles = tiles("m23567p123s234p55");
  const ron = score(c);
  assert(ron);
  assert(ron.yaku.some((y) => y.yakuId === "PINFU"));
  assert.equal(ron.fu, 30);
  const tsumo = score({ ...c, source: null, drawn: 12 });
  assert.equal(tsumo?.fu, 20);
});
test("R06: seven pairs is 25 fu and 2 han, child ron 1600", () => {
  const w = score(context("m1144p2266s3377z22"));
  assert(w);
  assert.equal(w.fu, 25);
  assert.equal(w.han, 2);
  assert.equal(paymentLedger(w, 0, 0)[0].amount, 1600);
});
test("R07: 4 han 30 fu and 3 han 60 fu both pay 7700, no kiriage", () => {
  for (const [han, fu] of [
    [4, 30],
    [3, 60],
  ])
    assert.equal(
      paymentLedger(sampleWin({ basePoints: fu * 2 ** (han + 2) }), 0, 0)[0]
        .amount,
      7700,
    );
});
test("R08: counted yakuman is capped even with many duplicated indicators", () => {
  const w = score(
    context("m11223344556677", {
      riichi: 1,
      indicators: Array(5).fill(0),
      ura: Array(5).fill(0),
    }),
  );
  assert(w);
  assert(w.han! >= 26);
  assert.equal(w.yakumanMultiplier, 0);
  assert.equal(w.basePoints, 8000);
});
test("R09: big three dragons + all honors stacks two natural yakuman", () => {
  const w = score(context("z11155566622777"));
  assert(w);
  assert.equal(w.yakumanMultiplier, 2);
  assert.equal(w.basePoints, 16000);
});
test("R10: red, omote and ura count separately; ura requires established riichi", () => {
  const c = context("m234p234s234m678p55", {
    riichi: 1,
    indicators: [48],
    ura: [48],
  });
  const w = score(c);
  assert(w);
  assert.equal(w.dora.omote, 2);
  assert.equal(w.dora.ura, 2);
  assert(w.dora.aka > 0);
  const without = score({ ...c, riichi: 0 });
  assert.equal(without?.dora.ura, 0);
});
test("R11/R12: any structural wait in own discard history causes furiten, even if claimed", () => {
  const g = game();
  setHand(g, 1, "m12456p123s234p55");
  g.players[1].discards.push({
    discardId: "x",
    tile: 8,
    tsumogiri: false,
    riichiDeclaration: false,
    claimedByMeldId: "called",
  });
  assert.equal(furiten(g, 1).discard, true);
  assert.equal(winFor(g, 1, 8, 0), null);
});
test("R13/R14: temporary and riichi-pass furiten block ron but not tsumo", () => {
  const g = game();
  noFirst(g);
  const p = setHand(g, 1, "m12456p123s234p55");
  p.temporary = true;
  p.afterRiichiPass = true;
  p.riichi = "ESTABLISHED";
  p.drawn = 8;
  assert.equal(winFor(g, 1, 8, 0), null);
  assert(winFor(g, 1, 8, null));
});
test("R15/R16/R48: riichi requires >=1000 points and >=4 live tiles", () => {
  const g = game();
  noFirst(g);
  const p = setHand(g, 0, "m12456p123s234p55m9", true);
  p.points = 900;
  assert(!selfOptions(g, 0).some((o) => o.type === "RIICHI_DISCARD"));
  p.points = 1000;
  g.wall = g.wall.slice(0, 3);
  assert(!selfOptions(g, 0).some((o) => o.type === "RIICHI_DISCARD"));
  g.wall.push(132);
  assert(selfOptions(g, 0).some((o) => o.type === "RIICHI_DISCARD"));
});
test("R19: riichi locks discard to the drawn physical copy", () => {
  const g = game(),
    p = g.players[0];
  p.riichi = "ESTABLISHED";
  p.tiles = tiles("m1112345678999");
  p.drawn = 16;
  const o = selfOptions(g, 0).filter((o) => o.type === "DISCARD");
  assert.equal(o.length, 1);
  assert.equal(o[0].tile, 16);
});
test("R20: riichi kan rejects non-fourth-drawn copies", () => {
  assert.equal(strictRiichiKan(tiles("m1112345678999"), 16, 0, [], 0), false);
});
test("R21: pon has priority over chi regardless of arrival order", () => {
  const g = game();
  noFirst(g);
  const p = g.players[0];
  const tile = p.drawn!;
  p.tiles.push(tile);
  p.drawn = null;
  p.tiles = p.tiles.filter((t) => t !== tile);
  p.discards = [
    {
      discardId: "d",
      tile,
      tsumogiri: true,
      riichiDeclaration: false,
      claimedByMeldId: null,
    },
  ];
  g.phase = "CALL_RESPONSE";
  g.window = {
    windowId: "w",
    kind: "CALL_RESPONSE",
    actorSeat: 0,
    selfActionMode: null,
    sourceDiscardId: "d",
    deadlineAt: Date.now() + 8000,
  };
  const pon = {
    optionId: "p",
    type: "PON" as const,
    consumedTiles: g.players[2].tiles.slice(0, 2),
  };
  const chi = {
    optionId: "c",
    type: "CHI" as const,
    consumedTiles: g.players[1].tiles.slice(0, 2),
  };
  g.decisions = quad((s) =>
    s === 1 || s === 2
      ? {
          decisionId: String(s),
          windowId: "w",
          owner: "HUMAN",
          deadlineAt: 0,
          canSubmit: true,
          disabledReason: null,
          submittedRequestId: "q",
          options: [],
          choice: s === 1 ? chi : pon,
          blocked: false,
        }
      : null,
  );
  resolve(g);
  assert.equal(g.activeSeat, 2);
  assert.equal(g.players[2].melds[0].type, "PON");
});
test("R22/R36: double ron pays both full honba and one kyotaku after all transfers", () => {
  const g = game();
  g.honba = 2;
  g.kyotaku = 2000;
  g.players[0].points = 1000;
  g.players[3].points = 47000;
  const a = sampleWin({ basePoints: 2000 }),
    b = sampleWin({ winnerSeat: 2, basePoints: 2000 });
  settle(g, "RON", [a, b]);
  assert.equal(g.players[0].points, -16200);
  assert.equal(g.players[1].points, 35600);
  assert.equal(g.players[2].points, 33600);
  assert.equal(g.kyotaku, 0);
  assert.equal(
    g.lastResult!.transfers.filter((t) => t.reason === "KYOTAKU_AWARD").length,
    1,
  );
  assert.equal(g.status, "FINISHED");
});
test("R23: triple ron is an abort with no noten or win payment", () => {
  const g = game();
  settle(g, "ABORT_TRIPLE_RON", []);
  assert.deepEqual(
    g.players.map((p) => p.points),
    [25000, 25000, 25000, 25000],
  );
  assert.equal(g.lastResult!.wins.length, 0);
  assert.equal(g.lastResult!.nextHand!.honba, 1);
});
test("R28: no fifth kan is offered", () => {
  const g = game();
  g.kanCount = 4;
  assert(
    !selfOptions(g, 0).some((o) => o.type === "ANKAN" || o.type === "KAKAN"),
  );
});
test("R29: final discard only offers ron/pass", () => {
  const g = game();
  g.wall = [];
  setHand(g, 1, "m1112345678999");
  assert(
    responseOptions(g, 1, 0, 0).every(
      (o) => o.type === "RON" || o.type === "PASS",
    ),
  );
});
test("R30: exhaustive draw transfers 3000, rotates noten dealer and increments honba", () => {
  const g = game();
  setHand(g, 0, "m147p147s147z1234");
  setHand(g, 1, "m12456p123s234p55");
  setHand(g, 2, "m12456p123s234p55");
  setHand(g, 3, "m147p147s147z1234");
  g.players.forEach((p) => (p.drawn = null));
  settle(g, "EXHAUSTIVE_DRAW", []);
  assert.deepEqual(g.lastResult!.delta, [-1500, 1500, 1500, -1500]);
  assert.equal(g.lastResult!.nextHand!.dealerSeat, 1);
  assert.equal(g.lastResult!.nextHand!.honba, 1);
  assert(g.lastResult!.transfers.every((t) => t.amount % 100 === 0));
});
test("R31: a fifth physical tile is never a valid wait", () => {
  const a = tiles("m1111p123s123z111");
  assert(!waits(a).includes(0));
});
test("R32: waits depend on own tiles, not external seen counts", () => {
  assert(waits(tiles("m12456p123s234p55")).includes(2));
});
test("R33: successful call/kan suppresses kyuushu", () => {
  const g = game();
  setHand(g, 0, "m19p19s19z12345671", true);
  g.interrupted = true;
  assert(!selfOptions(g, 0).some((o) => o.type === "ABORT_KYUUSHU"));
  g.interrupted = false;
  assert(selfOptions(g, 0).some((o) => o.type === "ABORT_KYUUSHU"));
});
test("R34: multiple nagashi winners pay each other and no noten penalty", () => {
  const g = game();
  const a = sampleWin({
      sourceSeat: null,
      winnerSeat: 0,
      basePoints: 2000,
      method: "NAGASHI_MANGAN",
    }),
    b = sampleWin({
      sourceSeat: null,
      winnerSeat: 1,
      basePoints: 2000,
      method: "NAGASHI_MANGAN",
    });
  settle(g, "NAGASHI_MANGAN", [a, b]);
  assert.deepEqual(g.lastResult!.delta, [8000, 4000, -6000, -6000]);
  assert(!g.lastResult!.transfers.some((t) => t.reason === "NOTEN"));
});
test("R35: pao applies only to the responsible yakuman, honba from discarder", () => {
  const w = sampleWin({
    sourceSeat: 0,
    basePoints: 16000,
    yakumanMultiplier: 2,
    pao: [{ yakumanId: "DAISANGEN", responsibleSeat: 2 }],
    yaku: [
      { yakuId: "DAISANGEN", name: "大三元", han: 0, yakumanMultiplier: 1 },
      { yakuId: "TSUUIISOU", name: "字一色", han: 0, yakumanMultiplier: 1 },
    ],
  });
  const ledger = paymentLedger(w, 0, 1);
  assert.equal(
    ledger.filter((t) => t.from === 2).reduce((n, t) => n + t.amount, 0),
    16000,
  );
  assert.equal(
    ledger.filter((t) => t.from === 0).reduce((n, t) => n + t.amount, 0),
    48300,
  );
});
test("R37: exactly zero points is not bankruptcy", () => {
  const g = game();
  g.players[0].points = 0;
  g.players[1].points = 50000;
  assert.equal(ending(g, "EXHAUSTIVE_DRAW", [], []).end, null);
  g.players[0].points = -1;
  assert.equal(ending(g, "EXHAUSTIVE_DRAW", [], []).end, "BANKRUPTCY");
});
test("R38/R39: final dealer tenpai-yame requires rank one and 30000", () => {
  const g = game();
  g.roundNumber = 4;
  g.players[0].points = 30000;
  assert.equal(ending(g, "EXHAUSTIVE_DRAW", [], [0]).end, "DEALER_TENPAI_YAME");
  g.players[0].points = 29900;
  assert.equal(ending(g, "EXHAUSTIVE_DRAW", [], [0]).end, null);
});
test("R40: no target reached at last planned rotation enters extension", () => {
  const g = game();
  g.roundNumber = 4;
  assert.equal(ending(g, "RON", [1], []).end, null);
  settle(g, "RON", [sampleWin({ basePoints: 240 })]);
  assert.equal(g.lastResult!.nextHand!.roundWind, "SOUTH");
  assert.equal(g.lastResult!.nextHand!.roundNumber, 1);
});
test("R41/R42: extension target overrides repeats, fourth extension abort hits cap", () => {
  const g = game();
  g.round = 1;
  g.players[1].points = 30000;
  assert.equal(
    ending(g, "ABORT_KYUUSHU", [], []).end,
    "EXTENSION_TARGET_REACHED",
  );
  g.players[1].points = 25000;
  g.roundNumber = 4;
  assert.equal(ending(g, "ABORT_KYUUSHU", [], []).end, "EXTENSION_HARD_LIMIT");
});
test("R43: final kyotaku uses initial seat tie-break and is paid once", () => {
  const g = game();
  g.round = 1;
  g.roundNumber = 4;
  g.kyotaku = 1000;
  g.players[3].points = 24000;
  settle(g, "ABORT_KYUUSHU", []);
  assert.equal(g.players[0].points, 26000);
  assert.equal(g.kyotaku, 0);
  assert.equal(
    g.lastResult!.transfers.filter((t) => t.reason === "FINAL_KYOTAKU").length,
    1,
  );
  assert.throws(() => settle(g, "ABORT_KYUUSHU", []));
});
test("R45/P34: payment ledger preserves 100000 points including kyotaku", () => {
  const g = game();
  settle(g, "RON", [sampleWin()]);
  assert.equal(g.players.reduce((n, p) => n + p.points, 0) + g.kyotaku, 100000);
  assert.equal(
    g.lastResult!.delta.reduce((a, b) => a + b, 0) +
      g.lastResult!.kyotakuAfter -
      g.lastResult!.kyotakuBefore,
    0,
  );
});
test("R46/P02: seat projection whitelists public data and only own hand", () => {
  const g = game(),
    v = project(g, 1);
  assert.deepEqual(
    v.self.concealedTiles,
    g.players[1].tiles.slice().sort((a, b) => a - b),
  );
  assert(!("wall" in v));
  assert(!("dead" in v));
  assert(!("decisions" in v));
  for (const p of v.players) assert(!("tiles" in p));
  for (const p of v.hand.seats) assert(!("concealedTiles" in p));
  assert.equal(v.hand.doraIndicators.length, 1);
});
test("P04: different red/normal pon consumption yields separate options", () => {
  const g = game();
  setHand(g, 1, "m555p123s123z1122");
  const opts = responseOptions(g, 1, 19, 0).filter((o) => o.type === "PON");
  assert.equal(opts.length, 3);
  assert.equal(new Set(opts.map((o) => o.optionId)).size, 3);
});
test("P09: a decision cannot be submitted twice", () => {
  const g = game(),
    d = g.decisions[0]!,
    o = d.options.find((o) => o.type === "DISCARD")!;
  apply(g, 0, o.optionId, "a");
  assert.throws(() => apply(g, 0, o.optionId, "b"));
});
test("Fu details sum to exact fu and decomposition consumes each physical tile once", () => {
  for (const shape of [
    "m1144p2255s3366z22",
    "m123p123s789z11122",
    "m123p123s789m456z11",
  ]) {
    const c = context(shape, { riichi: 1 }),
      w = score(c)!;
    assert(w);
    assert.equal(
      w.fuDetails.reduce((n, r) => n + r.value, 0),
      w.fu,
    );
    const flat = w.decomposition!.groups.flat();
    assert.equal(new Set(flat).size, flat.length);
    assert.deepEqual(
      flat.slice().sort((a, b) => a - b),
      [...c.tiles, c.winningTile].sort((a, b) => a - b),
    );
  }
});

function responseFixture(g: GameState, from: Seat, tile: number, kan = false) {
  g.phase = kan ? "KAN_RESPONSE" : "CALL_RESPONSE";
  g.window = {
    windowId: "fixture",
    kind: kan ? "KAN_RESPONSE" : "CALL_RESPONSE",
    actorSeat: from,
    selfActionMode: null,
    sourceDiscardId: kan ? null : "fixture-discard",
    deadlineAt: Date.now() + 8000,
  };
  if (!kan)
    g.players[from].discards.push({
      discardId: "fixture-discard",
      tile,
      tsumogiri: false,
      riichiDeclaration: g.players[from].riichi === "DECLARED",
      claimedByMeldId: null,
    });
  g.decisions = quad(() => null);
}
function recorded(
  g: GameState,
  s: Seat,
  type: "RON" | "PON" | "PASS",
  consumedTiles?: number[],
) {
  const option = { optionId: "fixture-option-" + s, type, consumedTiles };
  g.decisions[s] = {
    decisionId: "fixture-decision-" + s,
    windowId: g.window!.windowId,
    owner: "HUMAN",
    deadlineAt: g.window!.deadlineAt,
    canSubmit: true,
    disabledReason: null,
    submittedRequestId: "fixture-request",
    options: [option],
    choice: option,
    blocked: false,
  };
}
test("R17: ron on riichi declaration does not collect the declaration deposit", () => {
  const g = game();
  noFirst(g);
  g.players[0].drawn = null;
  g.players[0].riichi = "DECLARED";
  const p = setHand(g, 1, "m12456p123s234p55");
  p.riichi = "ESTABLISHED";
  responseFixture(g, 0, 8);
  recorded(g, 1, "RON");
  resolve(g);
  assert.equal(g.lastResult!.reason, "RON");
  assert.equal(g.lastResult!.kyotakuBefore, 0);
  assert.equal(g.lastResult!.kyotakuAfter, 0);
  assert(!g.lastResult!.transfers.some((t) => t.reason === "RIICHI_DEPOSIT"));
  assert.equal(g.players[0].points, 25000 + g.lastResult!.delta[0]);
});
test("R18: pon on declaration establishes riichi, collects deposit and cancels ippatsu", () => {
  const g = game();
  noFirst(g);
  g.players[0].drawn = null;
  g.players[0].riichi = "DECLARED";
  g.players[1].tiles = [9, 10, ...tiles("p123s123z11223")];
  responseFixture(g, 0, 8);
  recorded(g, 1, "PON", [9, 10]);
  resolve(g);
  assert.equal(g.players[0].riichi, "ESTABLISHED");
  assert.equal(g.players[0].points, 24000);
  assert.equal(g.kyotaku, 1000);
  assert.equal(g.players[0].ippatsu, false);
  assert.equal(g.activeSeat, 1);
});
test("R24: fourth riichi deposit belongs in the abort settlement ledger exactly once", () => {
  const g = game();
  g.players[0].drawn = null;
  for (const s of [1, 2, 3] as Seat[]) {
    g.players[s].riichi = "ESTABLISHED";
    g.players[s].points = 24000;
  }
  g.kyotaku = 3000;
  g.players[0].riichi = "DECLARED";
  responseFixture(g, 0, 8);
  resolve(g);
  const r = g.lastResult!;
  assert.equal(r.reason, "ABORT_FOUR_RIICHI");
  assert.equal(r.pointsBefore[0], 25000);
  assert.equal(r.kyotakuBefore, 3000);
  assert.equal(r.pointsAfter[0], 24000);
  assert.equal(r.kyotakuAfter, 4000);
  assert.equal(
    r.transfers.filter((t) => t.reason === "RIICHI_DEPOSIT").length,
    1,
  );
  assert.equal(
    r.delta.reduce((a, b) => a + b, 0) + r.kyotakuAfter - r.kyotakuBefore,
    0,
  );
});
test("R25: robbed fourth added kan preserves pon, indicators and rinshan count", () => {
  const g = game();
  noFirst(g);
  g.kanCount = 3;
  g.players[0].melds = [
    {
      meldId: "old-pon",
      type: "PON",
      tiles: [9, 10, 11],
      calledTile: 11,
      addedTile: null,
      sourceSeat: 3,
      sourceDiscardId: "old",
    },
  ];
  g.pendingKan = {
    seat: 0,
    type: "KAKAN",
    tiles: [9, 10, 11, 8],
    baseMeldId: "old-pon",
    robbableTile: 8,
  };
  const p = setHand(g, 1, "m12456p123s234p55");
  p.riichi = "ESTABLISHED";
  responseFixture(g, 0, 8, true);
  recorded(g, 1, "RON");
  resolve(g);
  assert.equal(g.kanCount, 3);
  assert.equal(g.players[0].melds[0].type, "PON");
  assert.equal(indicators(g).length, 4);
  assert.equal(g.lastResult!.reason, "RON");
  assert(!g.events.some((e) => e.type === "KAN_COMMITTED"));
});
test("R26: rinshan tsumo remains available after a multi-player fourth kan", () => {
  const g = game();
  noFirst(g);
  g.fourKans = true;
  g.kanCount = 4;
  const p = setHand(g, 0, "m234567p123s234p55", true);
  p.drawSource = "RINSHAN";
  const os = selfOptions(g, 0);
  assert(os.some((o) => o.type === "TSUMO"));
  g.decisions[0]!.options = os;
  apply(g, 0, os.find((o) => o.type === "TSUMO")!.optionId);
  assert.equal(g.lastResult!.reason, "TSUMO");
});
test("R27: unclaimed discard after multi-player fourth kan aborts before any calls", () => {
  const g = game();
  g.players[0].drawn = null;
  g.fourKans = true;
  g.kanCount = 4;
  responseFixture(g, 0, 8);
  resolve(g);
  assert.equal(g.lastResult!.reason, "ABORT_FOUR_KANS");
  assert(!g.events.some((e) => e.type === "CALL_RESOLVED"));
});

test("R20: equal waits still reject a riichi kan that removes an alternate 123/123/123 interpretation", () => {
  const before = tiles("m111222333p456z1");
  const remaining = before.filter((t) => kind(t) !== 0);
  const meld: Meld = {
    meldId: "candidate",
    type: "ANKAN",
    tiles: [0, 1, 2, 3],
    sourceSeat: null,
    sourceDiscardId: null,
    calledTile: null,
    addedTile: null,
  };
  assert.deepEqual(waits(before, [], 0), waits(remaining, [meld], 0));
  assert.equal(strictRiichiKan(before, 3, 0, [], 0), false);
  assert.equal(strictRiichiKan(tiles("m111p123s456789z1"), 3, 0, [], 0), true);
});
