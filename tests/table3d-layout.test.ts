import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { createGame, project, quad } from "../backend/src/engine.ts";
import {
  TILE,
  armCues,
  isJump,
  layoutTable,
  meldDisplay,
  type TilePlacement,
} from "../frontend/src/table3d/layout.ts";
import type { MatchView, Meld, Seat } from "../shared/types.ts";

function baseView(viewer: Seat = 0): MatchView {
  const game = createGame(
    "table3d",
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
  return project(game, viewer);
}

/** Late-hand stress: 20 discards each, four melds on two seats, five dora. */
function stressView(viewer: Seat = 0): MatchView {
  const view = baseView(viewer);
  let next = 0;
  const take = () => next++;
  view.hand.doraIndicators = Array.from({ length: 5 }, take);
  view.hand.rinshanRemaining = 0;
  view.hand.liveWallRemaining = 9;
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const h = view.hand.seats[seat];
    h.melds =
      seat > 1
        ? []
        : (["CHI", "PON", "ANKAN", "KAKAN"] as const).map((type, i): Meld => {
            const tiles = Array.from(
              { length: type === "ANKAN" || type === "KAKAN" ? 4 : 3 },
              take,
            );
            return {
              meldId: `m${seat}-${i}`,
              type,
              tiles,
              sourceSeat:
                type === "ANKAN" ? null : (((seat + 1 + i) % 4) as Seat),
              sourceDiscardId: null,
              calledTile: type === "ANKAN" ? null : tiles[1],
              addedTile: type === "KAKAN" ? tiles[3] : null,
            };
          });
    h.discards = Array.from({ length: 20 }, (_, i) => ({
      discardId: `${seat}-${i}`,
      tile: take(),
      tsumogiri: i % 3 === 0,
      riichiDeclaration: i === 5 || i === 12,
      claimedByMeldId: i === 2 ? "x" : null,
    }));
    h.concealedCount = seat > 1 ? 13 : 1;
  }
  view.hand.lastDiscard = { ...view.hand.seats[3].discards.at(-1)!, seat: 3 };
  view.self.concealedTiles = viewer > 1 ? [] : [take()];
  view.self.drawnTile = take();
  return view;
}

function box(p: TilePlacement) {
  const q = new Quaternion(...p.quaternion);
  const half = new Vector3(
    TILE.width / 2,
    TILE.thickness / 2,
    TILE.height / 2,
  ).multiplyScalar(p.scale ?? 1);
  const axes = [
    new Vector3(half.x, 0, 0),
    new Vector3(0, half.y, 0),
    new Vector3(0, 0, half.z),
  ].map((v) => v.applyQuaternion(q));
  const extent = [0, 1, 2].map((i) =>
    axes.reduce((s, v) => s + Math.abs(v.getComponent(i)), 0),
  );
  return p.position.map((c, i) => [c - extent[i], c + extent[i]]);
}
function overlaps(a: TilePlacement, b: TilePlacement) {
  const A = box(a),
    B = box(b),
    e = 0.015;
  return A.every(([lo, hi], i) => lo + e < B[i][1] && B[i][0] + e < hi);
}

test("hidden tiles carry no identity and are never face up", () => {
  for (const viewer of [0, 1, 2, 3] as Seat[]) {
    const placements = layoutTable(stressView(viewer));
    for (const p of placements) {
      if (p.tile === null) assert.equal(p.faceUp, false, p.key);
      if (p.group === "hand" || p.group === "wall")
        assert.equal(p.tile, null, p.key);
    }
  }
});

