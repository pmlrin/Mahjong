import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOT_RATINGS,
  INITIAL_RATING,
  rateMatch,
  ratingTier,
  tierName,
  tierFloor,
  expected,
  type RatingSeat,
} from "../shared/rating.ts";
import { BOT_LEVEL_LABELS, BOT_LEVELS, type Quad } from "../shared/types.ts";
import { createGame, quad, type GameState } from "../backend/src/engine.ts";
import { attachRating, seatRating } from "../backend/src/rating.ts";
import { summarize } from "../backend/src/history.ts";
import { Store } from "../backend/src/store.ts";
import { Sql } from "../backend/src/sql.ts";

const table = (
  ratings: number[],
  points = [40000, 30000, 20000, 10000],
  fixed = [false, false, false, false],
): Quad<RatingSeat> =>
  ratings.map((rating, i) => ({
    rating,
    fixed: fixed[i],
    rank: i + 1,
    finalPoints: points[i],
  })) as Quad<RatingSeat>;

test("rating: placement order decides the sign and size", () => {
  const c = rateMatch(
    table([1500, 1500, 1500, 1500], [25000, 25000, 25000, 25000]),
  );
  assert.deepEqual(
    c.map((x) => x.delta),
    [30, 10, -10, -30],
  );
  // Equal ratings and equal points: the table is zero-sum.
  assert.equal(
    c.reduce((a, x) => a + x.delta, 0),
    0,
  );
});

test("rating: final points adjust the change, capped at ±10", () => {
  const even = rateMatch(
    table([1500, 1500, 1500, 1500], [25000, 25000, 25000, 25000]),
  );
  const spread = rateMatch(
    table([1500, 1500, 1500, 1500], [45000, 31000, 19000, 5000]),
  );
  assert.equal(spread[0].delta - even[0].delta, 10);
  assert.equal(spread[1].delta - even[1].delta, 3);
  assert.equal(spread[2].delta - even[2].delta, -3);
  assert.equal(spread[3].delta - even[3].delta, -10);
  const huge = rateMatch(
    table([1500, 1500, 1500, 1500], [80000, 20000, 10000, -10000]),
  );
  assert.equal(huge[0].delta - even[0].delta, 10);
  assert.equal(huge[3].delta - even[3].delta, -10);
});

test("rating: stronger opponents give more for a win and cost less for a loss", () => {
  const weakTable = rateMatch(
    table([1500, 1100, 1100, 1100], [25000, 25000, 25000, 25000]),
  );
  const strongTable = rateMatch(
    table([1500, 1900, 1900, 1900], [25000, 25000, 25000, 25000]),
  );
  assert.ok(strongTable[0].delta > weakTable[0].delta);
  assert.equal(strongTable[0].delta, 55);
  assert.equal(weakTable[0].delta, 5);
  // Last place against stronger players loses less.
  const lastWeak = rateMatch(
    table([1100, 1100, 1100, 1500], [25000, 25000, 25000, 25000]),
  );
  const lastStrong = rateMatch(
    table([1900, 1900, 1900, 1500], [25000, 25000, 25000, 25000]),
  );
  assert.ok(lastStrong[3].delta > lastWeak[3].delta);
  assert.equal(lastStrong[3].delta, -5);
  assert.equal(lastWeak[3].delta, -55);
  // Differences beyond 400 count as 400.
  assert.equal(expected(900, 2500), expected(900, 1300));
});

test("rating: 半庄战 weighs 1.5×, rating never goes below 0", () => {
  const east = rateMatch(table([1500, 1500, 1500, 1500]));
  const south = rateMatch(table([1500, 1500, 1500, 1500]), "HANCHAN");
  // 30 for first place + 7.5 for 40000 points.
  assert.equal(east[0].delta, 38);
  assert.equal(south[0].delta, Math.round(37.5 * 1.5));
  const floor = rateMatch(table([1500, 1500, 1500, 5]));
  assert.equal(floor[3].after, 0);
  assert.equal(floor[3].delta, -5);
});

test("rating: ten tails and their boundaries", () => {
  const cases: [number, number][] = [
    [0, 1],
    [999, 1],
    [1000, 2],
    [1199, 2],
    [1200, 3],
    [1399, 3],
    [1400, 4],
    [1600, 5],
    [1800, 6],
    [1999, 6],
    [2000, 7],
    [2200, 8],
    [2400, 9],
    [2599, 9],
    [2600, 10],
    [9999, 10],
  ];
  for (const [r, t] of cases) assert.equal(ratingTier(r), t, `rating ${r}`);
  assert.equal(tierName(INITIAL_RATING), "一尾");
  assert.equal(tierName(2600), "十尾");
  for (let t = 2; t <= 10; t++) assert.equal(ratingTier(tierFloor(t)), t);
});

test("rating: each 假想妖 level sits in the tail it is named after and never moves", () => {
  for (const level of BOT_LEVELS)
    assert.equal(tierName(BOT_RATINGS[level]), BOT_LEVEL_LABELS[level]);
  const c = rateMatch(
    table(
      [
        INITIAL_RATING,
        BOT_RATINGS.MASTER,
        BOT_RATINGS.ADVANCED,
        BOT_RATINGS.BASIC,
      ],
      undefined,
      [false, true, true, true],
    ),
  );
  assert.ok(c[0].delta > 0);
  for (const s of [1, 2, 3]) {
    assert.equal(c[s].fixed, true);
    assert.equal(c[s].delta, 0);
    assert.equal(c[s].after, c[s].before);
  }
});

