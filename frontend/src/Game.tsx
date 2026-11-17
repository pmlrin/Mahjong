import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  tileName,
  AUTOPILOT_BOT_LEVEL,
  botLevelLabel,
  type MatchView,
  type Frame,
  type Result,
} from "../../shared/types";
import { Avatar } from "./Avatar";
import { Tile } from "./Tile";
import { TableView, useTableMode } from "./TableView";
import { createAnchorStore, handTop } from "./hand-anchors";
import { frameEvents } from "./match-events";
import { useReducedMotion } from "./motion";
import { CallStamps, type PlayStep } from "./CallStamps";
import { playEvents, playSound } from "./sounds";
import { RESULT_HOLD, discardLandsAfter } from "./table3d/timing";
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
  BANKRUPTCY: "有人被击飞",
  DEALER_AGARI_YAME: "庄家和牌后收场",
  DEALER_TENPAI_YAME: "庄家听牌后收场",
  SCHEDULE_COMPLETE: "赛程走完",
  EXTENSION_TARGET_REACHED: "延长战有人达到 30,000 点",
  EXTENSION_HARD_LIMIT: "延长战走完",
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
  sound = false,
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
  /** Table sounds are on (the player's setting; off by default). */
  sound?: boolean;
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
  const table = useTableMode(userId);
  // Each step of play, read from what changed since the last view: it drives
  // the stamps and the sounds.
  const heard = useRef(frame);
  const reduce = useReducedMotion();
  const [step, setStep] = useState<PlayStep | null>(null);
  // While a hand's end plays out, its result panel waits (handId held).
  const [held, setHeld] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(holdTimer.current), []);
  useEffect(() => {
    const before = heard.current;
    heard.current = frame;
    if (before === frame) return;
    const events = frameEvents(before, frame);
    // A new hand gives no events (its deal is just shown), but it is heard.
    if (
      sound &&
      events?.length === 0 &&
      before.state.hand.handId !== frame.state.hand.handId
    )
      playSound("deal");
    if (!events?.length) return;
    setStep((s) => ({ id: (s?.id ?? 0) + 1, events }));
    const left = (v.hand.resultDisplayUntil ?? 0) - frame.serverTime;
    if (
      events.some((e) => e.type === "win" || e.type === "draw") &&
      left > RESULT_HOLD.minRemaining * 1000
    ) {
      const id = v.hand.handId;
      setHeld(id);
      clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(
        () => setHeld((h) => (h === id ? null : h)),
        (table.active === "3d" ? RESULT_HOLD.table3d : RESULT_HOLD.flat) * 1000,
      );
    }
    if (!sound) return;
    // On the moving 3D table a discard sounds as the tile lands.
    const flying = table.active === "3d" && !reduce;
    const land = Math.max(
      0,
      ...events.map((e) =>
        e.type === "discard"
          ? discardLandsAfter((e.seat - v.viewerSeat + 4) % 4)
          : 0,
      ),
    );
    playEvents(events, flying ? land : 0);
  }, [frame]);
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
  // 3D own hand: the scene draws it and publishes where each tile sits; the
  // same hand buttons are then laid transparently over those tiles.
  const [anchorStore] = useState(createAnchorStore);
  const anchors = useSyncExternalStore(anchorStore.subscribe, anchorStore.get);
  const overlay = table.active === "3d" && anchors.size > 0;
  const playable = new Set(
    options
      .filter((o) => o.type === (riichi ? "RIICHI_DISCARD" : "DISCARD"))
      .map((o) => o.tile),
  );
  const ownTiles =
    v.self.drawnTile === null ? tiles : [...tiles, v.self.drawnTile];
  const hand3d = {
    selected,
    dim: can ? ownTiles.filter((t) => !playable.has(t)).join(",") : "",
    anchors: anchorStore,
  };
  const place = (t: number): CSSProperties | undefined => {
    const r = overlay ? anchors.get(t) : undefined;
    return r && { left: r.x, top: r.y, width: r.width, height: r.height };
  };
  const stageTop = overlay ? handTop(anchors) : null;
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
      ? "本场意外中止"
      : pending || d?.submittedRequestId
        ? "已出手，静候结果"
        : d?.owner === "AI"
          ? "AI 代你思考…"
          : d?.disabledReason === "CONTROL_PENDING"
            ? "下一手起由你接手"
            : can
              ? hand.phase === "SELF_ACTION"
                ? riichi
                  ? "选一张牌，立直打出"
                  : a.quick
                    ? "轮到你，点一张牌即打出"
                    : "轮到你，选一张牌打出"
                : `你可以${availableResponses.join("、")}，或者过`
              : hand.phase === "HAND_RESULT"
                ? "这一局，落定"
                : hand.phase === "SELF_ACTION" && hand.activeSeat !== null
                  ? `${v.players[hand.activeSeat].displayName}${v.players[hand.activeSeat].effectiveControl === "AI" ? "（AI）" : ""}思考中…`
                  : "静候他家应答…";
  return (
    <main className="play-page">
      <div className="game-topline" inert={!!modal}>
        <span>
          <span
            className={`status-dot ${network ? "on" : ""}`}
            aria-hidden="true"
          />
          {network ? "已连接" : "连接中断，正在重连；计时照常"}
        </span>
        <span>{formatName(v.format)}</span>
        {table.supported && !table.portrait && (
          <button
            className="text-button"
            onClick={() => table.choose(table.active === "3d" ? "flat" : "3d")}
          >
            {table.active === "3d" ? "换成平面牌桌" : "换成 3D 牌桌"}
          </button>
        )}
        <button
          className="text-button"
          onClick={() => {
            a.suspend("托管切换中，自动操作已关闭");
            emit("game:control", {
              matchId: v.matchId,
              bindingId: binding,
              mode: v.self.desiredControl === "AI" ? "HUMAN" : "AI",
            })
              .catch((e) => setError(e.message))
              .finally(() => a.resume());
          }}
        >
          {v.self.desiredControl === "AI"
            ? `收回托管（${botLevelLabel(AUTOPILOT_BOT_LEVEL)} AI 代打中）`
            : `交给 AI 托管（${botLevelLabel(AUTOPILOT_BOT_LEVEL)}）`}
        </button>
      </div>
      <div className="portrait-hint">横过来，牌桌更舒展</div>
      {v.status === "ABORTED" && (
        <div className="takeover">
          <p>本场意外中止，不计入战绩。再开一桌吧。</p>
          <button className="primary" onClick={onNew}>
            再开一桌
          </button>
        </div>
      )}
      {table.failure && (
        <p className="table-fallback-note" role="status">
          {table.failure === "slow"
            ? "这台设备上 3D 牌桌有些吃力，已换成平面牌桌；可在上方换回。"
            : "这台设备显示不了 3D 牌桌，已换成平面牌桌。"}
        </p>
      )}
      <div
        className={`play-stage ${overlay ? "stage-3d" : ""}`}
        style={
          stageTop === null
            ? undefined
            : ({ "--hand-top": `${stageTop}px` } as CSSProperties)
        }
      >
        <div className="table-frame" inert={!!modal}>
          <TableView view={v} table={table} hand={hand3d} />
          <CallStamps step={step} view={v} reasons={resultNames} />
          {held === hand.handId && hand.phase === "HAND_RESULT" && (
            <button className="result-skip" onClick={() => setHeld(null)}>
              查看结算
            </button>
          )}
        </div>
        <section
          className="hand-panel"
          inert={!!modal}
          ref={controls.region}
          tabIndex={-1}
          aria-label="我的手牌"
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
                  <span className="furiten">振听中：不能荣和，可以自摸</span>
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
                        ? "已开启不鸣牌"
                        : undefined
                    }
                    onClick={() =>
                      type === "PASS" ? a.pass() : a.open([type])
                    }
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
                  style={place(t)}
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
                  style={place(v.self.drawnTile)}
                  mark
                />
              )}
            </div>
            <div className="hand-footer">
              <span>
                {own.riichi === "ESTABLISHED"
                  ? "已立直：摸到的牌直接打出，可和牌或暗杠"
                  : "按 ← → 选牌，Enter 打出；R 立直，C 吃，P 碰，K 杠，W 和，空格过"}
              </span>
              <span>你是{wind(own.seatWind)}家</span>
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
                  这一手我来
                </button>
                <button
                  className="text-button"
                  onClick={() => a.stopAutomatic()}
                >
                  全部关闭
                </button>
              </>
            )}
          </div>
          <div className="table-controls" aria-label="牌桌操作设置">
            <label>
              <input
                type="checkbox"
                checked={a.quick}
                onChange={(e) => controls.preference("quick", e.target.checked)}
              />
              快速出牌
            </label>
            <label title="摸到什么打什么；能和、能杠时停下等你">
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
            <label title="他家打牌不吃、不碰、不杠；能荣和时仍会停下">
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
              不鸣牌
            </label>
          </div>
          {controls.quickHelp && (
            <div className="operation-help" role="status">
              快速出牌已开：点一下就打出，不再确认。立直时仍要先选牌。
              <button
                className="text-button"
                onClick={controls.closeQuickHelp}
                aria-label="收起快速出牌说明"
              >
                知道了
              </button>
            </div>
          )}
          {controls.storageWarning && (
            <p role="status">{controls.storageWarning}</p>
          )}
        </section>
      </div>
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
              aria-label="取消"
              onClick={() => a.escape()}
            >
              ×
            </button>
            <h2 id="action-modal-title">
              {modal.passRon
                ? "这张能荣和，确定要过？"
                : `怎么${[...new Set(modal.options.map((o) => actionNames[o.type]))].join("／")}`}
            </h2>
            {time !== null && (
              <span
                className={`call-window-time ${time <= 3 ? "urgent" : ""}`}
                role="timer"
              >
                还剩 {time} 秒
              </span>
            )}
            {modal.passRon ? (
              <>
                <p>过掉之后会进入振听：本巡内（立直后则整局）不能再荣和。</p>
                <button
                  className="secondary"
                  data-cancel="ron"
                  onClick={() => a.escape()}
                >
                  不过，留着荣和
                </button>
                <button
                  className="primary"
                  disabled={!can}
                  onClick={() => a.confirm()}
                >
                  确定过
                </button>
              </>
            ) : (
              <>
                {target && (
                  <ResponseSource
                    source={target}
                    prompt="选好后确认；取消不等于过"
                  />
                )}
                {!target && modal.options.some((o) => o.type === "TSUMO") && (
                  <p className="call-target">
                    {v.self.drawSource === "RINSHAN" ? "岭上开花" : "自摸"}：
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
                  再想想
                </button>
              </>
            )}
          </section>
        </div>
      )}
      {hand.phase === "HAND_RESULT" &&
        v.lastHandResult &&
        held !== hand.handId && (
          <div className="modal-shade result-shade">
            <section className="modal result-modal">
              <h2>
                {resultNames[v.lastHandResult.reason] ??
                  v.lastHandResult.reason}
              </h2>
              <p className="modal-sub">这一局，落定</p>
              <HandResult
                result={v.lastHandResult}
                view={v}
                details={details}
                setDetails={setDetails}
              />
              <p className="auto-next">
                {v.matchResult ? "稍后揭晓全场" : "下一局"}，{" "}
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
            <h2>一场终了</h2>
            <p className="modal-sub">谢谢同桌</p>
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
                看牌谱
              </button>
              {onRematch ? (
                <button className="primary" onClick={onRematch}>
                  再来一场
                </button>
              ) : (
                <p>等房主再开一场</p>
              )}
              <button className="text-button" onClick={onNew}>
                换一桌
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
            : "四家皆未听牌"}
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
        {details ? "收起" : "展开"}点数往来 {details ? "−" : "＋"}
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