test("only public tile ids are placed, each once", () => {
  const view = stressView(0);
  const pub = new Set<number>(view.hand.doraIndicators);
  for (const h of view.hand.seats) {
    h.discards.forEach((d) => pub.add(d.tile));
    h.melds.forEach((m) => m.tiles.forEach((t) => pub.add(t)));
  }
  const placed = layoutTable(view).filter((p) => p.tile !== null);
  const ids = placed.map((p) => p.tile!);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(pub.has(id), `tile ${id} is not public`);
  const keys = layoutTable(view).map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("opponent hands are drawn from counts; own hand only on request", () => {
  const view = stressView(0);
  const hands = layoutTable(view).filter((p) => p.group === "hand");
  for (const seat of [1, 2, 3] as Seat[])
    assert.equal(
      hands.filter((p) => p.seat === seat).length,
      view.hand.seats[seat].concealedCount,
    );
  assert.equal(hands.filter((p) => p.seat === 0).length, 0);
  const own = layoutTable(view, { selfHand: true }).filter(
    (p) => p.group === "hand" && p.seat === 0,
  );
  assert.deepEqual(
    own.map((p) => p.tile),
    [...view.self.concealedTiles, view.self.drawnTile],
  );
});

test("wall counts follow live and rinshan counts with dora face up", () => {
  const view = baseView(0);
  view.hand.doraIndicators = [40];
  view.hand.rinshanRemaining = 3;
  const placements = layoutTable(view);
  assert.equal(
    placements.filter((p) => p.group === "wall").length,
    view.hand.liveWallRemaining,
  );
  const dead = placements.filter((p) => p.group === "dead");
  assert.equal(dead.length, 13);
  assert.deepEqual(
    dead.filter((p) => p.faceUp).map((p) => p.tile),
    [40],
  );
});

test("riichi and called tiles lie sideways in the right place", () => {
  const pon: Meld = {
    meldId: "p",
    type: "PON",
    tiles: [8, 9, 10],
    sourceSeat: 2,
    sourceDiscardId: null,
    calledTile: 10,
    addedTile: null,
  };
  // Seat 0 calling from seat 2 (toimen): the called tile is second.
  assert.deepEqual(
    meldDisplay(pon, 0).map((t) => [t.tile, t.sideways]),
    [
      [8, false],
      [10, true],
      [9, false],
    ],
  );
  const chi = { ...pon, type: "CHI" as const, sourceSeat: 3 as Seat };
  assert.equal(meldDisplay(chi, 0)[0].tile, 10);
  const kakan = {
    ...pon,
    type: "KAKAN" as const,
    tiles: [8, 9, 10, 11],
    sourceSeat: 1 as Seat,
    addedTile: 11,
  };
  const shown = meldDisplay(kakan, 0);
  assert.deepEqual(
    shown.map((t) => t.tile),
    [8, 9, 10, 11],
  );
  assert.equal(shown[3].stacked, true);
  const ankan = meldDisplay(
    {
      ...pon,
      type: "ANKAN",
      tiles: [4, 5, 6, 7],
      sourceSeat: null,
      calledTile: null,
    },
    0,
  );
  assert.deepEqual(
    ankan.map((t) => t.back),
    [true, false, false, true],
  );
});

test("no two tiles intersect, early or late in a hand", () => {
  for (const view of [baseView(0), stressView(0), stressView(2)]) {
    view.hand.liveWallRemaining = Math.max(view.hand.liveWallRemaining, 60);
    const placements = layoutTable(view, { selfHand: true });
    assert.ok(overlaps(placements[0], placements[0]), "detector sanity");
    for (let i = 0; i < placements.length; i++)
      for (let j = i + 1; j < placements.length; j++)
        assert.ok(
          !overlaps(placements[i], placements[j]),
          `${placements[i].key} (${placements[i].group}) overlaps ${placements[j].key} (${placements[j].group})`,
        );
  }
});

test("a called discard lives only in the meld; a called riichi tile passes sideways on", () => {
  const view = baseView(0);
  const river = (tile: number, extra: object = {}) => ({
    discardId: `d${tile}`,
    tile,
    tsumogiri: false,
    riichiDeclaration: false,
    claimedByMeldId: null,
    ...extra,
  });
  view.hand.seats[1].discards = [
    river(100),
    river(101, { riichiDeclaration: true, claimedByMeldId: "pon" }),
    river(102),
  ];
  view.hand.seats[0].melds = [
    {
      meldId: "pon",
      type: "PON",
      tiles: [97, 98, 101],
      sourceSeat: 1,
      sourceDiscardId: "d101",
      calledTile: 101,
      addedTile: null,
    },
  ];
  const placements = layoutTable(view);
  const t101 = placements.filter((p) => p.tile === 101);
  assert.equal(t101.length, 1);
  assert.equal(t101[0].group, "meld");
  const rivers = placements.filter((p) => p.group === "river" && p.seat === 1);
  assert.deepEqual(
    rivers.map((p) => p.tile),
    [100, 102],
  );
  // Sideways tiles are rotated a quarter turn about y relative to their neighbour.
  const yaw = (p: TilePlacement) =>
    new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...p.quaternion));
  assert.ok(Math.abs(yaw(rivers[0]).dot(yaw(rivers[1]))) < 1e-6);
});

