import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createGame,
  quad,
  project,
  apply,
  deal,
  log,
} from "../backend/src/engine.ts";
import { botReadyAt } from "../backend/src/bot-timing.ts";
import { responseTarget, callTiles } from "../shared/game-feedback.ts";
import {
  LatestDiscard,
  CallChoices,
  ResponseSource,
} from "../frontend/src/turn-feedback.tsx";
import type { Option, PublicWindow } from "../shared/types.ts";
function game() {
  return createGame(
    "feedback",
    quad((s) => ({
      memberId: String(s),
      userId: String(s),
      displayName: ["本人", "下家", "对家", "测试上家"][s],
      participantKind: "HUMAN",
      ready: true,
      connected: true,
      botLevel: null,
    })),
  );
}
function window(kind: PublicWindow["kind"]): PublicWindow {
  return {
    windowId: "window",
    kind,
    actorSeat: 1,
    selfActionMode: kind === "SELF_ACTION" ? "AFTER_DRAW" : null,
    sourceDiscardId: "discard",
    deadlineAt: 9e12,
  };
}
test("AI waits 2s after self window opens, and 1.2s after a response window opens", () => {
  assert.equal(botReadyAt(window("SELF_ACTION"), 20000), 7000);
  assert.equal(botReadyAt(window("CALL_RESPONSE"), 20000), 13200);
  assert.equal(botReadyAt(window("KAN_RESPONSE"), 20000), 13200);
  assert.equal(botReadyAt(window("SELF_ACTION"), 20000, true), 5000);
});
test("AI pacing uses monotonic window time rather than clock or network changes", () => {
  const w = window("SELF_ACTION"),
    at = botReadyAt(w, 20000);
  w.deadlineAt = -1;
  assert.equal(botReadyAt(w, 20000), at);
  // Slow calculations do not request another full pause once the intended moment has passed.
  assert.equal(Math.max(0, at - 9000), 0);
});
test("Latest discard stays visible after next draw and ignores private response events", () => {
  const g = game();
  const option = g.decisions[0]!.options.find((o) => o.type === "DISCARD")!;
  apply(g, 0, option.optionId);
  const first = project(g, 1).hand.lastDiscard!;
  assert(first);
  assert.equal(first.tile, option.tile);
  assert.equal(first.seat, 0);
  log(g, "RESPONSE_RECORDED", { seat: 2, privateChoice: "PASS" });
  assert.deepEqual(project(g, 1).hand.lastDiscard, first);
  assert.deepEqual(
    Object.keys(first).sort(),
    [
      "seat",
      "discardId",
      "tile",
      "tsumogiri",
      "riichiDeclaration",
      "claimedByMeldId",
    ].sort(),
  );
  g.players[0].discards.at(-1)!.claimedByMeldId = "meld";
  assert.equal(project(g, 1).hand.lastDiscard!.claimedByMeldId, "meld");
  deal(g);
  assert.equal(project(g, 1).hand.lastDiscard, null);
});
test("Call target matches the response discard ID, rather than another player or newest river tile", () => {
  const v = project(game(), 0);
  v.hand.seats[3].discards = [
    {
      discardId: "wanted",
      tile: 16,
      tsumogiri: false,
      riichiDeclaration: false,
      claimedByMeldId: null,
    },
    {
      discardId: "other",
      tile: 20,
      tsumogiri: false,
      riichiDeclaration: false,
      claimedByMeldId: null,
    },
  ];
  v.hand.window = {
    ...window("CALL_RESPONSE"),
    actorSeat: 3,
    sourceDiscardId: "wanted",
  };
  assert.deepEqual(responseTarget(v), {
    seat: 3,
    tile: 16,
    displayName: "测试上家",
    relation: "上家",
    source: "DISCARD",
    discardId: "wanted",
  });
  v.hand.window.sourceDiscardId = "missing";
  assert.equal(responseTarget(v), null);
  v.hand.window = window("SELF_ACTION");
  assert.equal(responseTarget(v), null);
});
test("Robbing a kan identifies the proposed kan tile, not the previous discard", () => {
  const v = project(game(), 0);
  v.hand.window = { ...window("KAN_RESPONSE"), actorSeat: 3 };
  v.hand.pendingKan = {
    seat: 3,
    type: "KAKAN",
    tiles: [16, 17, 18, 19],
    baseMeldId: "meld",
    robbableTile: 16,
  };
  assert.equal(responseTarget(v)?.tile, 16);
  assert.equal(responseTarget(v)?.source, "KAN");
});
test("Call preview names the player and incoming tile and shows the complete chi", () => {
  const v = project(game(), 0);
  const target = {
    seat: 3 as const,
    tile: 8,
    displayName: "测试上家",
    relation: "上家",
    source: "DISCARD" as const,
    discardId: "discard",
  };
  const o: Option = { optionId: "chi", type: "CHI", consumedTiles: [4, 0] };
  assert.deepEqual(callTiles(o, target.tile), [0, 4, 8]);
  const html = renderToStaticMarkup(
    React.createElement(CallChoices, {
      type: "CHI",
      target,
      options: [o],
      disabled: false,
      onConfirm: () => {},
    }),
  );
  for (const label of [
    "测试上家",
    "三万",
    "你的手牌",
    "组成顺子",
    "确认吃",
    "用二万、一万吃测试上家的三万",
  ])
    assert(html.includes(label), label);
});
test("Pon and open-kan previews preserve actual red and normal copies", () => {
  const target = {
    seat: 3 as const,
    tile: 16,
    displayName: "测试上家",
    relation: "上家",
    source: "DISCARD" as const,
    discardId: "discard",
  };
  for (const [type, consumed] of [
    ["PON", [17, 18]],
    ["DAIMINKAN", [17, 18, 19]],
  ] as const) {
    const o: Option = { optionId: type, type, consumedTiles: [...consumed] };
    assert.deepEqual(callTiles(o, 16), [16, ...consumed]);
    const html = renderToStaticMarkup(
      React.createElement(CallChoices, {
        type,
        target,
        options: [o],
        disabled: true,
        onConfirm: () => {},
      }),
    );
    assert(html.includes("赤五万"));
    assert(html.includes(type === "PON" ? "组成刻子" : "组成杠子"));
    assert(html.includes('disabled=""'));
  }
});
test("Latest-discard banner and response hint display source player and tile accessibly", () => {
  const g = game();
  const o = g.decisions[0]!.options.find((o) => o.type === "DISCARD")!;
  apply(g, 0, o.optionId);
  const v = project(g, 1);
  const html = renderToStaticMarkup(
    React.createElement(LatestDiscard, { view: v }),
  );
  assert(html.includes("最新出牌"));
  assert(html.includes("本人"));
  assert(html.includes('aria-live="polite"'));
  const target = {
    seat: 3 as const,
    tile: 16,
    displayName: "测试上家",
    relation: "上家",
    source: "DISCARD" as const,
    discardId: "discard",
  };
  const hint = renderToStaticMarkup(
    React.createElement(ResponseSource, {
      source: target,
      prompt: "你可以碰，或选择过牌",
    }),
  );
  assert(hint.includes("打出"));
  assert(hint.includes("赤五万"));
  assert(hint.includes("你可以碰"));
});
