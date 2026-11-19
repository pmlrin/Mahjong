import React, { useEffect, useState } from "react";
import type {
  MatchFormat,
  MatchQueueStatus,
  PublicLobby,
} from "../../shared/types";
import { Avatar } from "./Avatar";
import { formatName } from "./history-pages";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Random matchmaking: pick a format, wait in the queue, cancel any time. */
export function MatchPanel({
  status,
  disabled,
  formats,
  onStart,
  onCancel,
}: {
  status: MatchQueueStatus | null;
  disabled: boolean;
  formats: MatchFormat[];
  onStart: (format: MatchFormat) => void;
  onCancel: () => void;
}) {
  const [format, setFormat] = useState<MatchFormat>("EAST_ONLY");
  const now = useNow(!!status?.queued);
  if (status?.queued) {
    const fillIn = status.botFillAt === null ? null : status.botFillAt - now;
    return (
      <div className="match-waiting" role="status" aria-live="polite">
        <div className="match-waiting-head">
          <span className="match-pulse" aria-hidden="true" />
          <strong>正在找牌友</strong>
          <span className="match-clock">{clock(now - status.since!)}</span>
        </div>
        <p>
          {formatName(status.format!)} ·{" "}
          {status.waiting <= 1
            ? "眼下只有你在等，有人来就配上"
            : `${status.waiting} 人在等，凑满四人即开局`}
          {fillIn !== null &&
            status.waiting < 4 &&
            (fillIn > 0
              ? `；${Math.ceil(fillIn / 1000)} 秒后由假想妖补位`
              : "；假想妖正在入座")}
        </p>
        <button className="secondary" onClick={onCancel}>
          不等了
        </button>
      </div>
    );
  }
  return (
    <div className="match-line">
      <select
        aria-label="匹配赛制"
        value={format}
        onChange={(e) => setFormat(e.target.value as MatchFormat)}
      >
        {formats.map((f) => (
          <option key={f} value={f}>
            {formatName(f)}
          </option>
        ))}
      </select>
      <button
        className="secondary"
        disabled={disabled}
        onClick={() => onStart(format)}
      >
        随机匹配
      </button>
    </div>
  );
}

/** Public tables: every online player sees them and may sit down. */
export function PublicTables({
  lobby,
  disabled,
  onJoin,
}: {
  lobby: PublicLobby | null;
  disabled: boolean;
  onJoin: (roomId: string) => void;
}) {
  return (
    <section className="public-tables" aria-labelledby="public-tables-title">
      <div className="public-tables-head">
        <h2 id="public-tables-title">公共牌桌</h2>
        {lobby && <span className="muted">此刻 {lobby.online} 人在线</span>}
      </div>
      {!lobby ? (
        <p className="muted">正在看看大厅里有哪几桌…</p>
      ) : !lobby.rooms.length ? (
        <p className="muted public-empty">
          大厅里还没有公开的牌桌。开桌时勾上“公开到大厅”，路过的人就能坐下。
        </p>
      ) : (
        <ul className="public-list">
          {lobby.rooms.map((r) => {
            const host = r.seats.find((s) => s?.host);
            const humans = r.seats.filter(
              (s) => s?.participantKind === "HUMAN",
            ).length;
            return (
              <li key={r.roomId} className="public-room">
                <div className="public-room-title">
                  <strong>{host?.displayName ?? "牌友"} 的牌桌</strong>
                  <span>{formatName(r.format)}</span>
                </div>
                <div className="public-seats" aria-label={`${humans} 人已入座`}>
                  {r.seats.map((s, i) => (
                    <span
                      key={i}
                      className={`public-seat ${s ? s.participantKind.toLowerCase() : "empty"}`}
                      title={
                        s
                          ? s.participantKind === "BOT"
                            ? `${s.displayName}（假想妖，来人即让座）`
                            : s.displayName
                          : "空座"
                      }
                    >
                      {s ? (
                        s.participantKind === "BOT" ? (
                          "妖"
                        ) : (
                          <Avatar id={s.avatarId} label={s.displayName} />
                        )
                      ) : (
                        ""
                      )}
                    </span>
                  ))}
                </div>
                <span className="public-open">还能坐 {r.openSeats} 人</span>
                <button
                  className="primary"
                  disabled={disabled}
                  onClick={() => onJoin(r.roomId)}
                >
                  入座
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