test("revealed hands lie face up only at that hand's result", () => {
  const view = baseView(0);
  const shown = view.hand.seats[2].concealedCount;
  const tiles = Array.from({ length: shown }, (_, i) => 120 + (i % 16));
  const uniqueTiles = [...new Set(tiles)].slice(0, Math.min(shown, 13));
  view.lastHandResult = {
    handId: view.hand.handId,
    wins: [],
    revealedUraIndicators: [],
    revealedHands: [
      {
        seat: 2,
        concealedTiles: uniqueTiles,
        drawnTile: null,
        winningTile: null,
      },
    ],
  } as unknown as MatchView["lastHandResult"];
  const during = layoutTable(view).filter(
    (p) => p.seat === 2 && p.group === "hand",
  );
  assert.ok(during.every((p) => p.tile === null && !p.faceUp));
  view.hand.phase = "HAND_RESULT";
  const after = layoutTable(view).filter(
    (p) => p.seat === 2 && p.group === "hand",
  );
  assert.deepEqual(
    after.map((p) => p.tile),
    uniqueTiles,
  );
  assert.ok(after.every((p) => p.faceUp));
  const all = layoutTable(view, { selfHand: true });
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      assert.ok(
        !overlaps(all[i], all[j]),
        `${all[i].key} overlaps ${all[j].key}`,
      );
  view.lastHandResult!.handId = "an-earlier-hand";
  assert.ok(
    layoutTable(view)
      .filter((p) => p.seat === 2 && p.group === "hand")
      .every((p) => p.tile === null),
  );
});

test("a win raises its tile and a riichi win turns over its ura dora", () => {
  const view = baseView(0);
  const used = new Set([
    ...view.self.concealedTiles,
    ...(view.self.drawnTile === null ? [] : [view.self.drawnTile]),
    ...view.hand.doraIndicators,
  ]);
  const free = Array.from({ length: 136 }, (_, i) => i).filter(
    (t) => !used.has(t),
  );
  const [won, ura] = [free[13], free[14]];
  view.lastHandResult = {
    handId: view.hand.handId,
    reason: "TSUMO",
    wins: [
      { winnerSeat: 2, sourceSeat: null, winningTile: won, method: "TSUMO" },
    ],
    revealedHands: [
      {
        seat: 2,
        concealedTiles: free.slice(0, 13),
        drawnTile: won,
        winningTile: won,
      },
    ],
    revealedUraIndicators: [ura],
  } as unknown as MatchView["lastHandResult"];
  const playing = layoutTable(view, { selfHand: true });
  assert.ok(!playing.some((p) => p.winning || p.tile === ura));
  view.hand.phase = "HAND_RESULT";
  const all = layoutTable(view, { selfHand: true });
  assert.equal(new Set(all.map((p) => p.key)).size, all.length);
  const winning = all.filter((p) => p.winning);
  assert.deepEqual(
    winning.map((p) => [p.tile, p.group, p.seat, p.faceUp]),
    [[won, "hand", 2, true]],
  );
  const shown = all.find((p) => p.tile === ura)!;
  assert.ok(shown.faceUp && shown.group === "dead");
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      assert.ok(
        !overlaps(all[i], all[j]),
        `${all[i].key} overlaps ${all[j].key}`,
      );
});

test("one action animates; a resync of several actions is placed at once", () => {
  const view = baseView(0);
  const keyed = (v: MatchView) =>
    new Map(layoutTable(v, { selfHand: true }).map((p) => [p.key, p]));
  const before = keyed(view);
  const discard = (tile: number, i: number) => ({
    discardId: `j${tile}`,
    tile,
    tsumogiri: false,
    riichiDeclaration: false,
    claimedByMeldId: null,
    i,
  });
  // The viewer discards a hand tile: it changes group, one move.
  const one = structuredClone(view);
  const played = one.self.concealedTiles.shift()!;
  one.hand.seats[0].discards = [discard(played, 0)];
  assert.equal(isJump(before, layoutTable(one, { selfHand: true })), false);
  // An opponent's pon: the called tile moves seat, two tiles appear in the meld.
  const call = structuredClone(one);
  call.hand.seats[0].discards[0].claimedByMeldId = "m";
  call.hand.seats[1].melds = [
    {
      meldId: "m",
      type: "PON",
      tiles: [played, 130, 131],
      sourceSeat: 0,
      sourceDiscardId: `j${played}`,
      calledTile: played,
      addedTile: null,
    },
  ];
  assert.equal(
    isJump(keyed(one), layoutTable(call, { selfHand: true })),
    false,
  );
  // Reconnecting after two go-rounds: eight new river tiles at once.
  const later = structuredClone(view);
  for (const seat of [1, 2, 3] as Seat[])
    later.hand.seats[seat].discards = [100, 104, 108].map((t, i) =>
      discard(t + seat, i),
    );
  assert.equal(isJump(before, layoutTable(later, { selfHand: true })), true);
});

