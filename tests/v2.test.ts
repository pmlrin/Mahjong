import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createGame,
  quad,
  ending,
  settle,
  advanceResult,
  project,
  selfOptions,
  type GameState,
} from "../backend/src/engine.ts";
import { chooseBot, finalStage } from "../backend/src/bot.ts";
import {
  summarize,
  decodeCursor,
  publicSummary,
  replayMetadata,
} from "../backend/src/history.ts";
import {
  openRematch,
  expireOffline,
  removeMember,
  checkGeneration,
} from "../backend/src/lobby.ts";
import { normalizeRoom, backfill } from "../backend/src/migration.ts";
import { technicalAbort, recoverable } from "../backend/src/recovery.ts";
import { Store } from "../backend/src/store.ts";
import {
  BOT_POLICY_VERSION,
  APP_VERSION,
  type Room,
  type MatchFormat,
  type HistorySummary,
} from "../shared/types.ts";
function game(format: MatchFormat = "HANCHAN") {
  return createGame(
    "room",
    quad((s) => ({
      memberId: "member" + s,
      userId: "user" + s,
      displayName: "player" + s,
      participantKind: "HUMAN",
      ready: true,
      connected: true,
      botLevel: null,
    })),
    undefined,
    Date.now(),
    42,
    format,
  );
}
function points(g: GameState, p: number[]) {
  g.players.forEach((x, i) => (x.points = p[i]));
}
function finish(id: string, format: MatchFormat = "HANCHAN", at = Date.now()) {
  const g = game(format);
  g.matchId = id;
  g.status = "FINISHED";
  g.phase = "MATCH_RESULT";
  g.finishedAt = at;
  points(g, [35000, 25000, 23000, 17000]);
  g.matchResult = {
    matchId: id,
    reason: "SCHEDULE_COMPLETE",
    finalPoints: [35000, 25000, 23000, 17000],
    ranks: [1, 2, 3, 4],
    netPoints: [10000, 0, -2000, -8000],
    replayAvailable: true,
  };
  return g;
}
function room() {
  const g = game();
  return normalizeRoom({
    roomId: "room",
    inviteCode: "ABC123",
    hostUserId: "user0",
    status: "FINISHED",
    matchId: "first",
    config: {
      format: "HANCHAN",
      rulesetId: "riichi-4p-v1.0",
      timePresetId: "standard-v1",
    },
    slots: g.players,
    roomVersion: 1,
    presenceVersion: 1,
    roomViewSeq: 1,
  } as unknown as Room);
}
test("V01: Hanchan East4 rotates to South1, whose extension flag stays false", () => {
  const g = game();
  g.roundNumber = 4;
  points(g, [35000, 25000, 20000, 20000]);
  assert.equal(ending(g, "RON", [1], []).end, null);
  settle(g, "RON", [
    {
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
    },
  ]);
  assert.equal(g.lastResult!.nextHand!.roundWind, "SOUTH");
  assert.equal(g.lastResult!.nextHand!.roundNumber, 1);
  assert.equal(g.lastResult!.nextHand!.isExtension, false);
  advanceResult(g);
  assert.equal(project(g, 0).hand.isExtension, false);
  assert.equal(g.format, "HANCHAN");
});
test("V01: South4 yame, repeat, West extension, hard cap and bankruptcy priority", () => {
  const g = game();
  g.round = 1;
  g.roundNumber = 4;
  points(g, [35000, 25000, 20000, 20000]);
  assert.equal(ending(g, "TSUMO", [0], []).end, "DEALER_AGARI_YAME");
  assert.equal(ending(g, "EXHAUSTIVE_DRAW", [], [0]).end, "DEALER_TENPAI_YAME");
  points(g, [25000, 35000, 20000, 20000]);
  assert.deepEqual(ending(g, "TSUMO", [0], []), { end: null, repeat: true });
  assert.equal(ending(g, "RON", [1], []).end, "SCHEDULE_COMPLETE");
  points(g, [25000, 25000, 25000, 25000]);
  assert.equal(ending(g, "RON", [1], []).end, null);
  g.round = 2;
  assert.equal(project(g, 0).hand.isExtension, true);
  g.roundNumber = 1;
  points(g, [30000, 25000, 25000, 20000]);
  assert.equal(
    ending(g, "ABORT_FOUR_WINDS", [], []).end,
    "EXTENSION_TARGET_REACHED",
  );
  points(g, [25000, 25000, 25000, 25000]);
  g.roundNumber = 4;
  assert.equal(
    ending(g, "ABORT_FOUR_WINDS", [], []).end,
    "EXTENSION_HARD_LIMIT",
  );
  points(g, [-1000, 35000, 35000, 31000]);
  assert.equal(ending(g, "RON", [1], []).end, "BANKRUPTCY");
});
test("V05: rematch retains room and config, clears all human ready, advances generation exactly once", () => {
  const r = room();
  r.slots[2]!.connected = false;
  openRematch(r, 1000);
  assert.equal(r.inviteCode, "ABC123");
  assert.equal(r.matchId, null);
  assert.equal(r.lobbyGeneration, 2);
  assert.deepEqual(r.previousMatchIds, ["first"]);
  assert(r.slots.every((p) => !p?.ready));
  assert.equal(r.config.format, "HANCHAN");
  assert.equal(r.offlineSince.user2, 1000);
  assert.throws(() => openRematch(r));
  assert.throws(() => checkGeneration(r, 1));
  checkGeneration(r, 2);
});
test("V05: offline grace starts at rematch, reconnect cancels, new disconnection restarts, host transfers by join order", () => {
  const r = room();
  r.slots[0]!.connected = false;
  openRematch(r, 1000);
  assert.equal(expireOffline(r, 30999), false);
  r.slots[0]!.connected = true;
  delete r.offlineSince.user0;
  assert.equal(expireOffline(r, 99999), false);
  r.slots[0]!.connected = false;
  r.offlineSince.user0 = 100000;
  assert.equal(expireOffline(r, 129999), false);
  r.memberJoinOrder = ["member0", "member3", "member1", "member2"];
  assert.equal(expireOffline(r, 130000), true);
  assert.equal(r.hostUserId, "user3");
  const first = room();
  first.status = "WAITING";
  first.isRematchLobby = false;
  first.slots[0]!.connected = false;
  first.offlineSince.user0 = 1;
  assert.equal(expireOffline(first, 999999), false);
  for (const s of ["user1", "user2", "user3"]) removeMember(r, s);
  assert.equal(r.status, "CLOSED");
});
test("V05: three new games have independent IDs, initial points, windows and seat state", () => {
  const previous = finish("old");
  const snapshot = JSON.stringify(previous);
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const g = createGame(
      previous.roomId,
      previous.players,
      undefined,
      Date.now(),
      i + 1,
      previous.format,
    );
    ids.add(g.matchId);
    assert(
      g.players.every(
        (p) => p.points === 25000 && p.riichi === "NONE" && !p.temporary,
      ),
    );
    assert.equal(g.kyotaku, 0);
    assert.equal(g.honba, 0);
    assert.notEqual(g.window!.windowId, previous.window?.windowId);
  }
  assert.equal(ids.size, 3);
  assert.equal(JSON.stringify(previous), snapshot);
});
function hand(text: string) {
  const used = new Map<number, number>();
  return [...text.matchAll(/([mpsz])([0-9]+)/g)].flatMap(([, s, ns]) =>
    [...ns].map((n) => {
      const k =
        s === "z"
          ? 26 + Number(n)
          : ["m", "p", "s"].indexOf(s) * 9 + Number(n) - 1;
      const c = used.get(k) ?? 0;
      used.set(k, c + 1);
      return k * 4 + c;
    }),
  );
}
test("V06: deterministic BASIC riichi vs STANDARD lead protection; East4 is not Hanchan final stage", () => {
  const g = game();
  g.round = 1;
  g.roundNumber = 4;
  points(g, [35000, 25000, 20000, 20000]);
  const p = g.players[0];
  p.participantKind = "BOT";
  p.botLevel = "STANDARD";
  p.tiles = hand("m123456p123s78z11");
  p.drawn = 112;
  p.drawSource = "LIVE_WALL";
  g.decisions[0]!.options = selfOptions(g, 0);
  const view = project(g, 0);
  assert(finalStage(view));
  const standard = chooseBot(view);
  assert.equal(
    view.self.decision!.options.find((o) => o.optionId === standard)!.type,
    "DISCARD",
  );
  view.players[0].botLevel = "BASIC";
  const basic = chooseBot(view);
  assert.equal(
    view.self.decision!.options.find((o) => o.optionId === basic)!.type,
    "RIICHI_DISCARD",
  );
  view.format = "HANCHAN";
  view.hand.roundWind = "EAST";
  assert.equal(finalStage(view), false);
  view.hand.roundWind = "SOUTH";
  view.hand.roundNumber = 1;
  assert.equal(finalStage(view), false);
});
test("V09: legacy metadata stays explicit; unknown version and invalid scores are rejected", () => {
  const g = finish("legacy") as any;
  delete g.protocolVersion;
  delete g.format;
  delete g.mode;
  const before = JSON.stringify(g);
  const s = summarize(g)!;
  assert.equal(s.format, "EAST_ONLY");
  assert.equal(s.source, "LEGACY_V1");
  assert.equal(s.replayVersion, "1.0");
  assert.equal(JSON.stringify(g), before);
  assert.equal(replayMetadata({ replayVersion: "1.0" }).format, "EAST_ONLY");
  assert.throws(() => replayMetadata({ replayVersion: "9.0" }));
  g.protocolVersion = "9.0";
  assert.throws(() => summarize(g), /UNKNOWN_PROTOCOL/);
  g.protocolVersion = "1.0";
  g.matchResult.finalPoints[0]++;
  assert.throws(() => summarize(g), /INVALID_RESULT/);
});
test("Q04: corrupted tiles abort safely, preserve source, no false result, no running window", () => {
  const g = game();
  g.wall.push(g.wall[0]);
  const source = JSON.stringify(g);
  assert.throws(() => recoverable(g), /TILE_CONSERVATION/);
  const aborted = technicalAbort(g);
  assert.equal(JSON.stringify(g), source);
  assert.equal(aborted.status, "ABORTED");
  assert.equal(aborted.window, null);
  assert.equal(aborted.matchResult, null);
  assert.equal(summarize(aborted)!.members[0].rank, null);
  assert.equal(summarize(aborted)!.replayAvailable, false);
});
test("V03/V04/V09: indexed pagination, ties, filters, frozen membership, stats, repeatable migration and atomic rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mj-v2-"));
  const old = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = join(dir, "db.sqlite");
  const store = new Store();
  try {
    await store.open();
    await store.initV2();
    const at = Date.now();
    const source = finish("legacy") as any;
    delete source.protocolVersion;
    delete source.format;
    delete source.mode;
    const invalid = finish("invalid");
    invalid.matchResult!.finalPoints[0]++;
    await store.commit([
      { kind: "match", id: "legacy", data: source },
      { kind: "match", id: "invalid", data: invalid },
    ]);
    const rawBefore = JSON.stringify(await store.list("match"));
    assert.deepEqual(await backfill(store), { indexed: 1, issues: 1 });
    assert.equal((await backfill(store)).alreadyApplied, true);
    assert.equal(JSON.stringify(await store.list("match")), rawBefore);
    assert.equal((await store.summary("legacy", "user0"))!.source, "LEGACY_V1");
    store
      .sqlite!.prepare(
        "DELETE FROM documents WHERE kind='match' AND id='legacy'",
      )
      .run();
    assert.equal(
      (await store.summary("legacy", "user0"))!.replayAvailable,
      false,
    );
    const writes = [];
    for (let i = 0; i < 45; i++) {
      const g = finish(
        "game" + String(i).padStart(3, "0"),
        i % 2 ? "EAST_ONLY" : "HANCHAN",
        at,
      );
      g.mode = i % 3 ? "FRIENDS" : "AI_PRACTICE";
      writes.push({ kind: "history", id: g.matchId, data: summarize(g)! });
    }
    const abort = technicalAbort(game(), at);
    writes.push({
      kind: "history",
      id: abort.matchId,
      data: summarize(abort)!,
    });
    await store.commit(writes);
    let cursor: null | { time: number; id: string } = null;
    const seen = new Set<string>();
    let pages = 0;
    do {
      const p = await store.history("user0", { cursor });
      assert(p.items.length <= 20);
      for (const s of p.items) {
        assert(!seen.has(s.matchId));
        seen.add(s.matchId);
      }
      cursor = decodeCursor(p.nextCursor ?? undefined);
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.size, 47);
    const page = await store.history("user0", {
      format: "HANCHAN",
      mode: "AI_PRACTICE",
    });
    assert(
      page.items.every(
        (s) => s.format === "HANCHAN" && s.mode === "AI_PRACTICE",
      ),
    );
    assert.equal(await store.summary("game000", "new-room-guest"), null);
    const publicData = publicSummary(page.items[0], "user0");
    assert.equal(publicData.members.filter((m) => m.userId !== null).length, 1);
    const stats = await store.stats("user0", {
      from: at - 10000,
      to: at + 10000,
    });
    assert.equal(stats.count, 46);
    assert.equal(stats.firstPlaceRate, 1);
    assert.equal(stats.averageRank, 1);
    assert.equal(stats.averageNetPoints, 10000);
    const none = await store.stats("unknown", { from: 0, to: at });
    assert.equal(none.count, 0);
    assert.equal(none.firstPlaceRate, null);
    assert.equal(none.averageRank, null);
    assert(none.distribution.every((d) => d.rate === null));
    const manual = [
      { points: [35000, 25000, 23000, 17000], ranks: [1, 2, 3, 4] },
      { points: [25000, 35000, 23000, 17000], ranks: [2, 1, 3, 4] },
      { points: [17000, 35000, 25000, 23000], ranks: [4, 1, 2, 3] },
      { points: [20000, 35000, 23000, 22000], ranks: [4, 1, 2, 3] },
    ];
    const manualWrites = manual.map((x, i) => {
      const g = finish("manual" + i, "HANCHAN", at);
      g.players[0].userId = "manual-user";
      g.matchResult!.finalPoints = x.points as any;
      g.matchResult!.ranks = x.ranks as any;
      return { kind: "history", id: g.matchId, data: summarize(g)! };
    });
    await store.commit(manualWrites);
    await store.commit(manualWrites);
    const counted = await store.stats("manual-user", {
      from: at - 1000,
      to: at + 1000,
    });
    assert.equal(counted.count, 4);
    assert.equal(counted.firstPlaceRate, 0.25);
    assert.equal(counted.averageRank, 2.75);
    assert.equal(counted.averageNetPoints, -750);
    assert.deepEqual(
      counted.distribution.map((d) => d.count),
      [1, 1, 0, 2],
    );
    await assert.rejects(
      store.commit([
        { kind: "test", id: "rollback", data: { x: 1 } },
        { kind: "history", id: "broken", data: null },
      ]),
    );
    assert.equal(await store.get("test", "rollback"), null);
    // 10,000 summaries: query timing is separate from real 10-table production load.
    const template = summarize(finish("template"))!;
    const batch = [];
    for (let i = 0; i < 10000; i++) {
      const s = { ...template, matchId: "bench" + i, finishedAt: at - i };
      batch.push({ kind: "history", id: s.matchId, data: s });
    }
    await store.commit(batch);
    const historyMs: number[] = [],
      statsMs: number[] = [];
    for (let i = 0; i < 100; i++) {
      let start = performance.now();
      await store.history("user0", {});
      historyMs.push(performance.now() - start);
      start = performance.now();
      await store.stats("user0", { from: at - 30 * 86400000, to: at });
      statsMs.push(performance.now() - start);
    }
    const p95 = (x: number[]) => x.sort((a, b) => a - b)[94];
    writeFileSync(
      "reports/v3-query-benchmark.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          version: APP_VERSION,
          database: "SQLite local",
          summaries: 10051,
          queries: 100,
          historyP95Ms: p95(historyMs),
          statsP95Ms: p95(statsMs),
          scope: "Indexed query benchmark, not production 10-table acceptance",
        },
        null,
        2,
      ),
    );
    assert(p95(historyMs) < 2000);
    assert(p95(statsMs) < 2000);
  } finally {
    await store.close();
    if (old === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
