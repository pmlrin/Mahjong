import React, { useEffect, useState } from "react";
import {
  tileName,
  type MatchView,
  type Frame,
  type Result,
} from "../../shared/types";
import { Avatar } from "./Avatar";
import { Tile } from "./Tile";
import { TableSurface } from "./TableSurface";
import { CallChoices, ResponseSource } from "./turn-feedback";
import { responseTarget } from "../../shared/game-feedback";
import { formatName } from "./history-pages";
import { useTableActions } from "./use-table-actions";
import type { TableContext } from "./table-actions";
export const actionNames: Record<string, string> = {
  DISCARD: "打出",
  RIICHI_DISCARD: "立直并打出",
  TSUMO: "自摸",
  RON: "荣和",
  PASS: "过",
  PON: "碰",
  CHI: "吃",
  ANKAN: "暗杠",
  KAKAN: "加杠",
  DAIMINKAN: "明杠",
  ABORT_KYUUSHU: "九种九牌",
};
export const resultNames: Record<string, string> = {
  TSUMO: "自摸",
  RON: "荣和",
  EXHAUSTIVE_DRAW: "荒牌流局",
  NAGASHI_MANGAN: "流局满贯",
  ABORT_KYUUSHU: "九种九牌",
  ABORT_FOUR_WINDS: "四风连打",
  ABORT_FOUR_RIICHI: "四家立直",
  ABORT_FOUR_KANS: "四杠散了",
  ABORT_TRIPLE_RON: "三家和",
};
const endNames: Record<string, string> = {
  BANKRUPTCY: "飞人终局",
  DEALER_AGARI_YAME: "庄家和了止",
  DEALER_TENPAI_YAME: "庄家听牌止",
  SCHEDULE_COMPLETE: "计划赛程结束",
  EXTENSION_TARGET_REACHED: "延长达到目标点数",
  EXTENSION_HARD_LIMIT: "延长场结束",
};
const wind = (w: string) =>
  ({ EAST: "东", SOUTH: "南", WEST: "西", NORTH: "北" })[w] ?? w;
