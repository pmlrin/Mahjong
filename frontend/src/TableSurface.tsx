import { Avatar } from "./Avatar";
import React, { type CSSProperties } from "react";
import { type MatchView, type Seat, tileName } from "../../shared/types";
import { Tile } from "./Tile";
import { Melds } from "./Melds";
import { LatestDiscard } from "./turn-feedback";
import { seatStatus } from "./PlayerPlate";
const wind = (w: string) =>
  ({ EAST: "东", SOUTH: "南", WEST: "西", NORTH: "北" })[w] ?? w;
export function TableSurface({ view: v }: { view: MatchView }) {
  const hand = v.hand,
    self = v.viewerSeat,
    own = hand.seats[self];
  const rows = [0, 1, 2, 3].map((relative) =>
    Math.max(
      3,
      Math.ceil(hand.seats[(self + relative) % 4].discards.length / 6),
    ),
  );
  const layoutStyle = {
    "--rows-0": rows[0],
    "--rows-1": rows[1],
    "--rows-2": rows[2],
    "--rows-3": rows[3],
    "--side-units": (rows[1] + rows[3]) * 1.4,
    "--side-gaps": rows[1] + rows[3] - 2,
  } as CSSProperties;
  function player(relative: number) {
    const s = ((self + relative) % 4) as Seat,
      p = v.players[s],
      h = hand.seats[s];
    return (
      <div
        className={`opponent position-${relative} ${hand.activeSeat === s && hand.phase === "SELF_ACTION" ? "turn" : ""}`}
      >
        <div className="opponent-info">
          <Avatar id={p.avatarId} />
          <span className="wind-badge">{wind(h.seatWind)}</span>
          <span>
            {p.displayName}
            <small>{seatStatus(v, s)}</small>
          </span>
          <strong>{p.points.toLocaleString()}</strong>
          {h.riichi !== "NONE" && <b className="riichi-label">立直</b>}
        </div>
        <div className="opponent-backs">
          {Array.from({ length: h.concealedCount }, (_, i) => (
            <Tile key={i} back small />
          ))}
        </div>
        <Melds melds={h.melds} />
      </div>
    );
  }
  return (
    <section className="game-table table-layout">
      <div className="table-inlay" />
      <div className="table-top">
        {player(2)}
        <LatestDiscard view={v} />
      </div>
      {player(1)}
      {player(3)}
      <div className="table-field">
        <div className="table-grid" style={layoutStyle}>
          <div className="table-center">
            <div className="round-label">
              {wind(hand.roundWind)}
              <strong>{["一", "二", "三", "四"][hand.roundNumber - 1]}</strong>
              局
            </div>
            <div className="round-meta">
              <span>{hand.honba} 本场</span>
              <span>供托 {hand.kyotakuPoints.toLocaleString()}</span>
            </div>
            <div className="wall-count">
              余 <b>{hand.liveWallRemaining}</b> 张
            </div>
            <div className="dora">
              <small>宝牌指示</small>
              {hand.doraIndicators.map((t) => (
                <Tile key={t} tile={t} small />
              ))}
            </div>
            <div className="center-brand">一 桌</div>
          </div>
          {[0, 1, 2, 3].map((relative) => {
            const s = ((self + relative) % 4) as Seat;
            return (
              <div
                key={s}
                className={`river-area river-area-${relative}`}
                style={{ "--rows": rows[relative] } as CSSProperties}
              >
                <div className={`river river-${relative}`}>
                  {hand.seats[s].discards.map((x) => (
                    <span
                      key={x.discardId}
                      className={`${x.riichiDeclaration ? "riichi-tile" : ""} ${x.claimedByMeldId ? "claimed" : ""} ${x.tsumogiri ? "tsumogiri" : ""} ${x.discardId === hand.seats[s].discards.at(-1)?.discardId ? "last-in-river" : ""} ${x.discardId === hand.lastDiscard?.discardId ? "latest-discard" : ""}`}
                      title={`${v.players[s].displayName}打出${tileName(x.tile)} · ${x.tsumogiri ? "摸切" : "手切"}`}
                      aria-current={
                        x.discardId === hand.lastDiscard?.discardId
                          ? "true"
                          : undefined
                      }
                    >
                      <Tile tile={x.tile} small />
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className={`self-info ${hand.activeSeat === self && hand.phase === "SELF_ACTION" ? "turn" : ""}`}>
        <Avatar id={v.players[self].avatarId} />
        <span className="wind-badge">{wind(own.seatWind)}</span>
        <span>
          {v.players[self].displayName}
          <small>你{own.riichi !== "NONE" ? "，已立直" : ""}</small>
        </span>
        <strong>{v.players[self].points.toLocaleString()}</strong>
        <Melds melds={own.melds} />
      </div>
    </section>
  );
}
