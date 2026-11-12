import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceResult,
  apply,
  createGame,
  project,
  quad,
} from "../backend/src/engine.ts";
import { chooseBot } from "../backend/src/bot.ts";
import {
  MAX_STEP_EVENTS,
  frameEvents,
  matchEvents,
  type MatchEvent,
} from "../frontend/src/match-events.ts";
import {
  BOT_POLICY_VERSION,
  PROTOCOL,
  type Frame,
  type MatchView,
  type Seat,
} from "../shared/types.ts";

function botGame(seed: number) {
  return createGame(
    "events",
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
    "EAST_ONLY",
  );
}
const clone = (v: MatchView) => structuredClone(v);
const count = (events: MatchEvent[], f: (e: MatchEvent) => boolean) =>
  events.filter(f).length;

test("every step of real bot matches reads as continuous events that add up to the hand", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const g = botGame(seed);
    let before = project(g, 0);
    let hand: MatchEvent[] = [];
    let last = before;
    const check = (end: MatchView) => {
      const seats = end.hand.seats,
        melds = seats.flatMap((s) => s.melds);
      const ofCall = (c: string) =>
        count(hand, (e) => e.type === "call" && e.call === c);
      assert.equal(
        count(hand, (e) => e.type === "discard"),
        seats.reduce((n, s) => n + s.discards.length, 0),
        `seed ${seed}: discards`,
      );
      assert.equal(ofCall("CHI"), melds.filter((m) => m.type === "CHI").length);
      // An added kan was a pon first.
      assert.equal(
        ofCall("PON"),
        melds.filter((m) => m.type === "PON" || m.type === "KAKAN").length,
      );
      assert.equal(
        ofCall("DAIMINKAN"),
        melds.filter((m) => m.type === "DAIMINKAN").length,
      );
      // A proposed kan can be robbed, so it may not become a meld.
      assert.ok(
        ofCall("ANKAN") + ofCall("KAKAN") >=
          melds.filter((m) => m.type === "ANKAN" || m.type === "KAKAN").length,
      );
      assert.equal(
        count(hand, (e) => e.type === "dora"),
        end.hand.doraIndicators.length - 1,
      );
      assert.equal(
        count(hand, (e) => e.type === "riichi-stick"),
        seats.filter((s) => s.riichi === "ESTABLISHED").length,
      );
      const result = end.lastHandResult!;
      assert.equal(
        count(hand, (e) => e.type === "win"),
        result.wins.length,
      );
      assert.equal(
        count(hand, (e) => e.type === "draw"),
        !result.wins.length || result.reason === "NAGASHI_MANGAN" ? 1 : 0,
      );
    };
    let steps = 0;
    while (g.phase !== "MATCH_RESULT") {
      if (g.phase === "HAND_RESULT") {
        check(last);
        hand = [];
        advanceResult(g);
      } else {
        const s = g.decisions.findIndex((d) => d && !d.choice) as Seat;
        apply(g, s, chooseBot(project(g, s)));
      }
      const after = project(g, 0);
      const events = matchEvents(before, after);
      assert.ok(events, `seed ${seed} step ${steps}: continuous`);
      hand.push(...events);
      before = last = after;
      steps++;
    }
  }
});

test("a new hand gives no events and a new match is a jump", () => {
  const g = botGame(1);
  const view = project(g, 0);
  const next = clone(view);
  next.hand.handId = "another";
  assert.deepEqual(matchEvents(view, next), []);
  next.matchId = "another";
  assert.equal(matchEvents(view, next), null);
});

test("rewritten history is a jump, not a replay", () => {
  const view = project(botGame(2), 0);
  const before = clone(view),
    after = clone(view);
  before.hand.seats[1].discards = [
    {
      discardId: "a",
      tile: 4,
      tsumogiri: false,
      riichiDeclaration: false,
      claimedByMeldId: null,
    },
  ];
  after.hand.seats[1].discards = [
    { ...before.hand.seats[1].discards[0], discardId: "b" },
  ];
  assert.equal(matchEvents(before, after), null);
});

test("too many changes at once are a jump", () => {
  const before = project(botGame(3), 0);
  const after = clone(before);
  for (let i = 0; i <= MAX_STEP_EVENTS; i++)
    after.hand.seats[i % 4].discards.push({
      discardId: `d${i}`,
      tile: i * 4,
      tsumogiri: false,
      riichiDeclaration: false,
      claimedByMeldId: null,
    });
  assert.equal(matchEvents(before, after), null);
});

test("only the very next frame of a stream is played; a sync or a gap is shown", () => {
  const view = project(botGame(5), 0);
  const discarded = clone(view);
  discarded.hand.seats[1].discards.push({
    discardId: "x",
    tile: 8,
    tsumogiri: true,
    riichiDeclaration: false,
    claimedByMeldId: null,
  });
  const frame = (
    state: MatchView,
    viewSeq: number,
    more: Partial<Frame> = {},
  ) =>
    ({
      protocolVersion: PROTOCOL,
      serverTime: 0,
      matchId: state.matchId,
      serverEpoch: 1,
      streamId: "s1",
      viewSeq,
      syncId: null,
      state,
      ...more,
    }) as Frame;
  const before = frame(view, 7);
  assert.deepEqual(
    frameEvents(before, frame(discarded, 8))?.map((e) => e.type),
    ["discard"],
  );
  // Frames missed while disconnected, then the attach answer.
  assert.equal(frameEvents(before, frame(discarded, 9)), null);
  assert.equal(frameEvents(before, frame(discarded, 8, { syncId: "q" })), null);
  // A new stream (the server restarted) starts afresh.
  assert.equal(
    frameEvents(before, frame(discarded, 8, { streamId: "s2" })),
    null,
  );
});

test("a riichi reads as declaration, discard, then the stick", () => {
  const start = project(botGame(4), 0);
  const declared = clone(start);
  declared.hand.seats[2].riichi = "DECLARED";
  declared.hand.seats[2].discards.push({
    discardId: "r",
    tile: 8,
    tsumogiri: false,
    riichiDeclaration: true,
    claimedByMeldId: null,
  });
  assert.deepEqual(
    matchEvents(start, declared)!.map((e) => e.type),
    ["riichi", "discard"],
  );
  const established = clone(declared);
  established.hand.seats[2].riichi = "ESTABLISHED";
  assert.deepEqual(matchEvents(declared, established), [
    { type: "riichi-stick", seat: 2 },
  ]);
});

test("a kan is announced once, when it is proposed", () => {
  const start = project(botGame(5), 0);
  const proposed = clone(start);
  proposed.hand.pendingKan = {
    seat: 3,
    type: "ANKAN",
    tiles: [0, 1, 2, 3],
    baseMeldId: null,
    robbableTile: 0,
  };
  assert.deepEqual(matchEvents(start, proposed), [
    { type: "call", seat: 3, call: "ANKAN", from: null },
  ]);
  const done = clone(proposed);
  done.hand.pendingKan = null;
  done.hand.seats[3].melds.push({
    meldId: "k",
    type: "ANKAN",
    tiles: [0, 1, 2, 3],
    sourceSeat: null,
    sourceDiscardId: null,
    calledTile: null,
    addedTile: null,
  });
  done.hand.doraIndicators.push(40);
  assert.deepEqual(matchEvents(proposed, done), [{ type: "dora", tile: 40 }]);
  // Missing the proposal frame still announces the kan when it lands.
  assert.deepEqual(
    matchEvents(start, done)!.map((e) => e.type),
    ["call", "dora"],
  );
});
