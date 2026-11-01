import React from "react";
import { type MatchView } from "../../shared/types";
import { Tile } from "./Tile";
const actionNames: Record<string, string> = {
  CHI: "吃",
  PON: "碰",
  ANKAN: "暗杠",
  KAKAN: "加杠",
  DAIMINKAN: "明杠",
};
export function Melds({
  melds,
}: {
  melds: MatchView["hand"]["seats"][number]["melds"];
}) {
  return (
    <div className="melds">
      {melds.map((m) => (
        <div key={m.meldId} title={actionNames[m.type]}>
          {m.tiles.map((t, i) => (
            <span key={t} className={m.calledTile === t ? "called-tile" : ""}>
              <Tile
                tile={t}
                back={m.type === "ANKAN" && (i === 0 || i === 3)}
                small
              />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
