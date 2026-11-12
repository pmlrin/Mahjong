import type { Action, Frame, Option, Receipt } from "../../shared/types";

export const AUTO_WAIT_MS = 500;
export const CALL_TYPES = ["CHI", "PON", "DAIMINKAN"];
export const KAN_TYPES = ["ANKAN", "KAKAN", "DAIMINKAN"];
export const WIN_TYPES = ["TSUMO", "RON"];
export type InputSource = "manual" | "auto-discard" | "auto-pass";
export interface TableContext {
  frame: Frame;
  binding: string;
  network: boolean;
}
export interface SavedAction {
  requestId: string;
  payload: Action;
  option: Option;
  key: string;
  status: "sending" | "unknown" | "accepted" | "rejected";
}
export interface TableDependencies {
  now: () => number;
  later: (fn: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
  uuid: () => string;
  send: (payload: Action, requestId: string) => Promise<Receipt>;
  query: (matchId: string, requestId: string) => Promise<Receipt>;
  sync: (matchId: string, syncId: string) => Promise<unknown>;
  save: (action: SavedAction | null) => void;
  changed: () => void;
  error: (message: string) => void;
  // Read the owning app's live refs as well as the installed view at send time.
  authorized?: (context: TableContext) => boolean;
}
export function decisionKey(f: Frame): string {
  const d = f.state.self.decision;
  return JSON.stringify([
    f.matchId,
    f.state.hand.handId,
    f.serverEpoch,
    d?.windowId,
    d?.decisionId,
  ]);
}
export function sameOption(a: Option, b: Option) {
  return (
    a.optionId === b.optionId &&
    a.type === b.type &&
    a.tile === b.tile &&
    a.meldId === b.meldId &&
    JSON.stringify(a.tiles) === JSON.stringify(b.tiles) &&
    JSON.stringify(a.consumedTiles) === JSON.stringify(b.consumedTiles)
  );
}
export function automaticOption(
  f: Frame,
  discard: boolean,
  noCall: boolean,
): { option?: Option; source?: InputSource; reason: string } {
  const v = f.state,
    d = v.self.decision,
    w = v.hand.window;
  if (
    v.status !== "RUNNING" ||
    !d?.canSubmit ||
    d.owner !== "HUMAN" ||
    d.submittedRequestId ||
    v.self.desiredControl !== "HUMAN" ||
    v.players[v.viewerSeat].effectiveControl !== "HUMAN" ||
    !w ||
    w.windowId !== d.windowId
  )
    return { reason: "还没轮到你" };
  if (discard && w.kind === "SELF_ACTION" && w.actorSeat === v.viewerSeat) {
    if (
      d.options.some((o) =>
        ["TSUMO", "ANKAN", "KAKAN", "ABORT_KYUUSHU"].includes(o.type),
      )
    )
      return { reason: "能和、能杠或九种九牌，等你决定" };
    const option =
      w.selfActionMode === "AFTER_DRAW" && v.self.drawnTile !== null
        ? d.options.find(
            (o) => o.type === "DISCARD" && o.tile === v.self.drawnTile,
          )
        : undefined;
    return option
      ? { option, source: "auto-discard", reason: "即将摸切" }
      : { reason: "这一手摸切不了，等你决定" };
  }
  if (noCall && ["CALL_RESPONSE", "KAN_RESPONSE"].includes(w.kind)) {
    if (d.options.some((o) => o.type === "RON"))
      return { reason: "能荣和，等你决定" };
    const option = d.options.find((o) => o.type === "PASS");
    return option
      ? { option, source: "auto-pass", reason: "即将过（不鸣牌）" }
      : { reason: "这一手过不了，等你决定" };
  }
  return { reason: "已开启，静候时机" };
}

/** A single decision gate shared by pointer, keyboard and cancellable automatic input. */
export class TableActions {
  context?: TableContext;
  selected: number | null = null;
  riichi = false;
  modal: { options: Option[]; index: number; passRon: boolean } | null = null;
  autoDiscard = false;
  noCall = false;
  quick = false;
  keyboard = false;
  active = true;
  fresh = false;
  notice = "";
  manual = false;
  lock: SavedAction | null = null;
  private timer: unknown;
  private scheduled?: {
    key: string;
    option: Option;
    source: InputSource;
    due: number;
  };
  private attempted = false;
  private alive = true;
  private wantedSync: string | null = null;
  private recoveryAttempt = "";
  private recovering = false;
  private serverTime = 0;
  private receivedAt = 0;
  private permission = "";
  constructor(
    private deps: TableDependencies,
    saved?: SavedAction | null,
  ) {
    if (saved) this.lock = { ...saved, status: "unknown" };
  }
  get frame() {
    return this.context!.frame;
  }
  get options() {
    return this.context?.frame.state.self.decision?.options ?? [];
  }
  get key() {
    return this.context ? decisionKey(this.frame) : "";
  }
  get pending() {
    return (
      !!this.lock &&
      ["sending", "unknown", "accepted"].includes(this.lock.status)
    );
  }
  serverNow() {
    return this.serverTime + Math.max(0, this.deps.now() - this.receivedAt);
  }
  remaining() {
    return (
      (this.context?.frame.state.self.decision?.deadlineAt ?? 0) -
      this.serverNow()
    );
  }
  get can() {
    const c = this.context,
      v = c?.frame.state,
      d = v?.self.decision;
    return !!(
      this.alive &&
      c?.network &&
      c.binding &&
      this.active &&
      this.fresh &&
      v?.status === "RUNNING" &&
      d?.owner === "HUMAN" &&
      d.canSubmit &&
      !d.submittedRequestId &&
      v.self.desiredControl === "HUMAN" &&
      v.players[v.viewerSeat].effectiveControl === "HUMAN" &&
      v.hand.window?.windowId === d.windowId &&
      !this.lock &&
      this.remaining() > 0 &&
      (!this.deps.authorized || this.deps.authorized(c))
    );
  }
  get selectedOption() {
    return this.options.find(
      (o) =>
        o.type === (this.riichi ? "RIICHI_DISCARD" : "DISCARD") &&
        o.tile === this.selected,
    );
  }
  get selectableTiles() {
    if (!this.context) return [];
    const self = this.frame.state.self;
    return [
      ...self.concealedTiles,
      ...(self.drawnTile === null ? [] : [self.drawnTile]),
    ].filter((t) =>
      this.options.some(
        (o) =>
          o.type === (this.riichi ? "RIICHI_DISCARD" : "DISCARD") &&
          o.tile === t,
      ),
    );
  }
  get autoStatus() {
    if (this.pending)
      return this.lock?.status === "unknown"
        ? "这一手还没有回音，正在确认"
        : "已出手，静候结果";
    if (!this.active) return "回到这个页面，即可继续操作";
    if (!this.fresh || !this.context?.network) return "正在与牌桌同步…";
    if (!this.autoDiscard && !this.noCall) return this.notice;
    if (!this.can) return "已开启，等你的回合";
    if (this.manual || this.riichi || this.modal)
      return "这一手由你，下一手照旧自动";
    return this.scheduled
      ? this.scheduled.source === "auto-discard"
        ? "即将摸切…"
        : "即将过…"
      : this.notice ||
          automaticOption(this.frame, this.autoDiscard, this.noCall).reason;
  }
  install(c: TableContext) {
    if (!this.alive) return;
    const old = this.context,
      oldKey = this.key;
    const oldNow = old ? this.serverNow() : c.frame.serverTime;
    if (!old || old.frame !== c.frame) {
      this.serverTime =
        old?.frame.serverEpoch === c.frame.serverEpoch
          ? Math.max(oldNow, c.frame.serverTime)
          : c.frame.serverTime;
      this.receivedAt = this.deps.now();
    }
    this.context = c;
    const v = c.frame.state,
      d = v.self.decision;
    const permission = JSON.stringify([
      c.binding,
      c.network,
      v.self.desiredControl,
      v.players[v.viewerSeat].effectiveControl,
      d?.owner,
      d?.canSubmit,
    ]);
    const changedDecision = oldKey !== this.key;
    if (changedDecision || this.permission !== permission) {
      this.cancelWait();
      this.clearInteraction();
      this.manual = false;
      this.attempted = false;
    }
    if (
      old &&
      (old.frame.serverEpoch !== c.frame.serverEpoch ||
        old.binding !== c.binding ||
        (old.network && !c.network) ||
        (this.permission !== permission &&
          (v.self.desiredControl !== "HUMAN" ||
            v.players[v.viewerSeat].effectiveControl !== "HUMAN" ||
            d?.owner === "AI" ||
            d?.disabledReason === "CONTROL_PENDING")))
    ) {
      this.stopAutomatic("牌桌有变，自动操作已关闭");
      this.fresh = false;
      this.wantedSync = null;
    }
    if (
      v.status === "FINISHED" ||
      v.status === "ABORTED" ||
      (old && old.frame.matchId !== c.frame.matchId)
    )
      this.stopAutomatic("本场已终了，自动操作已关闭");
    this.permission = permission;
    if (
      this.wantedSync &&
      c.frame.syncId === this.wantedSync &&
      this.active &&
      c.network &&
      c.binding
    ) {
      this.fresh = true;
      this.wantedSync = null;
      // A sync proves an old decision can no longer accept the saved choice.
      if (this.lock && this.lock.key !== this.key) this.finishOld();
      if (this.lock?.status === "rejected") {
        this.lock = null;
        this.manual = true;
      }
    }
    if (changedDecision && this.lock?.status === "accepted") this.finishOld();
    if (
      changedDecision &&
      this.lock?.status === "unknown" &&
      this.lock.key !== this.key
    ) {
      this.fresh = false;
      this.wantedSync = null;
    }
    if (this.selected !== null && !this.selectedOption) this.selected = null;
    if (this.riichi && !this.options.some((o) => o.type === "RIICHI_DISCARD"))
      this.riichi = false;
    if (
      this.modal &&
      this.modal.options.some(
        (o) => !this.options.some((x) => sameOption(o, x)),
      )
    )
      this.modal = null;
    if (
      !this.fresh &&
      this.active &&
      c.network &&
      c.binding &&
      !this.wantedSync
    )
      void this.synchronize();
    if (this.lock?.status === "unknown" && c.network && c.binding)
      void this.recover();
    this.reconcile();
    this.deps.changed();
  }
  private clearInteraction() {
    this.selected = null;
    this.riichi = false;
    this.modal = null;
  }
  private finishOld() {
    this.lock = null;
    this.persist(null);
  }
  private persist(action: SavedAction | null) {
    try {
      this.deps.save(action);
    } catch {
      this.notice = "这台设备记不住出牌记录，请别关闭本页";
    }
  }
  private cancelWait() {
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = undefined;
    this.scheduled = undefined;
  }
  stopAutomatic(message = "") {
    this.cancelWait();
    this.autoDiscard = false;
    this.noCall = false;
    this.notice = message;
    this.deps.changed();
  }
  suspend(message = "离开了页面，自动操作已关闭") {
    this.active = false;
    this.fresh = false;
    this.wantedSync = null;
    this.clearInteraction();
    this.stopAutomatic(message);
  }
  resume() {
    if (!this.alive) return;
    this.active = true;
    this.fresh = false;
    if (this.context?.network && this.context.binding) void this.synchronize();
    this.deps.changed();
  }
  async synchronize(force = false) {
    if (
      !this.context ||
      !this.alive ||
      !this.active ||
      (!force && this.wantedSync) ||
      !this.context.network ||
      !this.context.binding
    )
      return;
    const id = this.deps.uuid(),
      match = this.frame.matchId;
    this.wantedSync = id;
    try {
      await this.deps.sync(match, id);
    } catch {
      if (this.alive && this.wantedSync === id) {
        this.wantedSync = null;
        this.fresh = false;
        this.stopAutomatic("同步没成功，稍后自动重试");
      }
    }
  }
  setAutomatic(mode: "discard" | "noCall", value: boolean) {
    if (
      value &&
      (!this.active ||
        !this.fresh ||
        !this.context?.network ||
        !this.context.binding ||
        this.frame.state.status !== "RUNNING" ||
        this.frame.state.self.desiredControl !== "HUMAN" ||
        this.frame.state.players[this.frame.state.viewerSeat]
          .effectiveControl !== "HUMAN" ||
        !!this.lock ||
        this.frame.state.self.decision?.owner === "AI" ||
        this.frame.state.self.decision?.disabledReason === "CONTROL_PENDING")
    )
      return;
    if (mode === "discard") this.autoDiscard = value;
    else this.noCall = value;
    this.notice = "";
    this.reconcile();
    this.deps.changed();
  }
  setPreference(mode: "quick" | "keyboard", value: boolean) {
    this[mode] = value;
    if (mode === "quick") this.selected = null;
    this.deps.changed();
  }
  intervene() {
    this.manual = true;
    this.cancelWait();
    this.notice = "这一手由你，下一手照旧自动";
    this.deps.changed();
  }
  select(tile: number, fast = false) {
    if (!this.can || this.modal || !this.selectableTiles.includes(tile)) return;
    this.intervene();
    this.selected = tile;
    if (fast && this.quick && !this.riichi)
      this.submit(this.selectedOption!, "manual");
    this.deps.changed();
  }
  move(key: string) {
    if (!this.can) return;
    this.intervene();
    if (this.modal) {
      const n = this.modal.options.length;
      this.modal.index =
        key === "Home"
          ? 0
          : key === "End"
            ? n - 1
            : (this.modal.index + (key === "ArrowLeft" ? -1 : 1) + n) % n;
    } else {
      const ts = this.selectableTiles,
        i = ts.indexOf(this.selected!);
      if (ts.length)
        this.selected =
          key === "Home"
            ? ts[0]
            : key === "End"
              ? ts.at(-1)!
              : i < 0
                ? key === "ArrowLeft"
                  ? ts.at(-1)!
                  : ts[0]
                : ts[
                    (i + (key === "ArrowLeft" ? -1 : 1) + ts.length) % ts.length
                  ];
    }
    this.deps.changed();
  }
  toggleRiichi() {
    if (
      !this.can ||
      this.modal ||
      !this.options.some((o) => o.type === "RIICHI_DISCARD")
    )
      return;
    this.intervene();
    this.riichi = !this.riichi;
    this.selected = null;
    this.deps.changed();
  }
  open(types: string[]) {
    if (!this.can || this.modal) return;
    const options = this.options.filter(
      (o) =>
        types.includes(o.type) && !(this.noCall && CALL_TYPES.includes(o.type)),
    );
    if (!options.length) return;
    this.intervene();
    this.modal = { options, index: 0, passRon: false };
    this.deps.changed();
  }
  pass() {
    if (!this.can || this.modal) return;
    const pass = this.options.find((o) => o.type === "PASS");
    if (!pass) return;
    this.intervene();
    if (this.options.some((o) => o.type === "RON")) {
      this.modal = { options: [pass], index: 0, passRon: true };
      this.deps.changed();
    } else this.submit(pass, "manual");
  }
  escape() {
    if (!this.can) return;
    this.intervene();
    if (this.modal) this.modal = null;
    else if (this.riichi) {
      this.riichi = false;
      this.selected = null;
    } else this.selected = null;
    this.deps.changed();
  }
  confirm() {
    if (!this.can) return;
    const o = this.modal
      ? this.modal.options[this.modal.index]
      : this.selectedOption;
    if (o) this.submit(o, "manual");
  }
  private reconcile() {
    const candidate = this.context
      ? automaticOption(this.frame, this.autoDiscard, this.noCall)
      : { reason: "" };
    if (
      !this.can ||
      this.manual ||
      this.riichi ||
      this.modal ||
      !candidate.option ||
      !candidate.source
    ) {
      this.cancelWait();
      return;
    }
    if (
      this.scheduled &&
      this.scheduled.key === this.key &&
      sameOption(this.scheduled.option, candidate.option)
    )
      return;
    this.cancelWait();
    if (this.attempted) return;
    if (this.remaining() <= AUTO_WAIT_MS) {
      this.manual = true;
      this.notice = "时间太紧，这一手请自己来";
      return;
    }
    const scheduled = {
      key: this.key,
      option: candidate.option,
      source: candidate.source,
      due: this.deps.now() + AUTO_WAIT_MS,
    };
    this.scheduled = scheduled;
    const fire = () => {
      if (this.scheduled !== scheduled) return;
      const remainingWait = scheduled.due - this.deps.now();
      if (remainingWait > 0) {
        this.timer = this.deps.later(fire, remainingWait);
        return;
      }
      this.timer = undefined;
      this.scheduled = undefined;
      this.submit(scheduled.option, scheduled.source, scheduled.key);
      this.deps.changed();
    };
    this.timer = this.deps.later(fire, AUTO_WAIT_MS);
  }
  submit(
    option: Option,
    source: InputSource = "manual",
    expectedKey = this.key,
  ) {
    if (
      !this.can ||
      this.key !== expectedKey ||
      !this.options.some((o) => sameOption(o, option))
    )
      return;
    if (source !== "manual") {
      const candidate = automaticOption(
        this.frame,
        this.autoDiscard,
        this.noCall,
      );
      if (
        this.manual ||
        this.riichi ||
        this.modal ||
        this.attempted ||
        !candidate.option ||
        candidate.source !== source ||
        !sameOption(candidate.option, option)
      )
        return;
      this.attempted = true;
    } else {
      // Confirmations are also enforced here so no input path bypasses them.
      if (["DISCARD", "RIICHI_DISCARD"].includes(option.type)) {
        if (!this.selectedOption || !sameOption(this.selectedOption, option))
          return;
      } else if (
        option.type !== "PASS" &&
        !this.modal?.options.some((o) => sameOption(o, option))
      )
        return;
      if (this.modal && !this.modal.options.some((o) => sameOption(o, option)))
        return;
      if (this.noCall && CALL_TYPES.includes(option.type)) return;
      if (
        option.type === "PASS" &&
        this.options.some((o) => o.type === "RON") &&
        !this.modal?.passRon
      )
        return;
      this.intervene();
    }
    const c = this.context!,
      f = c.frame,
      d = f.state.self.decision!;
    const action: SavedAction = {
      requestId: this.deps.uuid(),
      key: this.key,
      option: structuredClone(option),
      status: "sending",
      payload: {
        matchId: f.matchId,
        handId: f.state.hand.handId,
        serverEpoch: f.serverEpoch,
        bindingId: c.binding,
        windowId: d.windowId,
        decisionId: d.decisionId,
        optionId: option.optionId,
        lastSeenViewSeq: f.viewSeq,
      },
    };
    // Acquire synchronously before rendering, storing or calling any asynchronous transport.
    this.lock = action;
    this.cancelWait();
    this.modal = null;
    this.persist(action);
    this.deps.changed();
    void this.transmit(action);
  }
  private async transmit(action: SavedAction) {
    try {
      const receipt = await this.deps.send(action.payload, action.requestId);
      this.receipt(action, receipt);
    } catch {
      if (!this.alive || this.lock !== action) return;
      action.status = "unknown";
      this.persist(action);
      this.stopAutomatic("这一手还没有回音，自动操作已关闭");
      this.deps.error("这一手还没有回音，正在确认，不必重复出牌");
      void this.synchronize();
      void this.recover();
    }
  }
  private receipt(action: SavedAction, receipt: Receipt) {
    if (
      !this.alive ||
      this.lock !== action ||
      receipt.requestId !== action.requestId ||
      receipt.matchId !== action.payload.matchId
    )
      return;
    action.status = receipt.status === "ACCEPTED" ? "accepted" : "rejected";
    this.persist(null);
    if (action.status === "rejected") {
      this.manual = true;
      this.fresh = false;
      this.deps.error(receipt.error?.message ?? "这一手没有成功，请重新选择");
      void this.synchronize(true);
    } else if (action.key !== this.key) this.finishOld();
    this.deps.changed();
  }
  async recover(retry = false) {
    const action = this.lock;
    if (
      !this.alive ||
      !action ||
      action.status !== "unknown" ||
      this.recovering ||
      !this.context?.network ||
      !this.context.binding
    )
      return;
    const attempt = action.requestId + ":" + this.context.binding;
    if (!retry && this.recoveryAttempt === attempt) return;
    this.recoveryAttempt = attempt;
    this.recovering = true;
    try {
      this.receipt(
        action,
        await this.deps.query(action.payload.matchId, action.requestId),
      );
    } catch {
      // A missing receipt is not a rejection. Only an explicit recovery request may resend,
      // with the frozen logical payload and the same request ID, after authoritative sync.
      if (
        retry &&
        this.alive &&
        this.lock === action &&
        this.fresh &&
        this.active &&
        this.key === action.key &&
        this.frame.state.self.decision?.canSubmit &&
        this.frame.state.self.decision.owner === "HUMAN" &&
        this.context?.network &&
        this.frame.state.self.desiredControl === "HUMAN" &&
        this.frame.state.players[this.frame.state.viewerSeat]
          .effectiveControl === "HUMAN" &&
        !this.frame.state.self.decision.submittedRequestId &&
        this.frame.state.hand.window?.windowId === action.payload.windowId &&
        this.remaining() > 0 &&
        this.options.some((o) => sameOption(o, action.option)) &&
        (!this.deps.authorized || this.deps.authorized(this.context!))
      ) {
        action.payload = {
          ...action.payload,
          bindingId: this.context!.binding,
          lastSeenViewSeq: this.frame.viewSeq,
        };
        this.persist(action);
        await this.transmit(action);
      }
    } finally {
      this.recovering = false;
      if (this.alive) this.deps.changed();
    }
  }
  dispose() {
    this.alive = false;
    this.cancelWait();
  }
}

export interface PointerSample {
  pointerId: number;
  isPrimary: boolean;
  button: number;
  clientX: number;
  clientY: number;
}
export class TileGesture {
  private down?: {
    id: number;
    tile: number;
    key: string;
    x: number;
    y: number;
  };
  private completed?: { tile: number; key: string };
  private pointers = new Set<number>();
  begin(e: PointerSample, tile: number, key: string) {
    this.pointers.add(e.pointerId);
    this.completed = undefined;
    if (!e.isPrimary || e.button !== 0 || this.pointers.size !== 1) {
      this.down = undefined;
      return;
    }
    this.down = { id: e.pointerId, tile, key, x: e.clientX, y: e.clientY };
  }
  trackDown(id: number) {
    this.pointers.add(id);
    if (this.pointers.size > 1) this.cancel();
  }
  move(e: PointerSample) {
    if (
      this.down?.id === e.pointerId &&
      Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 8
    )
      this.cancel();
  }
  end(e: PointerSample, tile: number | null, key: string) {
    this.move(e);
    if (
      this.down?.id === e.pointerId &&
      this.down.tile === tile &&
      this.down.key === key &&
      this.pointers.size === 1
    )
      this.completed = { tile: tile!, key };
    this.down = undefined;
    this.pointers.delete(e.pointerId);
  }
  release(id: number) {
    this.pointers.delete(id);
  }
  consume(tile: number, key: string, detail: number) {
    const valid =
      detail === 1 &&
      this.completed?.tile === tile &&
      this.completed.key === key;
    this.completed = undefined;
    return !!valid;
  }
  cancel() {
    this.down = undefined;
    this.completed = undefined;
  }
  reset() {
    this.cancel();
    this.pointers.clear();
  }
}

export function preferenceKey(environment: string, userId: string) {
  return `mj_table_v42:${environment}:${userId}`;
}
export function parsePreferences(raw: string | null): {
  quick: boolean;
  keyboard: boolean;
} {
  try {
    const p = JSON.parse(raw ?? "null");
    return { quick: p?.quick === true, keyboard: p?.keyboard === true };
  } catch {
    return { quick: false, keyboard: false };
  }
}
export function parseSavedAction(
  raw: string | null,
  matchId: string,
): SavedAction | null {
  try {
    const a = JSON.parse(raw ?? "null"),
      p = a?.payload;
    if (
      !p ||
      p.matchId !== matchId ||
      typeof a.requestId !== "string" ||
      typeof a.key !== "string" ||
      ![
        "matchId",
        "handId",
        "bindingId",
        "windowId",
        "decisionId",
        "optionId",
      ].every((k) => typeof p[k] === "string") ||
      !Number.isSafeInteger(p.serverEpoch) ||
      !Number.isSafeInteger(p.lastSeenViewSeq) ||
      a.option?.optionId !== p.optionId
    )
      return null;
    return {
      ...a,
      key: JSON.stringify([
        p.matchId,
        p.handId,
        p.serverEpoch,
        p.windowId,
        p.decisionId,
      ]),
      status: "unknown",
    };
  } catch {
    return null;
  }
}
