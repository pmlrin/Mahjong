import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./v42-fixture.ts";
import {
  TableActions,
  automaticOption,
  decisionKey,
  TileGesture,
  parsePreferences,
  preferenceKey,
  parseSavedAction,
  type SavedAction,
} from "../frontend/src/table-actions.ts";
import type { Action, Frame, Option, Receipt } from "../shared/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup(f = fixture(), saved?: SavedAction) {
  let now = 0,
    id = 0,
    authorized = true,
    stored: SavedAction | null = saved ?? null;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: {
      payload: Action;
      id: string;
      reply: ReturnType<typeof deferred<Receipt>>;
    }[] = [],
    syncs: string[] = [];
  const queries: ReturnType<typeof deferred<Receipt>>[] = [];
  const a = new TableActions(
    {
      now: () => now,
      uuid: () => `request-${++id}`,
      later: (fn, ms) => {
        const k = ++id;
        timers.set(k, { at: now + ms, fn });
        return k;
      },
      cancel: (t) => {
        timers.delete(t as number);
      },
      send: (payload, id) => {
        const reply = deferred<Receipt>();
        sent.push({ payload: structuredClone(payload), id, reply });
        return reply.promise;
      },
      query: () => {
        const reply = deferred<Receipt>();
        queries.push(reply);
        return reply.promise;
      },
      sync: async (_m, id) => {
        syncs.push(id);
      },
      save: (x) => {
        stored = structuredClone(x);
      },
      changed: () => {},
      error: () => {},
      authorized: () => authorized,
    },
    saved,
  );
  function install(frame: Frame = f, binding = "binding", network = true) {
    f = frame;
    a.install({ frame, binding, network });
  }
  function sync() {
    const next = structuredClone(f);
    next.syncId = syncs.at(-1)!;
    next.viewSeq++;
    install(next);
  }
  install();
  sync();
  return {
    a,
    sent,
    syncs,
    queries,
    timers,
    install,
    sync,
    stored: () => stored,
    frame: () => f,
    authorize: (value: boolean) => {
      authorized = value;
    },
    advance: (ms: number) => {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now);
      for (const [k, t] of due) {
        timers.delete(k);
        t.fn();
      }
    },
    receipt: (i = 0, status: Receipt["status"] = "ACCEPTED") =>
      sent[i].reply.resolve({
        protocolVersion: "2.0",
        serverTime: 1500,
        requestId: sent[i].id,
        matchId: f.matchId,
        receiptId: "receipt",
        status,
        error:
          status === "REJECTED"
            ? {
                code: "OPTION_NOT_AVAILABLE",
                message: "拒绝",
                retryable: false,
                shouldSync: true,
              }
            : undefined,
      }),
  };
}
function response(ron = false, passOnly = false) {
  const f = fixture(),
    v = f.state,
    d = v.self.decision!;
  v.hand.window!.kind = "CALL_RESPONSE";
  v.hand.window!.actorSeat = 3;
  v.hand.window!.selfActionMode = null;
  d.options = [
    { optionId: "pass", type: "PASS" },
    ...(passOnly
      ? []
      : ([
          { optionId: "chi", type: "CHI", consumedTiles: [0, 4] },
          { optionId: "pon", type: "PON", consumedTiles: [16, 17] },
          { optionId: "kan", type: "DAIMINKAN", consumedTiles: [16, 17, 18] },
        ] as Option[])),
    ...(ron ? [{ optionId: "ron", type: "RON" } as Option] : []),
  ];
  return f;
}
function nextDecision(f: Frame) {
  const next = structuredClone(f);
  next.state.self.decision!.decisionId += "-next";
  next.state.self.decision!.windowId += "-next";
  next.state.hand.window!.windowId = next.state.self.decision!.windowId;
  next.viewSeq++;
  return next;
}

