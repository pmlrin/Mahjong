import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  createGame,
  project,
  quad,
  apply,
  advanceResult,
  assertInvariants,
} from "../backend/src/engine.ts";
import { chooseBot } from "../backend/src/bot.ts";
import {
  TableActions,
  type TableDependencies,
} from "../frontend/src/table-actions.ts";
import type { Frame, Receipt, Seat } from "../shared/types.ts";

for (const humans of [1, 4])
  test(`V42 full engine match: ${humans} scripted HUMAN controller(s), ${4 - humans} bots`, async (t) => {
    const start = performance.now(),
      startedAt = new Date().toISOString();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const g = createGame(
      "v42-complete",
      quad((s) => ({
        memberId: String(s),
        userId: s < humans ? String(s) : null,
        displayName: `脚本${s}`,
        participantKind: s < humans ? "HUMAN" : "BOT",
        ready: true,
        connected: true,
        botLevel: s < humans ? null : "BASIC",
      })),
      undefined,
      Date.now(),
      42,
    );
    let now = 0,
      sequence = 0,
      serial = 0,
      actions = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const receipts = new Map<string, Receipt>();
    const controllers: TableActions[] = [];
    const entries = {
      quick: 0,
      keyboard: 0,
      autoDiscard: 0,
      noCall: 0,
      choice: 0,
    };
    const frame = (seat: Seat, syncId: string | null = null): Frame => ({
      protocolVersion: "2.0",
      matchId: g.matchId,
      serverEpoch: g.serverEpoch,
      streamId: "engine-test",
      viewSeq: ++sequence,
      serverTime: Date.now(),
      syncId,
      state: project(g, seat),
    });
    const install = () =>
      controllers.forEach((a, s) =>
        a.install({
          frame: frame(s as Seat),
          binding: `binding-${s}`,
          network: true,
        }),
      );
    for (let s = 0; s < humans; s++) {
      const seat = s as Seat;
      let a: TableActions;
      const deps: TableDependencies = {
        now: () => now,
        uuid: () => `request-${++serial}`,
        later: (callback, ms) => {
          const id = ++serial;
          timers.set(id, { at: now + ms, callback });
          return id;
        },
        cancel: (id) => {
          timers.delete(id as number);
        },
        changed: () => {},
        error: (message) => {
          throw Error(message);
        },
        save: () => {},
        sync: async (_matchId, syncId) => {
          queueMicrotask(() =>
            a.install({
              frame: frame(seat, syncId),
              binding: `binding-${s}`,
              network: true,
            }),
          );
        },
        send: async (payload, requestId) => {
          assert.equal(payload.decisionId, g.decisions[seat]!.decisionId);
          assert.equal(payload.windowId, g.window!.windowId);
          assert.equal(payload.handId, g.handId);
          assert.equal(payload.serverEpoch, g.serverEpoch);
          const acceptance = apply(g, seat, payload.optionId, requestId);
          actions++;
          const receipt: Receipt = {
            protocolVersion: "2.0",
            matchId: g.matchId,
            serverTime: Date.now(),
            requestId,
            receiptId: `receipt-${requestId}`,
            status: "ACCEPTED",
            acceptance,
          };
          receipts.set(requestId, receipt);
          // Install the server's next state BEFORE the ack: the former UI lost its lock here.
          install();
          assertInvariants(g);
          return receipt;
        },
        query: async (_match, id) => {
          const r = receipts.get(id);
          if (!r) throw Error("404");
          return r;
        },
      };
      a = new TableActions(deps);
      controllers.push(a);
    }
    install();
    await Promise.resolve();
    await Promise.resolve();
    controllers.forEach((a) => {
      a.quick = true;
      a.keyboard = true;
      a.setAutomatic("discard", true);
      a.setAutomatic("noCall", true);
    });
    while (g.phase !== "MATCH_RESULT") {
      assert(actions < 15000, "complete match must make progress");
      if (g.phase === "HAND_RESULT") {
        advanceResult(g);
        install();
        await Promise.resolve();
        continue;
      }
      const seat = g.decisions.findIndex((d) => d && !d.choice) as Seat;
      assert(seat >= 0);
      if (seat >= humans) {
        apply(g, seat, chooseBot(project(g, seat)));
        actions++;
        install();
        await Promise.resolve();
        continue;
      }
      const a = controllers[seat];
      let choice = g.decisions[seat]!.options.find(
        (o) => o.optionId === chooseBot(project(g, seat)),
      )!;
      if (a.noCall && ["CHI", "PON", "DAIMINKAN"].includes(choice.type))
        choice = g.decisions[seat]!.options.find((o) => o.type === "PASS")!;
      const before = actions;
      // Alternate every entry type; all automatic input traverses the real 500ms gate.
      if (actions % 4 < 2) {
        now += 500;
        t.mock.timers.tick(500);
        for (const [id, t] of [...timers])
          if (t.at <= now) {
            timers.delete(id);
            t.callback();
          }
        await Promise.resolve();
        await Promise.resolve();
        if (actions !== before) {
          if (choice.type === "DISCARD" || choice.type === "RIICHI_DISCARD")
            entries.autoDiscard++;
          else entries.noCall++;
          continue;
        }
      }
      if (choice.type === "DISCARD") {
        if (actions % 2 === 0) {
          a.select(choice.tile!, true);
          entries.quick++;
        } else {
          a.move("Home");
          for (let i = 0; i < 14 && a.selected !== choice.tile; i++)
            a.move("ArrowRight");
          a.confirm();
          entries.keyboard++;
        }
      } else if (choice.type === "RIICHI_DISCARD") {
        a.toggleRiichi();
        a.select(choice.tile!);
        a.confirm();
        entries.keyboard++;
      } else if (choice.type === "PASS") {
        a.pass();
        if (a.modal) a.confirm();
        entries.choice++;
      } else {
        a.open([choice.type]);
        if (a.modal)
          a.modal.index = a.modal.options.findIndex(
            (o) => o.optionId === choice.optionId,
          );
        a.confirm();
        entries.choice++;
      }
      await Promise.resolve();
      await Promise.resolve();
      assert(
        actions > before,
        `controller ${seat} must submit ${choice.type}; can=${a.can} lock=${a.lock?.status} fresh=${a.fresh} remain=${a.remaining()}`,
      );
    }
    assertInvariants(g);
    assert(g.matchResult);
    assert(controllers.every((a) => !a.autoDiscard && !a.noCall));
    assert(
      entries.quick > 0 &&
        entries.keyboard > 0 &&
        entries.autoDiscard > 0 &&
        entries.noCall > 0,
    );
    const report = {
      at: startedAt,
      humans,
      humanDescription: "scripted HUMAN; no real participants",
      layer:
        "production controller + rule engine, in-memory transport; not a browser or public network match",
      bots: 4 - humans,
      actions,
      hands: g.handIndex,
      entries,
      points: g.matchResult.finalPoints,
      reason: g.matchResult.reason,
      elapsedMs: Math.round(performance.now() - start),
      invariants:
        "checked after every action, including before acknowledgements",
    };
    writeFileSync(
      `reports/v42-complete-${humans}.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
    controllers.forEach((a) => a.dispose());
  });
