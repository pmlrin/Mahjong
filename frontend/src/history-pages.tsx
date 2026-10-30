import React, { useEffect, useState } from "react";
import { api } from "./api";
import type {
  HistorySummary,
  HistoryPage,
  MatchStats,
  MatchFormat,
  MatchMode,
} from "../../shared/types";
export const formatName = (f: string) =>
  f === "HANCHAN" ? "半庄战" : "东风战";
const modeName = (m: string) =>
  m === "AI_PRACTICE" ? "AI 练习" : "多人好友场";
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
function Filters({
  format,
  mode,
  onFormat,
  onMode,
  all = true,
}: {
  format: string;
  mode: string;
  onFormat: (s: string) => void;
  onMode: (s: string) => void;
  all?: boolean;
}) {
  return (
    <div className="history-filters">
      <label>
        赛制{" "}
        <select value={format} onChange={(e) => onFormat(e.target.value)}>
          <option value="">全部赛制</option>
          <option value="EAST_ONLY">东风战</option>
          <option value="HANCHAN">半庄战</option>
        </select>
      </label>
      <label>
        模式{" "}
        <select value={mode} onChange={(e) => onMode(e.target.value)}>
          {all && <option value="">全部模式</option>}
          <option value="AI_PRACTICE">AI 练习</option>
          <option value="FRIENDS">多人好友场</option>
        </select>
      </label>
    </div>
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
      <div className="eyebrow">每一桌，都有来处</div>
      <h1>{detail ? "比赛详情" : "历史战绩"}</h1>
      <p className="muted">
        战绩绑定当前游客身份。清除浏览器会话后无法凭昵称找回。牌谱至少保存 30
        天。
      </p>
      {err && <p role="alert">{err}</p>}
      {detail ? (
        <>
          <button className="text-button" onClick={() => setDetail(null)}>
            ← 返回战绩
          </button>
          <p>
            {new Date(detail.finishedAt).toLocaleString()} ·{" "}
            {formatName(detail.format)} · {modeName(detail.mode)} ·{" "}
            {detail.status === "ABORTED" ? "技术中止，不计入统计" : "已结束"}
          </p>
          <div className="score-table">
            {[...detail.members]
              .sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9))
              .map((p) => (
                <div key={p.seat}>
                  <span>{p.rank === null ? "—" : `第 ${p.rank} 名`}</span>
                  <b>
                    {p.displayName}
                    {p.userId === userId ? "（你）" : ""}
                  </b>
                  <span>
                    {p.participantKind === "BOT"
                      ? `${p.botLevel === "BASIC" ? "基础" : "标准"} AI · ${p.botPolicyVersion}`
                      : "真人"}
                  </span>
                  <strong>{p.points.toLocaleString()}</strong>
                  <span>
                    {detail.status === "FINISHED"
                      ? signed(p.netPoints)
                      : "中止时点数"}
                  </span>
                </div>
              ))}
          </div>
          {detail.replayAvailable ? (
            <button
              className="primary"
              onClick={() => onReplay(detail.matchId)}
            >
              查看完整牌谱 →
            </button>
          ) : (
            <p className="muted">
              {detail.status === "ABORTED"
                ? "技术中止场不提供完整回放"
                : "牌谱已过保存期"}
            </p>
          )}
          <h2>逐局结果</h2>
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
                  {h.roundNumber}局 · {h.honba}本场
                </strong>
                <p>
                  {h.pointsAfter
                    .map(
                      (p, i) =>
                        `${detail.members[i].displayName} ${p.toLocaleString()}（${signed(h.delta[i])}）`,
                    )
                    .join(" / ")}
                </p>
                {detail.replayAvailable && (
                  <button
                    className="text-button"
                    onClick={() => onReplay(detail.matchId, h.handId)}
                  >
                    回看这一局 →
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
          <div className="history-list">
            {items.map((s) => {
              const self = s.members.find((m) => m.userId === userId);
              return (
                <button
                  className="history-card"
                  key={s.matchId}
                  onClick={() => open(s.matchId)}
                >
                  <small>
                    {new Date(s.finishedAt).toLocaleString()} ·{" "}
                    {formatName(s.format)} · {modeName(s.mode)}
                  </small>
                  <strong>
                    {s.status === "ABORTED"
                      ? "技术中止"
                      : `第 ${self?.rank} 名 · ${self?.points.toLocaleString()} 点（${signed(self?.netPoints ?? 0)}）`}
                  </strong>
                  <span>
                    {s.members
                      .filter((p) => p.userId !== userId)
                      .map(
                        (p) =>
                          p.displayName +
                          (p.participantKind === "BOT"
                            ? ` · ${p.botLevel === "BASIC" ? "基础" : "标准"} AI`
                            : ""),
                      )
                      .join(" / ")}
                  </span>
                  <span>查看详情 →</span>
                </button>
              );
            })}
          </div>
          {!loading && !items.length && (
            <p>还没有符合条件的比赛。完成一场后，这里会留下记录。</p>
          )}
          {cursor && (
            <button className="secondary" disabled={loading} onClick={next}>
              继续加载 20 场
            </button>
          )}
          {loading && <p aria-live="polite">正在读取战绩…</p>}
        </>
      )}
    </main>
  );
}
export function Stats() {
  const [format, setFormat] = useState(""),
    [mode, setMode] = useState("FRIENDS"),
    [data, setData] = useState<MatchStats | null>(null),
    [err, setErr] = useState("");
  useEffect(() => {
    let valid = true;
    setData(null);
    api<MatchStats>(
      "/stats?" + new URLSearchParams({ mode, ...(format ? { format } : {}) }),
    )
      .then((d) => {
        if (valid) {
          setData(d);
          setErr("");
        }
      })
      .catch((e) => {
        if (valid) setErr(e.message);
      });
    return () => {
      valid = false;
    };
  }, [format, mode]);
  const rate = (x: number | null) =>
    x === null ? "暂无数据" : `${(x * 100).toFixed(1)}%`;
  return (
    <main className="history-page">
      <div className="eyebrow">看见自己的步调</div>
      <h1>我的统计</h1>
      <Filters
        format={format}
        mode={mode}
        onFormat={setFormat}
        onMode={setMode}
        all={false}
      />
      {err && <p role="alert">{err}</p>}
      {data ? (
        <>
          <p>
            最近 30 天 · {new Date(data.from).toLocaleDateString()} —{" "}
            {new Date(data.to).toLocaleDateString()} · 样本 {data.count} 场
          </p>
          <div className="stats-grid">
            {[
              ["有效场数", data.count],
              ["一位率", rate(data.firstPlaceRate)],
              [
                "平均顺位",
                data.averageRank === null
                  ? "暂无数据"
                  : data.averageRank.toFixed(2),
              ],
              [
                "平均净得失",
                data.averageNetPoints === null
                  ? "暂无数据"
                  : signed(Math.round(data.averageNetPoints)),
              ],
            ].map(([label, value]) => (
              <article key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
          <h2>名次分布</h2>
          <div className="rank-bars">
            {data.distribution.map((d) => (
              <div key={d.rank}>
                <span>第 {d.rank} 名</span>
                <progress max="1" value={d.rate ?? 0} />
                <span>
                  {d.count} 场 · {rate(d.rate)}
                </span>
              </div>
            ))}
          </div>
          <p className="muted">
            仅计入正常结束的比赛；技术中止、进行中和内部模拟不计入。掉线托管仍按开场时的模式统计。
          </p>
        </>
      ) : (
        <p>正在读取统计…</p>
      )}
    </main>
  );
}