function finishedGame(userIds: (string | null)[]): GameState {
  const g = createGame(
    "rating-room",
    quad((s) => ({
      memberId: String(s),
      userId: userIds[s],
      displayName: `座${s}`,
      participantKind: userIds[s] ? "HUMAN" : "BOT",
      ready: true,
      connected: true,
      botLevel: userIds[s] ? null : "STANDARD",
    })),
    undefined,
    Date.now(),
    7,
  );
  g.status = "FINISHED";
  g.finishedAt = Date.now();
  const finalPoints: Quad<number> = [42000, 28000, 20000, 10000];
  g.matchResult = {
    matchId: g.matchId,
    reason: "LAST_HAND",
    finalPoints,
    ranks: [1, 2, 3, 4],
    netPoints: quad((s) => finalPoints[s] - 25000),
    replayAvailable: true,
  };
  return g;
}

async function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "mj-rating-")),
    saved = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = join(dir, "rating.sqlite");
  const store = new Store();
  await store.open();
  await store.initV2();
  const reopen = async () => {
    process.env.SQLITE_PATH = join(dir, "rating.sqlite");
    const s = new Store();
    await s.open();
    await s.initV2();
    return s;
  };
  if (saved === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = saved;
  return { store, reopen };
}

test("rating: ABORTED and unfinished matches are never rated", () => {
  const g = finishedGame(["a", null, null, null]);
  g.status = "ABORTED";
  assert.equal(
    attachRating(g, () => INITIAL_RATING),
    null,
  );
  g.status = "RUNNING";
  assert.equal(
    attachRating(g, () => INITIAL_RATING),
    null,
  );
});

test("rating: a 托管 or disconnected human seat is rated with the human's own rating", () => {
  const g = finishedGame(["a", null, null, "b"]);
  g.players[3].desiredControl = "AI";
  g.players[3].connected = false;
  const s = attachRating(g, (id) => (id === "b" ? 1700 : INITIAL_RATING))!;
  assert.equal(
    seatRating(g.players[3], () => 1700),
    1700,
  );
  assert.equal(g.matchResult!.ratingChanges![3].before, 1700);
  assert.ok(g.matchResult!.ratingChanges![3].delta < 0);
  assert.deepEqual(
    s.entries.map((e) => e.userId),
    ["a", "b"],
  );
});

test("rating: settlement is atomic with the match and idempotent across saves and restarts", async () => {
  const { store, reopen } = await openStore();
  const g = finishedGame(["alice", null, null, "bob"]);
  const first = attachRating(g, () => INITIAL_RATING)!;
  const changes = structuredClone(g.matchResult!.ratingChanges!);
  // Recomputing after a rating moved must not change the stored numbers.
  const again = attachRating(g, () => 2000)!;
  assert.deepEqual(g.matchResult!.ratingChanges, changes);
  assert.deepEqual(again, first);
  const summary = summarize(g)!;
  assert.deepEqual(summary.members[0].rating, changes[0]);
  assert.equal(summary.members[1].rating!.fixed, true);
  const save = () =>
    store.commit([
      { kind: "rating", id: g.matchId, data: first },
      { kind: "history", id: g.matchId, data: summary },
      { kind: "match", id: g.matchId, data: g },
    ]);
  await save();
  await save();
  await store.commit([{ kind: "rating", id: g.matchId, data: again }]);
  let ratings = await store.ratings();
  assert.deepEqual(ratings.get("alice"), {
    rating: changes[0].after,
    matches: 1,
  });
  assert.deepEqual(ratings.get("bob"), {
    rating: changes[3].after,
    matches: 1,
  });
  assert.equal(ratings.size, 2);
  await store.close();

  const restarted = await reopen();
  await restarted.commit([{ kind: "rating", id: g.matchId, data: first }]);
  ratings = await restarted.ratings();
  assert.equal(ratings.get("alice")!.rating, changes[0].after);
  assert.equal(ratings.get("alice")!.matches, 1);
  const rows = await new Sql(null, restarted.sqlite).rows(
    "SELECT user_id,before_rating,after_rating,delta FROM rating_changes ORDER BY seat",
  );
  assert.deepEqual(
    rows.map((r) => [r.user_id, r.before_rating, r.after_rating, r.delta]),
    [
      ["alice", INITIAL_RATING, changes[0].after, changes[0].delta],
      ["bob", INITIAL_RATING, changes[3].after, changes[3].delta],
    ],
  );

  // A failing write in the same commit rolls the settlement back too.
  const g2 = finishedGame(["alice", null, null, null]);
  const s2 = attachRating(g2, (id) => ratings.get(id)!.rating)!;
  await assert.rejects(
    restarted.commit([
      { kind: "rating", id: g2.matchId, data: s2 },
      { kind: "history", id: g2.matchId, data: { broken: true } as never },
    ]),
  );
  assert.equal((await restarted.ratings()).get("alice")!.matches, 1);
  await restarted.commit([{ kind: "rating", id: g2.matchId, data: s2 }]);
  assert.equal(
    (await restarted.ratings()).get("alice")!.rating,
    changes[0].after + g2.matchResult!.ratingChanges![0].delta,
  );
  await restarted.close();
});