export function Game({
  view: v,
  frame,
  network,
  binding,
  userId,
  identity,
  authorized,
  emit,
  setError,
  onNew,
  onRematch,
  onReplay,
}: {
  view: MatchView;
  userId: string;
  identity: string;
  authorized: (context: TableContext) => boolean;
  frame: Frame;
  network: boolean;
  binding: string;
  emit: (e: string, p: any, id?: string) => Promise<any>;
  setError: (s: string) => void;
  onNew: () => void;
  onRematch?: () => void;
  onReplay: () => void;
}) {
  const controls = useTableActions({
    frame,
    network,
    binding,
    userId,
    identity,
    authorized,
    emit,
    setError,
  });
  const a = controls.actions;
  const { selected, riichi, modal, pending } = a;
  const can = a.can,
    d = v.self.decision,
    options = d?.options ?? [];
  const [now, setNow] = useState(performance.now()),
    [details, setDetails] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const time = d ? Math.max(0, Math.ceil(a.remaining() / 1000)) : null;
  const selectedOption = a.selectedOption;
  const hand = v.hand,
    self = v.viewerSeat,
    finished = hand.phase === "MATCH_RESULT";
  const own = hand.seats[self];
  const tiles = v.self.concealedTiles;
  const unique = [
    ...new Set(
      options
        .filter((o) => !["DISCARD", "RIICHI_DISCARD"].includes(o.type))
        .map((o) => o.type),
    ),
  ];
  const target = responseTarget(v);
  const availableResponses = [
    ...new Set(
      options
        .filter((o) => ["CHI", "PON", "DAIMINKAN", "RON"].includes(o.type))
        .map((o) => actionNames[o.type]),
    ),
  ];
  const actionPrompt =
    v.status === "ABORTED"
      ? "本场因技术原因中止"
      : pending || d?.submittedRequestId
        ? "已提交，等待裁决"
        : d?.owner === "AI"
          ? "AI 正在思考…"
          : d?.disabledReason === "CONTROL_PENDING"
            ? "将在下个操作窗口恢复人工"
            : can
              ? hand.phase === "SELF_ACTION"
                ? riichi
                  ? "选择立直弃牌"
                  : a.quick
                    ? "单击即出牌；键盘选择后按 Enter"
                    : "选择一张牌，再点击打出"
                : `你可以${availableResponses.join("、")}，或选择过牌`
              : hand.phase === "HAND_RESULT"
                ? "本局已结束"
                : hand.phase === "SELF_ACTION" && hand.activeSeat !== null
                  ? `${v.players[hand.activeSeat].displayName}${v.players[hand.activeSeat].effectiveControl === "AI" ? "正在思考…" : "正在选择出牌…"}`
                  : "等待其他玩家响应…";
  return (
    <main className="play-page">
      <div className="game-topline" inert={!!modal}>
        <span>
          <span
            className={`status-dot ${network ? "on" : ""}`}
            aria-hidden="true"
          />
          {network ? "牌桌已连接" : "正在重连，当前操作时间仍会继续"}
        </span>
        <span>{formatName(v.format)}，四人立直</span>
        <button
          className="text-button"
          onClick={() => {
            a.suspend("控制权正在切换，自动操作已关闭");
            emit("game:control", {
              matchId: v.matchId,
              bindingId: binding,
              mode: v.self.desiredControl === "AI" ? "HUMAN" : "AI",
            })
              .catch((e) => setError(e.message))
              .finally(() => a.resume());
          }}
        >
          {v.self.desiredControl === "AI" ? "恢复人工" : "交给 AI 托管"}
        </button>
      </div>
      <div className="portrait-hint">转为横屏，牌桌看得更清楚</div>
      {v.status === "ABORTED" && (
        <div className="takeover">
          <p>本场因技术原因中止，不计入有效战绩。请另开一桌继续。</p>
          <button className="primary" onClick={onNew}>
            创建新房间
          </button>
        </div>
      )}
      <div inert={!!modal}>
        <TableSurface view={v} />
      </div>
      <section
        className="hand-panel"
        inert={!!modal}
        ref={controls.region}
        tabIndex={-1}
        aria-label="牌桌操作区域"
        onKeyDownCapture={controls.keydown}
      >
        <div className="hand-rack">
          <div className="action-row">
            <div className="action-hint">
              {target && d ? (
                <ResponseSource source={target} prompt={actionPrompt} />
              ) : (
                actionPrompt
              )}
              {Object.values(v.self.furiten).some(Boolean) && (
                <span className="furiten">振听：不可荣和，可有役自摸</span>
              )}
            </div>
            <div className="action-buttons">
              {time !== null && (
                <span className={`countdown ${time <= 5 ? "urgent" : ""}`}>
                  {time}
                  <small>秒</small>
                </span>
              )}
              {options.some((o) => o.type === "RIICHI_DISCARD") && (
                <button
                  className={`secondary ${riichi ? "chosen" : ""}`}
                  disabled={!can}
                  onClick={() => a.toggleRiichi()}
                >
                  立直
                </button>
              )}
              {unique.map((type) => (
                <button
                  key={type}
                  className={
                    type === "RON" || type === "TSUMO"
                      ? "primary win-button"
                      : "secondary"
                  }
                  disabled={
                    !can ||
                    (a.noCall && ["CHI", "PON", "DAIMINKAN"].includes(type))
                  }
                  title={
                    a.noCall && ["CHI", "PON", "DAIMINKAN"].includes(type)
                      ? "请先关闭不鸣牌"
                      : undefined
                  }
                  onClick={() => (type === "PASS" ? a.pass() : a.open([type]))}
                >
                  {actionNames[type]}
                </button>
              ))}
              {options.some((o) => o.type === "DISCARD") && (
                <button
                  className="primary discard-button"
                  disabled={!can || !selectedOption}
                  onClick={() => a.confirm()}
                >
                  {riichi ? "立直并打出" : "打出"}
                </button>
              )}
            </div>
          </div>
          <div className="own-hand">
            {tiles.map((t) => (
              <Tile
                key={t}
                tile={t}
                selected={selected === t}
                disabled={
                  !can ||
                  !options.some(
                    (o) =>
                      o.type === (riichi ? "RIICHI_DISCARD" : "DISCARD") &&
                      o.tile === t,
                  )
                }
                onPointerDown={(e) => controls.tilePointerDown(e, t)}
                onClick={(e) => controls.tileClick(e, t)}
              />
            ))}
            {v.self.drawnTile !== null && (
              <Tile
                tile={v.self.drawnTile}
                selected={selected === v.self.drawnTile}
                disabled={
                  !can ||
                  !options.some(
                    (o) =>
                      o.type === (riichi ? "RIICHI_DISCARD" : "DISCARD") &&
                      o.tile === v.self.drawnTile,
                  )
                }
                onPointerDown={(e) =>
                  controls.tilePointerDown(e, v.self.drawnTile!)
                }
                onClick={(e) => controls.tileClick(e, v.self.drawnTile!)}
                mark
              />
            )}
          </div>
          <div className="hand-footer">
            <span>
              {own.riichi === "ESTABLISHED"
                ? "立直后只能摸切，或选择合法和牌与暗杠"
                : a.quick
                  ? "单击即出牌，立直选牌后确认"
                  : "点选手牌，点击打出"}
            </span>
            <span>
              {wind(own.seatWind)}家 / {hand.handIndex} 次配牌
            </span>
          </div>
        </div>
        <div
          className={`auto-status ${a.autoDiscard || a.noCall ? "enabled" : ""}`}
        >
          <span role="status" aria-live="polite">
            {a.autoStatus}
          </span>
          {(a.autoDiscard || a.noCall) && (
            <>
              <button
                className="secondary"
                onClick={() => a.intervene()}
                disabled={!can}
              >
                本次手动
              </button>
              <button className="text-button" onClick={() => a.stopAutomatic()}>
                停止自动操作
              </button>
            </>
          )}
          {a.lock?.status === "unknown" && (
            <button
              className="secondary"
              disabled={!network || !a.fresh}
              onClick={() => a.recover(true)}
            >
              查询／恢复原动作
            </button>
          )}
          {!a.fresh && network && (
            <button className="text-button" onClick={() => a.synchronize(true)}>
              重新同步
            </button>
          )}
        </div>
        <div className="table-controls" aria-label="牌桌操作设置">
          <label>
            <input
              type="checkbox"
              checked={a.quick}
              onChange={(e) => controls.preference("quick", e.target.checked)}
            />
            快速出牌 {a.quick && <small>单击即出牌</small>}
          </label>
          <label title="立即对本次行动生效，等待 500 毫秒。可能放弃本次立直机会；和牌、杠等选择暂停。">
            <input
              type="checkbox"
              checked={a.autoDiscard}
              disabled={
                !a.autoDiscard &&
                (!a.fresh ||
                  !network ||
                  !binding ||
                  v.self.desiredControl !== "HUMAN" ||
                  v.players[self].effectiveControl !== "HUMAN" ||
                  d?.owner === "AI" ||
                  d?.disabledReason === "CONTROL_PENDING" ||
                  v.status !== "RUNNING" ||
                  pending)
              }
              onChange={(e) => a.setAutomatic("discard", e.target.checked)}
            />
            自动摸切
          </label>
          <label title="立即对本次响应生效，等待 500 毫秒；不吃、不碰、不明杠；仍提示荣和。">
            <input
              type="checkbox"
              checked={a.noCall}
              disabled={
                !a.noCall &&
                (!a.fresh ||
                  !network ||
                  !binding ||
                  v.self.desiredControl !== "HUMAN" ||
                  v.players[self].effectiveControl !== "HUMAN" ||
                  d?.owner === "AI" ||
                  d?.disabledReason === "CONTROL_PENDING" ||
                  v.status !== "RUNNING" ||
                  pending)
              }
              onChange={(e) => a.setAutomatic("noCall", e.target.checked)}
            />
            不鸣牌 <small>仍提示荣和</small>
          </label>
          <label>
            <input
              type="checkbox"
              checked={a.keyboard}
              onChange={(e) =>
                controls.preference("keyboard", e.target.checked)
              }
            />
            启用键盘操作
          </label>
          <button
            className="text-button"
            onClick={() => controls.region.current?.focus()}
          >
            聚焦牌桌
          </button>
        </div>
        {controls.quickHelp && (
          <div className="operation-help" role="status">
            快速出牌：单击或轻触即提交普通弃牌，已提交不能撤销；立直仍需选牌后确认。
            <button
              className="text-button"
              onClick={controls.closeQuickHelp}
              aria-label="关闭快速出牌说明"
            >
              知道了
            </button>
          </div>
        )}
        <p className="operation-help">
          自动摸切：立即对本次行动生效，等待 500
          毫秒；可能放弃立直机会。和牌、杠等选择暂停。不鸣牌：不吃、不碰、不明杠，仍提示荣和。
        </p>
        {a.keyboard && (
          <p className="operation-help">
            聚焦后：← → / Home End 选牌，Enter 确认；R 立直，C 吃，P 碰，K 杠，W
            和牌，Space 过，Esc 取消。键盘始终选牌后确认。
          </p>
        )}
        {controls.storageWarning && (
          <p role="status">{controls.storageWarning}</p>
        )}
      </section>
      {modal && (
        <div className="modal-shade action-modal-shade">
          <section
            className="modal action-modal"
            ref={controls.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="action-modal-title"
            tabIndex={-1}
            onKeyDownCapture={controls.keydown}
            onKeyDown={controls.dialogKeydown}
          >
            <button
              className="close"
              data-cancel
              aria-label="取消当前操作"
              onClick={() => a.escape()}
            >
              ×
            </button>
            <h2 id="action-modal-title">
              {modal.passRon
                ? "确认放弃荣和？"
                : `选择${[...new Set(modal.options.map((o) => actionNames[o.type]))].join("／")}方案`}
            </h2>
            {time !== null && (
              <span
                className={`call-window-time ${time <= 3 ? "urgent" : ""}`}
                role="timer"
              >
                剩余 {time} 秒
              </span>
            )}
            {modal.passRon ? (
              <>
                <p>
                  放弃合法荣和可能产生同巡振听或立直后振听，由服务器按规则计算。
                </p>
                <button
                  className="secondary"
                  data-cancel="ron"
                  onClick={() => a.escape()}
                >
                  取消，保留荣和
                </button>
                <button
                  className="primary"
                  disabled={!can}
                  onClick={() => a.confirm()}
                >
                  确认放弃荣和并过牌
                </button>
              </>
            ) : (
              <>
                {target && (
                  <ResponseSource
                    source={target}
                    prompt="确认后提交，取消不等于过牌"
                  />
                )}
                {!target && modal.options.some((o) => o.type === "TSUMO") && (
                  <p className="call-target">
                    本人{v.self.drawSource === "RINSHAN" ? "岭上摸牌" : "摸牌"}
                    自摸：
                    {v.self.drawnTile !== null && (
                      <Tile tile={v.self.drawnTile} small />
                    )}
                  </p>
                )}

                {target &&
                modal.options.every((o) =>
                  ["CHI", "PON", "DAIMINKAN"].includes(o.type),
                ) &&
                new Set(modal.options.map((o) => o.type)).size === 1 ? (
                  <CallChoices
                    type={modal.options[0].type}
                    target={target}
                    options={modal.options}
                    disabled={!can}
                    activeIndex={modal.index}
                    onConfirm={(o) => {
                      modal.index = modal.options.indexOf(o);
                      a.confirm();
                    }}
                  />
                ) : (
                  <div className="call-options">
                    {modal.options.map((o, i) => (
                      <button
                        className={`secondary ${i === modal.index ? "chosen" : ""}`}
                        key={o.optionId}
                        disabled={!can}
                        aria-label={`确认${actionNames[o.type]}${(o.consumedTiles ?? o.tiles ?? (o.tile === undefined ? [] : [o.tile])).map(tileName).join("、")}`}
                        onClick={() => {
                          modal.index = i;
                          a.confirm();
                        }}
                      >
                        <strong>{actionNames[o.type]}</strong>
                        {(
                          o.consumedTiles ??
                          o.tiles ??
                          (o.tile === undefined ? [] : [o.tile])
                        ).map((t) => (
                          <Tile key={t} tile={t} small />
                        ))}
                        <span>确认{actionNames[o.type]}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="text-button"
                  data-cancel
                  onClick={() => a.escape()}
                >
                  取消本次选择
                </button>
              </>
            )}
          </section>
        </div>
      )}
      {hand.phase === "HAND_RESULT" && v.lastHandResult && (
        <div className="modal-shade result-shade">
          <section className="modal result-modal">
            <h2>
              {resultNames[v.lastHandResult.reason] ?? v.lastHandResult.reason}
            </h2>
            <p className="modal-sub">这一局，落定</p>
            <HandResult
              result={v.lastHandResult}
              view={v}
              details={details}
              setDetails={setDetails}
            />
            <p className="auto-next">
              {v.matchResult ? "即将显示整场成绩" : "下一局即将开始"}，{" "}
              {Math.max(
                0,
                Math.ceil(
                  ((hand.resultDisplayUntil ?? 0) - a.serverNow()) / 1000,
                ),
              )}{" "}
              秒
            </p>
          </section>
        </div>
      )}
      {finished && v.matchResult && (
        <div className="modal-shade">
          <section className="modal final-modal">
            <h2>本场结算</h2>
            <p className="modal-sub">一场好时光，感谢同桌</p>
            <p className="muted">{endNames[v.matchResult.reason]}</p>
            <div className="rankings">
              {[...v.players]
                .sort(
                  (a, b) =>
                    v.matchResult!.ranks[a.seat] - v.matchResult!.ranks[b.seat],
                )
                .map((p) => (
                  <div
                    key={p.seat}
                    className={p.seat === self ? "is-self" : ""}
                  >
                    <span className="rank">
                      0{v.matchResult!.ranks[p.seat]}
                    </span>
                    <span>
                      <Avatar id={p.avatarId} /> {p.displayName}
                      {p.seat === self ? "（你）" : ""}
                    </span>
                    <strong>{p.points.toLocaleString()}</strong>
                    <small>
                      {p.points >= 25000 ? "+" : ""}
                      {(p.points - 25000).toLocaleString()}
                    </small>
                  </div>
                ))}
            </div>
            <div className="final-actions">
              <button className="secondary" onClick={onReplay}>
                回看本场牌谱
              </button>
              {onRematch ? (
                <button className="primary" onClick={onRematch}>
                  同桌再战
                </button>
              ) : (
                <p>等待房主发起同桌再战</p>
              )}
              <button className="text-button" onClick={onNew}>
                另开一桌
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
function HandResult({
  result: r,
  view: v,
  details,
  setDetails,
}: {
  result: Result;
  view: MatchView;
  details: boolean;
  setDetails: (b: boolean) => void;
}) {
  return (
    <>
      {r.wins.map((w) => (
        <div className="win-detail" key={w.winnerSeat}>
          <h3>
            {v.players[w.winnerSeat].displayName}{" "}
            <small>
              {w.method === "TSUMO"
                ? "自摸"
                : w.method === "RON"
                  ? `荣和，${v.players[w.sourceSeat!].displayName} 放铳`
                  : "流局满贯"}
            </small>
          </h3>
          <div className="reveal-tiles">
            {r.revealedHands
              .find((h) => h.seat === w.winnerSeat)
              ?.concealedTiles.map((t) => (
                <Tile key={t} tile={t} small />
              ))}
            {w.winningTile !== null && <Tile tile={w.winningTile} mark small />}
          </div>
          <div className="yaku-list">
            {w.yaku.map((y, i) => (
              <span key={i}>
                {y.name}{" "}
                <b>
                  {y.yakumanMultiplier
                    ? `${y.yakumanMultiplier} 倍役满`
                    : `${y.han} 番`}
                </b>
              </span>
            ))}
          </div>
          <div className="score-summary">
            {w.yakumanMultiplier
              ? `${w.yakumanMultiplier} 倍役满`
              : w.fu === null
                ? "满贯"
                : `${w.han} 番 ${w.fu} 符`}{" "}
            <small>
              <span>宝牌 {w.dora.omote}</span>
              <span>赤 {w.dora.aka}</span>
              <span>里 {w.dora.ura}</span>
            </small>
          </div>
        </div>
      ))}
      {r.tenpaiSeats && (
        <p>
          {r.tenpaiSeats.length
            ? r.tenpaiSeats.map((s) => v.players[s].displayName).join("、") +
              " 听牌"
            : "四家未听"}
        </p>
      )}
      <div className="result-points">
        {v.players.map((p) => (
          <div key={p.seat}>
            <small>{p.displayName}</small>
            <b
              className={
                r.delta[p.seat] > 0
                  ? "positive"
                  : r.delta[p.seat] < 0
                    ? "negative"
                    : ""
              }
            >
              {r.delta[p.seat] > 0 ? "+" : ""}
              {r.delta[p.seat].toLocaleString()}
            </b>
            <span>{r.pointsAfter[p.seat].toLocaleString()}</span>
          </div>
        ))}
      </div>
      <button className="text-button" onClick={() => setDetails(!details)}>
        {details ? "收起" : "查看"}支付明细 {details ? "−" : "＋"}
      </button>
      {details && (
        <div className="ledger">
          {r.transfers.map((t) => (
            <p key={t.transferId}>
              <span>
                {t.from === "KYOTAKU" ? "供托" : v.players[t.from].displayName}{" "}
                → {t.to === "KYOTAKU" ? "供托" : v.players[t.to].displayName}
              </span>
              <b>{t.amount.toLocaleString()}</b>
              <small>
                {
                  {
                    HAND_VALUE: "和牌",
                    HONBA: "本场",
                    NOTEN: "未听罚符",
                    KYOTAKU_AWARD: "供托",
                    FINAL_KYOTAKU: "终局供托",
                  }[t.reason]
                }
              </small>
            </p>
          ))}
        </div>
      )}
    </>
  );
}
