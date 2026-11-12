import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type { Frame, Receipt } from "../../shared/types";
import { api } from "./api";
import {
  TableActions,
  TileGesture,
  KAN_TYPES,
  WIN_TYPES,
  parsePreferences,
  parseSavedAction,
  preferenceKey,
  type TableContext,
} from "./table-actions";

export interface TableProps {
  frame: Frame;
  network: boolean;
  binding: string;
  identity: string;
  userId: string;
  emit: (event: string, payload: unknown, id?: string) => Promise<any>;
  setError: (message: string) => void;
  authorized?: (context: TableContext) => boolean;
}
export function useTableActions(props: TableProps) {
  const [, redraw] = useState(0),
    latest = useRef(props);
  latest.current = props;
  const region = useRef<HTMLElement>(null),
    dialog = useRef<HTMLElement>(null);
  const gesture = useRef(new TileGesture()),
    held = useRef(new Set<string>());
  const origin = useRef<HTMLElement | null>(null);
  const prefKey = preferenceKey(
    location.origin + import.meta.env.BASE_URL,
    props.userId,
  );
  const pendingKey = `mj_pending_v42:${prefKey}:${props.frame.matchId}`;
  const [storageWarning, setStorageWarning] = useState("");
  const [quickHelp, setQuickHelp] = useState(false);
  const helpSeen = useRef(false);
  const [actions] = useState(() => {
    let saved = null,
      preferences = { quick: false };
    try {
      preferences = parsePreferences(localStorage.getItem(prefKey));
      helpSeen.current =
        localStorage.getItem(prefKey + ":quick-help") === "true";
    } catch {}
    try {
      saved = parseSavedAction(
        sessionStorage.getItem(pendingKey),
        props.frame.matchId,
      );
    } catch {}
    const a = new TableActions(
      {
        now: () => performance.now(),
        later: (fn, ms) => setTimeout(fn, ms),
        cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        uuid: () => crypto.randomUUID(),
        changed: () => redraw((n) => n + 1),
        error: (message) => latest.current.setError(message),
        send: (p, id) =>
          latest.current.emit("game:action", p, id) as Promise<Receipt>,
        query: (match, id) => api<Receipt>(`/matches/${match}/requests/${id}`),
        sync: (matchId, syncId) =>
          latest.current.emit("game:sync", { matchId, syncId }),
        save: (saved) => {
          if (saved) sessionStorage.setItem(pendingKey, JSON.stringify(saved));
          else sessionStorage.removeItem(pendingKey);
        },
        authorized: (c) =>
          document.visibilityState === "visible" &&
          document.hasFocus() &&
          latest.current.identity === props.identity &&
          (!latest.current.authorized || latest.current.authorized(c)),
      },
      saved,
    );
    a.quick = preferences.quick;
    // Keys always work: on the hand region, or anywhere on the page that is
    // not a field or control (see the document listener below).
    a.keyboard = true;
    a.active = document.visibilityState === "visible" && document.hasFocus();
    return a;
  });
  useLayoutEffect(() => {
    actions.install({
      frame: props.frame,
      network: props.network,
      binding: props.binding,
    });
  }, [actions, props.frame, props.network, props.binding]);
  const gestureScope = JSON.stringify([
    props.binding,
    props.network,
    props.frame.serverEpoch,
    props.frame.state.hand.handId,
    props.frame.state.self.decision,
  ]);
  useLayoutEffect(() => {
    gesture.current.cancel();
  }, [gestureScope]);
  const controlScope = JSON.stringify([
    props.binding,
    props.network,
    props.frame.serverEpoch,
    props.frame.state.self.desiredControl,
    props.frame.state.players[props.frame.state.viewerSeat].effectiveControl,
    props.frame.state.self.decision?.owner === "AI",
    props.frame.state.self.decision?.disabledReason === "CONTROL_PENDING",
  ]);
  useLayoutEffect(() => {
    gesture.current.reset();
    held.current.clear();
  }, [controlScope]);

  useEffect(() => {
    const inactive = () => {
      gesture.current.reset();
      held.current.clear();
      actions.suspend();
    };
    const active = () => {
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        !actions.active
      )
        actions.resume();
    };
    const visibility = () =>
      document.visibilityState === "hidden" ? inactive() : active();
    const pointerDown = (e: PointerEvent) =>
      gesture.current.trackDown(e.pointerId);
    const pointerUp = (e: PointerEvent) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-hand-tile]",
      );
      gesture.current.end(
        e,
        t ? Number(t.dataset.handTile) : null,
        actions.key,
      );
    };
    const cancel = () => gesture.current.cancel();
    const pointerCancel = (e: PointerEvent) => {
      cancel();
      gesture.current.release(e.pointerId);
    };
    const release = (e: KeyboardEvent) =>
      held.current.delete(e.key.toLowerCase());
    window.addEventListener("blur", inactive);
    window.addEventListener("focus", active);
    window.addEventListener("pagehide", inactive);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("pointermove", eMove, true);
    function eMove(e: PointerEvent) {
      gesture.current.move(e);
    }
    document.addEventListener("pointerup", pointerUp, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    document.addEventListener("scroll", cancel, true);
    window.addEventListener("resize", cancel);
    document.addEventListener("keyup", release, true);
    return () => {
      window.removeEventListener("blur", inactive);
      window.removeEventListener("focus", active);
      window.removeEventListener("pagehide", inactive);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointermove", eMove, true);
      document.removeEventListener("pointerup", pointerUp, true);
      document.removeEventListener("pointercancel", pointerCancel, true);
      document.removeEventListener("scroll", cancel, true);
      window.removeEventListener("resize", cancel);
      document.removeEventListener("keyup", release, true);
      actions.dispose();
    };
  }, [actions]);
  useLayoutEffect(() => {
    if (actions.selected !== null)
      region.current
        ?.querySelector<HTMLElement>(`[data-hand-tile="${actions.selected}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [actions.selected]);
  const modal = actions.modal;
  useLayoutEffect(() => {
    gesture.current.cancel();
    if (modal) {
      origin.current = document.activeElement as HTMLElement;
      const cancel =
        dialog.current?.querySelector<HTMLButtonElement>("[data-cancel=ron]") ??
        dialog.current?.querySelector<HTMLButtonElement>("[data-cancel]");
      if (modal.passRon) cancel?.focus();
      else dialog.current?.focus();
    } else if (origin.current) {
      const el = origin.current;
      origin.current = null;
      if (el.isConnected && !(el as HTMLButtonElement).disabled) el.focus();
      else region.current?.focus();
    }
  }, [!!modal]);
  function preference(mode: "quick", value: boolean) {
    actions.setPreference(mode, value);
    try {
      localStorage.setItem(prefKey, JSON.stringify({ quick: actions.quick }));
    } catch {
      setStorageWarning("这台设备记不住设置，本次照常可用");
    }
    if (mode === "quick" && value && !helpSeen.current) {
      helpSeen.current = true;
      setQuickHelp(true);
      try {
        localStorage.setItem(prefKey + ":quick-help", "true");
      } catch {}
    }
    gesture.current.cancel();
  }
  interface KeyInput {
    key: string;
    repeat: boolean;
    composing: boolean;
    modified: boolean;
    prevented: boolean;
    target: HTMLElement;
    consume: () => void;
  }
  function handleKey(e: KeyInput) {
    if (
      !actions.keyboard ||
      !actions.active ||
      !actions.fresh ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    const target = e.target;
    if (e.key === "Tab") return; // Native navigation (the dialog traps Tab separately below).
    if (
      e.prevented ||
      e.composing ||
      e.modified ||
      target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable=false])",
      )
    )
      return;
    const key = e.key.toLowerCase();
    if (
      ![
        "arrowleft",
        "arrowright",
        "home",
        "end",
        "enter",
        "r",
        "c",
        "p",
        "k",
        "w",
        " ",
        "escape",
      ].includes(key)
    )
      return;
    // Capture also guards native button repeats without adding a second activation path.
    if (e.repeat || held.current.has(key)) {
      e.consume();
      return;
    }
    held.current.add(key);
    if (target.closest("button, a, [role=switch]")) return;
    if (!actions.can) return;
    e.consume();
    if (actions.modal) {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
        actions.move(e.key);
      else if (key === "enter") actions.confirm();
      else if (key === "escape") actions.escape();
      return;
    }
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
      actions.move(e.key);
    else if (key === "enter") actions.confirm();
    else if (key === "r") actions.toggleRiichi();
    else if (key === "c") actions.open(["CHI"]);
    else if (key === "p") actions.open(["PON"]);
    else if (key === "k") actions.open(KAN_TYPES);
    else if (key === "w") actions.open(WIN_TYPES);
    else if (key === " ") actions.pass();
    else if (key === "escape") actions.escape();
  }
  function keydown(e: ReactKeyboardEvent) {
    handleKey({
      key: e.key,
      repeat: e.repeat,
      composing: e.nativeEvent.isComposing || e.keyCode === 229,
      modified: e.ctrlKey || e.metaKey || e.altKey,
      prevented: e.isDefaultPrevented(),
      target: e.target as HTMLElement,
      consume: () => {
        e.preventDefault();
        e.stopPropagation();
      },
    });
  }
  // Keys pressed with nothing in particular focused (the page body, or the
  // table picture) act on the hand too, so no one has to click into it first.
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  useEffect(() => {
    const loose = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        region.current?.contains(target) ||
        dialog.current?.contains(target) ||
        target.closest(
          "button, a, input, textarea, select, [role=switch], [role=dialog], [contenteditable]:not([contenteditable=false])",
        )
      )
        return;
      handleKeyRef.current({
        key: e.key,
        repeat: e.repeat,
        composing: e.isComposing || e.keyCode === 229,
        modified: e.ctrlKey || e.metaKey || e.altKey,
        prevented: e.defaultPrevented,
        target: region.current ?? target,
        consume: () => e.preventDefault(),
      });
    };
    document.addEventListener("keydown", loose);
    return () => document.removeEventListener("keydown", loose);
  }, []);
  // A choice whose answer never came back, or a table that fell out of step,
  // is checked again on its own every few seconds while connected.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!latest.current.network || !actions.active) return;
      if (actions.lock?.status === "unknown") void actions.recover(true);
      else if (!actions.fresh) void actions.synchronize();
    }, 3000);
    return () => clearInterval(timer);
  }, [actions]);
  function dialogKeydown(e: ReactKeyboardEvent) {
    // Escape and Tab retain their dialog semantics even on a native button.
    if (
      e.key === "Escape" &&
      !e.nativeEvent.isComposing &&
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      actions.escape();
    }
    if (e.key !== "Tab") return;
    const buttons = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [tabindex='0']",
      ) ?? [],
    );
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      buttons.at(-1)?.focus();
    } else if (!e.shiftKey && (i === buttons.length - 1 || i < 0)) {
      e.preventDefault();
      buttons[0]?.focus();
    }
  }
  function tilePointerDown(e: ReactPointerEvent, tile: number) {
    if (actions.can && !actions.modal)
      gesture.current.begin(e, tile, actions.key);
  }
  function tileClick(e: ReactMouseEvent, tile: number) {
    const fast = gesture.current.consume(tile, actions.key, e.detail);
    if (e.detail > 0 && actions.quick && !fast) return;
    actions.select(tile, fast);
  }
  return {
    actions,
    region,
    dialog,
    keydown,
    dialogKeydown,
    tilePointerDown,
    tileClick,
    preference,
    storageWarning,
    quickHelp,
    closeQuickHelp: () => setQuickHelp(false),
  };
}
