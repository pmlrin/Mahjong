// Offline layout fixtures only: no server, database, account, or game mutations.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createGame, quad, project } from "../backend/src/engine.ts";
import { TableSurface } from "../frontend/src/TableSurface";
import type { Meld, Seat } from "../shared/types";
const directory = "data/table-layout";
mkdirSync(directory, { recursive: true });
const css = ["tokens", "base", "style"]
  .map((name) => readFileSync(`frontend/src/${name}.css`, "utf8"))
  .join("\n")
  .replace(/@import[^;]+;/g, "");
for (const stress of [false, true]) {
  const game = createGame(
    "layout-fixture",
    quad((s) => ({
      memberId: String(s),
      userId: String(s),
      displayName: ["本人", "下家", "对家", "上家"][s],
      participantKind: "HUMAN",
      ready: true,
      connected: true,
      botLevel: null,
    })),
  );
  const view = project(game, 0);
  view.hand.liveWallRemaining = 5;
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const h = view.hand.seats[seat];
    h.discards = Array.from({ length: stress ? 30 : 18 }, (_, i) => ({
      discardId: `${seat}-${i}`,
      tile: (i * 4 + seat) % 136,
      tsumogiri: i % 3 === 0,
      riichiDeclaration: i === 6,
      claimedByMeldId: null,
    }));
    h.melds = Array.from({ length: stress ? 4 : 2 }, (_, i): Meld => ({
      meldId: `meld-${seat}-${i}`,
      type: (["CHI", "PON", "ANKAN", "KAKAN"] as const)[i],
      tiles:
        i === 0
          ? [0, 4, 8]
          : i === 1
            ? [36, 37, 38]
            : i === 2
              ? [72, 73, 74, 75]
              : [100, 101, 102, 103],
      sourceSeat: i === 2 ? null : (((seat + 3) % 4) as Seat),
      sourceDiscardId: null,
      calledTile: i === 2 ? null : i === 0 ? 4 : i === 1 ? 37 : 101,
      addedTile: i === 3 ? 103 : null,
    }));
    h.concealedCount = stress ? 1 : 7;
  }
  view.hand.lastDiscard = { ...view.hand.seats[3].discards.at(-1)!, seat: 3 };
  const content = renderToStaticMarkup(
    <div className="app game-app">
      <main className="play-page">
        <TableSurface view={view} />
      </main>
    </div>,
  );
  for (const compact of [false, true]) {
    const name =
      (stress ? "stress" : "late-hand") + (compact ? "-compact" : "");
    writeFileSync(
      `${directory}/${name}.html`,
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>牌桌布局验证</title><style>${css}</style><body class="${compact ? "table-compact" : ""}">${content}</body></html>`,
    );
  }
}
console.log("Rendered production TableSurface fixtures to " + directory);
