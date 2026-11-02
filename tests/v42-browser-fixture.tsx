// Served exclusively by scripts/verify-table-browser.ts; never part of the app bundle.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Game } from "../frontend/src/Game";
import { preferenceKey } from "../frontend/src/table-actions";
import type { Frame, Option } from "../shared/types";
import "../frontend/src/style.css";
const base: Frame = await (await fetch("/__v42_frame")).json();
let generation = 0,
  update: (f: Frame) => void,
  frame: Frame,
  network: (b: boolean) => void;
const events: { payload: any; requestId: string; at: number }[] = [];
const errors: string[] = [];
let loseReceipt = false;
function install(f: Frame) {
  frame = f;
  update(f);
}
function reset(kind = "draw", preserve = false) {
  const f = structuredClone(base);
  f.serverTime = Date.now();
  f.state.self.decision!.deadlineAt = f.serverTime + 15000;
  f.state.hand.window!.deadlineAt = f.serverTime + 15000;
  events.length = 0;
  errors.length = 0;
  loseReceipt = false;
  sessionStorage.clear();
  try {
    if (!preserve)
      localStorage.removeItem(
        preferenceKey(location.origin + "/", "browser-v42"),
      );
  } catch {}
  if (kind === "riichi")
    f.state.self.decision!.options.push({
      type: "RIICHI_DISCARD",
      tile: 16,
      optionId: "riichi-16",
    });
  if (["call", "ron", "pass"].includes(kind)) {
    f.state.hand.window!.kind = "CALL_RESPONSE";
    f.state.hand.window!.selfActionMode = null;
    f.state.hand.window!.actorSeat = 3;
    f.state.hand.window!.sourceDiscardId = "source";
    f.state.hand.seats[3].discards = [
      {
        discardId: "source",
        tile: 8,
        tsumogiri: false,
        riichiDeclaration: false,
        claimedByMeldId: null,
      },
    ];
    f.state.self.decision!.options = [
      { type: "PASS", optionId: "pass" },
      ...(kind === "pass"
        ? []
        : ([
            { type: "CHI", optionId: "chi-red", consumedTiles: [0, 4] },
            { type: "CHI", optionId: "chi-normal", consumedTiles: [16, 17] },
            { type: "PON", optionId: "pon", consumedTiles: [16, 17] },
            { type: "DAIMINKAN", optionId: "kan", consumedTiles: [16, 17, 18] },
          ] as Option[])),
      ...(kind === "ron" ? [{ type: "RON", optionId: "ron" } as Option] : []),
    ];
  }
  if (["tsumo", "ankan", "kakan", "abort"].includes(kind))
    f.state.self.decision!.options.push({
      type: (
        {
          tsumo: "TSUMO",
          ankan: "ANKAN",
          kakan: "KAKAN",
          abort: "ABORT_KYUUSHU",
        } as const
      )[kind as "tsumo"],
      optionId: kind,
      tiles: [16, 17, 18, 19],
    });
  if (kind === "short") f.state.self.decision!.deadlineAt = f.serverTime + 500;
  generation++;
  install(f);
  network(true);
  return generation;
}
function App() {
  const [f, setFrame] = useState<Frame | null>(null),
    [online, setNetwork] = useState(true);
  update = setFrame;
  network = setNetwork;
  return (
    <div
      className="app game-app table-standard"
      data-browser-generation={generation}
    >
      <input aria-label="测试输入框" />
      <div id="error">{errors.join(";")}</div>
      {f && (
        <Game
          key={generation}
          view={f.state}
          frame={f}
          network={online}
          binding="browser-binding"
          userId="browser-v42"
          identity={String(generation)}
          authorized={() => online}
          emit={async (event, payload: any, requestId) => {
            if (event === "game:sync") {
              const next = structuredClone(frame);
              next.syncId = payload.syncId;
              next.viewSeq++;
              queueMicrotask(() => install(next));
              return { synced: true };
            }
            if (event === "game:action") {
              events.push({
                payload,
                requestId: requestId!,
                at: performance.now(),
              });
              if (loseReceipt) throw Error("lost");
              return { requestId, matchId: f.matchId, status: "ACCEPTED" };
            }
          }}
          setError={(error) => errors.push(error)}
          onNew={() => {}}
          onReplay={() => {}}
        />
      )}
    </div>
  );
}
(window as any).v42 = {
  reset,
  events,
  errors,
  frame: () => frame,
  lose: () => {
    loseReceipt = true;
  },
  duplicate: () => {
    const f = structuredClone(frame);
    f.viewSeq++;
    f.syncId = null;
    install(f);
  },
  next: () => {
    const f = structuredClone(frame);
    f.state.self.decision!.decisionId += "-next";
    f.state.self.decision!.windowId += "-next";
    f.state.hand.window!.windowId = f.state.self.decision!.windowId;
    f.viewSeq++;
    f.syncId = null;
    install(f);
  },
  disconnect: () => network(false),
  reconnect: () => network(true),
};
createRoot(document.getElementById("root")!).render(<App />);