test("V42 defaults and scoped preference failures are safe", () => {
  const { a } = setup();
  assert.equal(a.quick, false);
  assert.equal(a.keyboard, false);
  assert.equal(a.autoDiscard, false);
  assert.equal(a.noCall, false);
  for (const raw of [null, "bad", "null", '{"quick":"true","keyboard":1}'])
    assert.deepEqual(parsePreferences(raw), { quick: false, keyboard: false });
  assert.deepEqual(parsePreferences('{"quick":true,"keyboard":true}'), {
    quick: true,
    keyboard: true,
  });
  assert.notEqual(
    preferenceKey("preview", "a"),
    preferenceKey("production", "a"),
  );
  assert.notEqual(preferenceKey("preview", "a"), preferenceKey("preview", "b"));
  assert.equal(parseSavedAction('{"payload":{}}', "match"), null);
});
test("normal and keyboard selection never quick-discard; a quick pointer uses exact physical tile", () => {
  const { a, sent } = setup();
  a.quick = true;
  a.select(16);
  assert.equal(sent.length, 0);
  a.move("ArrowRight");
  assert.equal(a.selected, 17);
  assert.equal(sent.length, 0);
  a.select(18, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.optionId, "discard-18");
});
test("quick riichi requires explicit confirmation and cancellation has no effect", () => {
  const f = fixture();
  f.state.self.decision!.options.push({
    type: "RIICHI_DISCARD",
    tile: 16,
    optionId: "riichi-16",
  });
  const { a, sent } = setup(f);
  a.quick = true;
  a.toggleRiichi();
  a.select(16, true);
  assert.equal(sent.length, 0);
  a.escape();
  assert.equal(sent.length, 0);
  a.toggleRiichi();
  a.select(16, true);
  a.confirm();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.optionId, "riichi-16");
});
test("all inputs and same-frame repeats share a synchronous decision lock", () => {
  const { a, sent, advance } = setup();
  a.setAutomatic("discard", true);
  advance(500);
  a.select(16, true);
  a.submit(a.options[0]);
  a.confirm();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.optionId, "discard-18");
});
test("manual choice wins before timeout and cannot be rescheduled by viewSeq", () => {
  const h = setup();
  h.a.setAutomatic("discard", true);
  h.advance(499);
  h.a.select(16);
  const f = structuredClone(h.frame());
  f.viewSeq++;
  h.install(f);
  h.advance(1000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.a.selected, 16);
  h.a.confirm();
  assert.equal(h.sent[0].payload.optionId, "discard-16");
});
test("500ms wait is not extended by a same-decision snapshot or system clock", () => {
  const h = setup();
  h.a.setAutomatic("discard", true);
  h.advance(400);
  const f = structuredClone(h.frame());
  f.viewSeq++;
  f.serverTime -= 1000000;
  h.install(f);
  h.advance(100);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.optionId, "discard-18");
});
test("duplicate snapshots and accepted responses keep the action lock until decision changes", async () => {
  const h = setup();
  h.a.select(16);
  h.a.confirm();
  h.receipt();
  await flush();
  const f = structuredClone(h.frame());
  f.viewSeq++;
  h.install(f);
  h.a.submit(h.a.options[1]);
  assert.equal(h.sent.length, 1);
  assert(h.a.pending);
  h.install(nextDecision(f));
  assert(h.a.can);
});
test("automatic cancellation, toggle-off, decision expiry and delayed callbacks never spill into another window", () => {
  for (const change of ["off", "manual", "new", "expire", "authority"]) {
    const h = setup();
    h.a.setAutomatic("discard", true);
    h.advance(300);
    if (change === "off") h.a.setAutomatic("discard", false);
    if (change === "manual") h.a.intervene();
    if (change === "new") h.install(nextDecision(h.frame()));
    if (change === "authority") h.authorize(false);
    h.advance(change === "expire" ? 20000 : 200);
    assert.equal(h.sent.length, 0, change);
  }
});
test("deadline <=500ms will not schedule; old timers never replace the exact draw", () => {
  const f = fixture();
  f.state.self.decision!.deadlineAt = 1500;
  const h = setup(f);
  h.a.setAutomatic("discard", true);
  h.advance(500);
  assert.equal(h.sent.length, 0);
  const h2 = setup();
  h2.a.setAutomatic("discard", true);
  const f2 = structuredClone(h2.frame());
  f2.state.self.decision!.options = f2.state.self.decision!.options.filter(
    (o) => o.tile !== 18,
  );
  h2.install(f2);
  h2.advance(500);
  assert.equal(h2.sent.length, 0);
});
test("special choices pause auto-discard; riichi opportunity alone does not", () => {
  for (const type of [
    "TSUMO",
    "ANKAN",
    "KAKAN",
    "ABORT_KYUUSHU",
    "RIICHI_DISCARD",
  ] as const) {
    const f = fixture();
    f.state.self.decision!.options.push({ type, optionId: type, tile: 16 });
    const h = setup(f);
    h.a.setAutomatic("discard", true);
    h.advance(500);
    assert.equal(h.sent.length, type === "RIICHI_DISCARD" ? 1 : 0, type);
  }
});
test("manual riichi intervention cancels auto and next decision resumes", () => {
  const f = fixture();
  f.state.self.decision!.options.push({
    type: "RIICHI_DISCARD",
    tile: 16,
    optionId: "r",
  });
  const h = setup(f);
  h.a.setAutomatic("discard", true);
  h.a.toggleRiichi();
  h.advance(500);
  assert.equal(h.sent.length, 0);
  h.install(nextDecision(h.frame()));
  h.advance(500);
  assert.equal(h.sent.length, 1);
});
test("after-call discard, invalid drawn ID, AI and pending human control never auto-discard", () => {
  for (const mode of [
    "after-call",
    "no-draw",
    "AI",
    "pending",
    "wrong-window",
    "same-kind",
  ]) {
    const f = fixture(),
      v = f.state;
    if (mode === "after-call") v.hand.window!.selfActionMode = "AFTER_CALL";
    if (mode === "no-draw") v.self.drawnTile = null;
    if (mode === "AI") v.self.decision!.owner = "AI";
    if (mode === "pending") {
      v.self.decision!.canSubmit = false;
      v.self.decision!.disabledReason = "CONTROL_PENDING";
    }
    if (mode === "wrong-window") v.hand.window!.windowId = "other";
    if (mode === "same-kind") v.self.drawnTile = 19;
    assert.equal(automaticOption(f, true, false).option, undefined, mode);
  }
});
test("no-call sends the original PASS once for multiple calls and pass-only decisions", () => {
  for (const only of [false, true]) {
    const h = setup(response(false, only));
    h.a.setAutomatic("noCall", true);
    h.advance(499);
    assert.equal(h.sent.length, 0);
    h.advance(1);
    h.advance(2000);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].payload.optionId, "pass");
  }
});
test("RON and robbing-kan never auto-PASS; explicit refusal needs a cancellable confirmation", () => {
  for (const kind of ["CALL_RESPONSE", "KAN_RESPONSE"] as const) {
    const f = response(true);
    f.state.hand.window!.kind = kind;
    const h = setup(f);
    h.a.setAutomatic("noCall", true);
    h.advance(500);
    assert.equal(h.sent.length, 0);
    h.a.open(["CHI"]);
    assert.equal(h.a.modal, null);
    h.a.pass();
    assert(Boolean((h.a.modal as { passRon: boolean } | null)?.passRon));
    h.a.escape();
    assert.equal(h.sent.length, 0);
    h.a.pass();
    h.a.confirm();
    assert.equal(h.sent[0].payload.optionId, "pass");
  }
});
test("closing no-call restores calls and it never hides self kan", () => {
  const h = setup(response(true));
  h.a.setAutomatic("noCall", true);
  h.a.setAutomatic("noCall", false);
  h.a.open(["CHI"]);
  assert.equal(h.a.modal?.options[0].type, "CHI");
  assert.equal(h.sent.length, 0);
  h.a.confirm();
  assert.equal(h.sent.length, 1);
  const f = fixture();
  f.state.self.decision!.options.push({
    type: "ANKAN",
    optionId: "ankan",
    tiles: [16, 17, 18, 19],
  });
  const h2 = setup(f);
  h2.a.setAutomatic("noCall", true);
  h2.a.open(["ANKAN"]);
  assert.equal(h2.a.modal?.options[0].type, "ANKAN");
});
test("select traversal uses screen order, wraps physical copies and Enter has no default tile", () => {
  const h = setup();
  h.a.confirm();
  assert.equal(h.sent.length, 0);
  h.a.move("ArrowLeft");
  assert.equal(h.a.selected, 18);
  h.a.move("ArrowRight");
  assert.equal(h.a.selected, 0);
  h.a.move("End");
  assert.equal(h.a.selected, 18);
  h.a.move("Home");
  assert.equal(h.a.selected, 0);
  h.a.escape();
  assert.equal(h.a.selected, null);
});
test("single call and win shortcuts always open choices before confirming", () => {
  const h = setup(response(true));
  h.a.open(["RON"]);
  assert.equal(h.sent.length, 0);
  h.a.escape();
  assert.equal(h.sent.length, 0);
  h.a.open(["PON"]);
  assert.equal(h.sent.length, 0);
  h.a.confirm();
  assert.equal(h.sent[0].payload.optionId, "pon");
});
test("unknown receipt and query 404 cannot unlock or create another request", async () => {
  const h = setup();
  h.a.setAutomatic("discard", true);
  h.advance(500);
  const original = h.sent[0];
  original.reply.reject(Error("lost"));
  await flush();
  h.queries[0].reject(Error("404"));
  await flush();
  h.sync();
  h.a.submit(h.a.options[0]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.a.autoDiscard, false);
  assert.equal(h.a.lock?.requestId, original.id);
  assert.equal(h.stored()?.requestId, original.id);
  const retry = h.a.recover(true);
  h.queries.at(-1)!.reject(Error("404"));
  await flush();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].id, original.id);
  assert.deepEqual(h.sent[1].payload, {
    ...original.payload,
    lastSeenViewSeq: h.frame().viewSeq,
  });
  h.receipt(1);
  await retry;
  assert(h.a.pending);
});
test("explicit rejection requires synchronization and returns control to manual, without retry loop", async () => {
  const h = setup();
  h.a.setAutomatic("discard", true);
  h.advance(500);
  h.receipt(0, "REJECTED");
  await flush();
  assert.equal(h.a.can, false);
  h.sync();
  h.advance(2000);
  assert.equal(h.sent.length, 1);
  assert(h.a.can);
  h.a.select(16);
  h.a.confirm();
  assert.equal(h.sent.length, 2);
});
test("fresh authority changing the decision resolves uncertainty without retransmitting old intent", async () => {
  const h = setup();
  h.a.select(16);
  h.a.confirm();
  h.sent[0].reply.reject(Error("lost"));
  await flush();
  h.install(nextDecision(h.frame()));
  assert.equal(h.a.can, false);
  h.sync();
  assert(h.a.can);
  assert.equal(h.sent.length, 1);
  assert.equal(h.stored(), null);
});
test("background, disconnect, epoch and control changes close automatic modes; return requires fresh sync", () => {
  for (const mode of ["blur", "disconnect", "epoch", "AI", "binding"]) {
    const h = setup();
    h.a.setAutomatic("discard", true);
    h.a.setAutomatic("noCall", true);
    if (mode === "blur") h.a.suspend();
    else {
      const f = structuredClone(h.frame());
      if (mode === "epoch") f.serverEpoch++;
      if (mode === "AI") f.state.self.desiredControl = "AI";
      h.install(
        f,
        mode === "binding" ? "other" : "binding",
        mode !== "disconnect",
      );
    }
    h.advance(1000);
    assert.equal(h.sent.length, 0, mode);
    assert.equal(h.a.autoDiscard, false, mode);
    assert.equal(h.a.noCall, false, mode);
  }
  const h = setup();
  h.a.suspend();
  h.a.resume();
  h.a.setAutomatic("discard", true);
  assert.equal(h.a.autoDiscard, false);
  h.sync();
  h.a.setAutomatic("discard", true);
  assert.equal(h.a.autoDiscard, true);
});
test("hand results keep automatic preference while final match and new match shut down", () => {
  const h = setup();
  h.a.setAutomatic("discard", true);
  let f = structuredClone(h.frame());
  f.state.hand.phase = "HAND_RESULT";
  f.state.self.decision = null;
  h.install(f);
  assert.equal(h.a.autoDiscard, true);
  f = nextDecision(fixture());
  h.install(f);
  h.advance(500);
  assert.equal(h.sent.length, 1);
  for (const status of ["FINISHED", "ABORTED"]) {
    const h = setup();
    h.a.setAutomatic("discard", true);
    const f = structuredClone(h.frame());
    f.state.status = status;
    h.install(f);
    assert.equal(h.a.autoDiscard, false);
  }
});
test("stale identity async callbacks cannot mutate a replacement table or erase pending recovery", async () => {
  const h = setup();
  h.a.select(16);
  h.a.confirm();
  const saved = h.stored()!;
  h.a.dispose();
  h.receipt();
  await flush();
  assert.deepEqual(h.stored(), saved);
  const restored = parseSavedAction(
    JSON.stringify(saved),
    saved.payload.matchId,
  );
  assert(restored);
  assert.equal(
    parseSavedAction(
      JSON.stringify({ ...saved, key: "corrupted" }),
      saved.payload.matchId,
    )?.key,
    decisionKey(fixture()),
  );
  const h2 = setup(fixture(), restored);
  assert.equal(h2.a.can, false);
  assert.equal(h2.a.autoDiscard, false);
});
test("gesture guard rejects drag, wrong tile, nonprimary, multi-touch, stale decision, cancel and double-click", () => {
  const e = {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
  };
  for (const mode of [
    "valid",
    "drag",
    "wrong-tile",
    "secondary",
    "multi",
    "key",
    "cancel",
    "double",
  ]) {
    const g = new TileGesture();
    g.begin({ ...e, isPrimary: mode !== "secondary" }, 16, "key");
    if (mode === "drag") g.move({ ...e, clientX: 19 });
    if (mode === "multi") g.trackDown(2);
    if (mode === "cancel") g.cancel();
    g.end(e, mode === "wrong-tile" ? 17 : 16, mode === "key" ? "other" : "key");
    assert.equal(
      g.consume(16, "key", mode === "double" ? 2 : 1),
      mode === "valid",
      mode,
    );
    assert.equal(g.consume(16, "key", 1), false);
  }
});