test("arm cues: other players' discards, draws, calls and shown hands", () => {
  const view = baseView(0);
  const keyed = (v: MatchView) =>
    new Map(layoutTable(v, { selfHand: true }).map((p) => [p.key, p]));
  const cues = (a: MatchView, b: MatchView, revealing = false) =>
    armCues(keyed(a), layoutTable(b, { selfHand: true }), 0, revealing).map(
      (c) => [c.kind, c.seat],
    );
  const discard = (tile: number) => ({
    discardId: `a${tile}`,
    tile,
    tsumogiri: false,
    riichiDeclaration: false,
    claimedByMeldId: null,
  });
  // Seat 1 draws: one hidden tile more, one wall tile fewer.
  const drawn = structuredClone(view);
  drawn.hand.seats[1].concealedCount += 1;
  drawn.hand.liveWallRemaining -= 1;
  assert.deepEqual(cues(view, drawn), [["draw", 1]]);
  const draw = armCues(
    keyed(view),
    layoutTable(drawn, { selfHand: true }),
    0,
    false,
  )[0];
  assert.ok(draw.kind === "draw" && draw.wall.group === "wall");
  // ...and discards.
  const thrown = structuredClone(drawn);
  thrown.hand.seats[1].concealedCount -= 1;
  thrown.hand.seats[1].discards = [discard(120)];
  assert.deepEqual(cues(drawn, thrown), [["discard", 1]]);
  // The viewer's own discard is no cue.
  const own = structuredClone(view);
  const played = own.self.concealedTiles.shift()!;
  own.hand.seats[0].discards = [discard(played)];
  assert.deepEqual(cues(view, own), []);
  // Seat 2 pons the viewer's discard: the tile goes from river to meld.
  const pon = structuredClone(own);
  pon.hand.seats[0].discards[0].claimedByMeldId = "m";
  pon.hand.seats[2].concealedCount -= 2;
  pon.hand.seats[2].melds = [
    {
      meldId: "m",
      type: "PON",
      tiles: [played, 130, 131],
      sourceSeat: 0,
      sourceDiscardId: `a${played}`,
      calledTile: played,
      addedTile: null,
    },
  ];
  const call = armCues(
    keyed(own),
    layoutTable(pon, { selfHand: true }),
    0,
    false,
  ).find((c) => c.kind === "call");
  assert.ok(call?.kind === "call");
  assert.equal(call.seat, 2);
  assert.equal(call.tile.tile, played);
  assert.equal(call.river.seat, 0);
  // Seat 3's hand shown at the result: one row, in order along the hand.
  const used = new Set([
    ...view.self.concealedTiles,
    ...(view.self.drawnTile === null ? [] : [view.self.drawnTile]),
    ...view.hand.doraIndicators,
  ]);
  const free = Array.from({ length: 136 }, (_, i) => i).filter(
    (t) => !used.has(t),
  );
  const result = structuredClone(view);
  result.lastHandResult = {
    handId: view.hand.handId,
    wins: [],
    revealedUraIndicators: [],
    revealedHands: [
      {
        seat: 3,
        concealedTiles: free.slice(0, 13),
        drawnTile: null,
        winningTile: null,
      },
    ],
  } as unknown as MatchView["lastHandResult"];
  result.hand.phase = "HAND_RESULT";
  assert.deepEqual(cues(view, result, false), []);
  const shown = armCues(
    keyed(view),
    layoutTable(result, { selfHand: true }),
    0,
    true,
  );
  assert.deepEqual(
    shown.map((c) => [c.kind, c.seat]),
    [["reveal", 3]],
  );
  assert.ok(shown[0].kind === "reveal");
  assert.deepEqual(
    shown[0].row.map((p) => p.tile),
    free.slice(0, 13),
  );
});
