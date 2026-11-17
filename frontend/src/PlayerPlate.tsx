import React from "react";
import {
  AUTOPILOT_BOT_LEVEL,
  botLevelLabel,
  type MatchView,
  type Seat,
} from "../../shared/types";
import { Avatar } from "./Avatar";

export const windName = (w: string) =>
  ({ EAST: "东", SOUTH: "南", WEST: "西", NORTH: "北" })[w] ?? w;

/** The level the AI plays this seat at: an AI 牌友's own, 中级 for a hosted human seat. */
export const seatBotLevel = (v: MatchView, s: Seat) =>
  botLevelLabel(
    v.players[s].participantKind === "BOT"
      ? v.players[s].botLevel
      : AUTOPILOT_BOT_LEVEL,
  );

/** One-line connection/control status shown under a player's name. */
export function seatStatus(v: MatchView, s: Seat) {
  const p = v.players[s],
    hand = v.hand,
    level = seatBotLevel(v, s);
  return hand.phase === "SELF_ACTION" &&
    hand.activeSeat === s &&
    p.effectiveControl === "AI"
    ? `${level} AI 思考中…`
    : p.participantKind === "BOT"
      ? `AI 牌友 · ${level}`
      : !p.connected
        ? `暂离，${level} AI 托管中`
        : p.effectiveControl === "AI"
          ? `${level} AI 托管中`
          : "在线";
}

/** Compact seat plate for the 3D table's HUD. */
export function PlayerPlate({
  view: v,
  seat: s,
  className = "",
}: {
  view: MatchView;
  seat: Seat;
  className?: string;
}) {
  const p = v.players[s],
    h = v.hand.seats[s],
    self = s === v.viewerSeat;
  const turn = v.hand.activeSeat === s && v.hand.phase === "SELF_ACTION";
  return (
    <div
      className={`player-plate ${turn ? "turn" : ""} ${className}`}
      data-seat={s}
    >
      <Avatar id={p.avatarId} />
      <span className="wind-badge">{windName(h.seatWind)}</span>
      <span className="player-plate-name">
        {p.displayName}
        <small>
          {self
            ? `你${v.self.desiredControl === "AI" ? `，${seatBotLevel(v, s)} AI 托管中` : ""}${h.riichi !== "NONE" ? "，已立直" : ""}`
            : seatStatus(v, s)}
        </small>
      </span>
      <strong>{p.points.toLocaleString()}</strong>
      {h.riichi !== "NONE" && <b className="riichi-label">立直</b>}
    </div>
  );
}
