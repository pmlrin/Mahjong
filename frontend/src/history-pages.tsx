import { Avatar } from "./Avatar";
import React, { useEffect, useState } from "react";
import { api } from "./api";
import {
  botLevelLabel,
  type BotLevel,
} from "../../shared/types";
import type {
  HistorySummary,
  HistoryPage,
  MatchStats,
  MatchFormat,
  MatchMode,
} from "../../shared/types";
export const formatName = (f: string) =>
  f === "HANCHAN" ? "半庄战" : "东风战";
const modeName = (m: string) => (m === "AI_PRACTICE" ? "AI 练习" : "好友场");
const botName = (level: string | null | undefined) =>
  `${botLevelLabel(level as BotLevel | null)} AI`;
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
function Filters({
  format,
  mode,
  onFormat,
  onMode,
}: {
  format: string;
  mode: string;
  onFormat: (s: string) => void;
  onMode: (s: string) => void;
}) {
  return (
    <div className="history-filters">
      <select
        aria-label="赛制"
        value={format}
        onChange={(e) => onFormat(e.target.value)}
      >
        <option value="">全部赛制</option>
        <option value="EAST_ONLY">东风战</option>
        <option value="HANCHAN">半庄战</option>
      </select>
      <select
        aria-label="场次"
        value={mode}
        onChange={(e) => onMode(e.target.value)}
      >
        <option value="">全部场次</option>
        <option value="FRIENDS">好友场</option>
        <option value="AI_PRACTICE">AI 练习</option>
      </select>
    </div>
  );
}
function Summary({ format, mode }: { format: string; mode: string }) {
  const [data, setData] = useState<MatchStats | null>(null);
  useEffect(() => {
    let valid = true;
    setData(null);
    api<MatchStats>(
      "/stats?" +
        new URLSearchParams({
          ...(mode ? { mode } : {}),
          ...(format ? { format } : {}),
        }),
    )
      .then((d) => valid && setData(d))
      .catch(() => {});
    return () => {
      valid = false;
    };
  }, [format, mode]);
  if (!data || !data.count) return null;
  const rate = (x: number | null) =>
    x === null ? "—" : `${(x * 100).toFixed(1)}%`;
  return (
    <section className="history-summary" aria-label="近 30 天">
      <div className="stats-grid">
        {[
          ["近 30 天", `${data.count} 场`],
          ["一位率", rate(data.firstPlaceRate)],
          [
            "平均顺位",
            data.averageRank === null ? "—" : data.averageRank.toFixed(2),
          ],
          [
            "平均得失",
            data.averageNetPoints === null
              ? "—"
              : signed(Math.round(data.averageNetPoints)),
          ],
        ].map(([label, value]) => (
          <article key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <p className="muted">
        {data.distribution
          .map((d) => `${["一", "二", "三", "四"][d.rank - 1]}位 ${d.count} 场`)
          .join("，")}
      </p>
    </section>
  );
}
export function History({
  userId,
  onReplay,
}: {
  userId: string;
  onReplay: (id: string, handId?: string) => void;
}) {
  const [format, setFormat] = useState(""),
    [mode, setMode] = useState(""),
    [items, setItems] = useState<HistorySummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<HistorySummary | null>(null),
    [err, setErr] = useState(""),
    [loading, setLoading] = useState(false);
  const query = new URLSearchParams({
    ...(format ? { format } : {}),
    ...(mode ? { mode } : {}),
  }).toString();
  useEffect(() => {
    let valid = true;
    setLoading(true);
    setErr("");
    setDetail(null);
    api<HistoryPage>("/history?" + query)
      .then((p) => {
        if (valid) {
          setItems(p.items);
          setCursor(p.nextCursor);
        }
      })
      .catch((e) => {
        if (valid) setErr(e.message);
      })
      .finally(() => {
        if (valid) setLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [query]);
  async function next() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const p = await api<HistoryPage>(
        "/history?" + query + "&cursor=" + encodeURIComponent(cursor),
      );
      setItems((old) => [...old, ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function open(id: string) {
    try {
      setDetail(await api<HistorySummary>("/matches/" + id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <main className="history-page">
      <h1>{detail ? "这一场" : "战绩"}</h1>
      <p className="page-sub">每一桌，都有来处</p>
      {err && <p role="alert">{err}</p>}
      {detail ? (
        <>
          <button className="text-button" onClick={() => setDetail(null)}>
            返回战绩
          </button>
          <p className="meta-row">
            <span>{new Date(detail.finishedAt).toLocaleString()}</span>
            <span>{formatName(detail.format)}</span>
            <span>{modeName(detail.mode)}</span>
            <span>
              {detail.status === "ABORTED" ? "意外中止，不计入战绩" : "已终了"}
            </span>
          </p>
          <div className="score-table">
            {[...detail.members]
              .sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9))
              .map((p) => (
                <div key={p.seat}>
                  <span>
                    {p.rank === null
                      ? "—"
                      : `${["一", "二", "三", "四"][p.rank - 1]}位`}
                  </span>
                  <b>
                    <Avatar id={p.avatarId} />
                    {p.displayName}
                    {p.userId === userId ? "（你）" : ""}
                  </b>
                  <span>
                    {p.participantKind === "BOT" ? botName(p.botLevel) : ""}
                  </span>
                  <strong>{p.points.toLocaleString()}</strong>
                  <span>
                    {detail.status === "FINISHED"
                      ? signed(p.netPoints)
                      : "中止时"}
                  </span>
                </div>
              ))}
          </div>
          {detail.replayAvailable ? (
            <button
              className="primary"
              onClick={() => onReplay(detail.matchId)}
            >
              看牌谱
            </button>
          ) : (
            <p className="muted">
              {detail.status === "ABORTED"
                ? "意外中止的对局没有牌谱"
                : "牌谱已过保存期（30 天）"}
            </p>
          )}
          <h2>每一局</h2>
          <div className="history-list">
            {detail.hands.map((h) => (
              <article key={h.handId}>
                <strong>
                  {
                    (
                      { EAST: "东", SOUTH: "南", WEST: "西" } as Record<
                        string,
                        string
                      >
                    )[h.roundWind]
                  }
                  {h.roundNumber}局，{h.honba}本场
                </strong>
                <p>
                  {h.pointsAfter
                    .map(
                      (p, i) =>
                        `${detail.members[i].displayName} ${p.toLocaleString()}（${signed(h.delta[i])}）`,
                    )
                    .join("，")}
                </p>
                {detail.replayAvailable && (
                  <button
                    className="text-button"
                    onClick={() => onReplay(detail.matchId, h.handId)}
                  >
                    看这一局
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          <Filters
            format={format}
            mode={mode}
            onFormat={setFormat}
            onMode={setMode}
          />
          <Summary format={format} mode={mode} />
          <div className="history-list">
            {items.map((s) => {
              const self = s.members.find((m) => m.userId === userId);
              return (
                <button
                  className="history-card"
                  key={s.matchId}
                  onClick={() => open(s.matchId)}
                >
                  <small className="meta-row">
                    <span>{new Date(s.finishedAt).toLocaleString()}</span>
                    <span>{formatName(s.format)}</span>
                    <span>{modeName(s.mode)}</span>
                  </small>
                  <strong>
                    {s.status === "ABORTED"
                      ? "意外中止"
                      : `${["一", "二", "三", "四"][(self?.rank ?? 1) - 1]}位，${self?.points.toLocaleString()} 点（${signed(self?.netPoints ?? 0)}）`}
                  </strong>
                  <span>
                    {s.members
                      .filter((p) => p.userId !== userId)
                      .map(
                        (p) =>
                          p.displayName +
                          (p.participantKind === "BOT"
                            ? `（${botName(p.botLevel)}）`
                            : ""),
                      )
                      .join("、")}
                  </span>
                </button>
              );
            })}
          </div>
          {!loading && !items.length && (
            <p>这里还空着。打完一场，就会留下记录。</p>
          )}
          {cursor && (
            <button className="secondary" disabled={loading} onClick={next}>
              更早的
            </button>
          )}
          {loading && <p aria-live="polite">正在载入…</p>}
        </>
      )}
    </main>
  );
}