test("unrelated automatic toggle and equivalent option property order preserve the original wait", () => {
  const h = setup();
  h.a.setAutomatic("discard", true);
  h.advance(400);
  h.a.setAutomatic("noCall", true);
  const f = structuredClone(h.frame());
  f.viewSeq++;
  f.state.self.decision!.options = f.state.self.decision!.options.map((o) => ({
    tile: o.tile,
    type: o.type,
    optionId: o.optionId,
  }));
  h.install(f);
  h.advance(100);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.optionId, "discard-18");
});
test("rinshan draw uses the exact drawn copy and never a same-kind hand tile", () => {
  const f = fixture();
  f.state.self.drawSource = "RINSHAN";
  const h = setup(f);
  h.a.setAutomatic("discard", true);
  h.advance(500);
  assert.equal(h.sent[0].payload.optionId, "discard-18");
});
test("invalidated selected entity is cleared while still-legal entity survives snapshots", () => {
  const h = setup();
  h.a.select(16);
  let f = structuredClone(h.frame());
  f.viewSeq++;
  h.install(f);
  assert.equal(h.a.selected, 16);
  f = structuredClone(f);
  f.state.self.decision!.options = f.state.self.decision!.options.filter(
    (o) => o.tile !== 16,
  );
  f.viewSeq++;
  h.install(f);
  assert.equal(h.a.selected, null);
  h.a.confirm();
  assert.equal(h.sent.length, 0);
});
test("storage failure never blocks manual selection or releases the synchronous action lock", () => {
  const f = fixture();
  let sends = 0;
  let a: TableActions;
  a = new TableActions({
    now: () => 0,
    later: () => 0,
    cancel: () => {},
    uuid: () => "id",
    changed: () => {},
    error: () => {},
    save: () => {
      throw Error("disabled");
    },
    send: async () => {
      sends++;
      return new Promise(() => {});
    },
    query: async () => new Promise(() => {}),
    sync: async () => {},
  });
  a.install({ frame: f, binding: "b", network: true });
  const synced = structuredClone(f);
  synced.syncId = "id";
  a.install({ frame: synced, binding: "b", network: true });
  a.select(16);
  a.confirm();
  a.confirm();
  assert.equal(sends, 1);
  assert(a.pending);
});

test("unknown result after a same-window sync resolves when a later authoritative window advances", async () => {
  const h = setup();
  h.a.select(16);
  h.a.confirm();
  h.sent[0].reply.reject(Error("lost"));
  await flush();
  h.queries[0].reject(Error("404"));
  await flush();
  h.sync();
  assert.equal(h.a.can, false);
  const before = h.syncs.length;
  h.install(nextDecision(h.frame()));
  assert.equal(h.a.can, false);
  assert.equal(h.syncs.length, before + 1);
  h.sync();
  assert(h.a.can);
  assert.equal(h.stored(), null);
  assert.equal(h.sent.length, 1);
});
