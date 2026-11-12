// Seal stamps for calls, riichi and the end of a hand, laid over either
// table (3D or flat), plus a polite spoken line for screen readers.
import React, { useEffect, useRef, useState } from "react";
import type { MatchView, Seat } from "../../shared/types";
import type { MatchEvent } from "./match-events";
import "./stamps.css";

/** One step of play, numbered so the same events are not stamped twice. */
export interface PlayStep {
  id: number;
  events: MatchEvent[];
}
interface Stamp {
  id: string;
  /** Relative seat (0 is the viewer), or "center" for the whole table. */
  slot: number | "center";
  text: string;
  caption?: string;
}

/** How long a stamp stays (its animation fades it out just before). */
export const STAMP_MS = 1150;

const CALL_TEXT: Record<string, string> = {
  CHI: "吃",
  PON: "碰",
  DAIMINKAN: "杠",
  ANKAN: "杠",
  KAKAN: "杠",
};
const CALL_SPOKEN: Record<string, string> = {
  CHI: "吃",
  PON: "碰",
  DAIMINKAN: "明杠",
  ANKAN: "暗杠",
  KAKAN: "加杠",
};

function stampOf(
  e: MatchEvent,
  viewer: Seat,
  reasons: Record<string, string>,
): Omit<Stamp, "id"> | null {
  const rel = (seat: Seat) => (seat - viewer + 4) % 4;
  switch (e.type) {
    case "call":
      return { slot: rel(e.seat), text: CALL_TEXT[e.call] };
    case "riichi":
      return { slot: rel(e.seat), text: "立直" };
    case "win":
      // A nagashi mangan is told by the draw stamp.
      if (e.method === "NAGASHI_MANGAN") return null;
      return { slot: rel(e.seat), text: e.method === "RON" ? "荣" : "自摸" };
    case "draw":
      return {
        slot: "center",
        text: "流局",
        caption: e.reason === "EXHAUSTIVE_DRAW" ? undefined : reasons[e.reason],
      };
    default:
      return null;
  }
}

function spokenOf(
  e: MatchEvent,
  view: MatchView,
  reasons: Record<string, string>,
) {
  const who = (seat: Seat) =>
    seat === view.viewerSeat ? "你" : view.players[seat].displayName;
  switch (e.type) {
    case "call":
      return `${who(e.seat)} ${CALL_SPOKEN[e.call]}`;
    case "riichi":
      return `${who(e.seat)} 立直`;
    case "win":
      return e.method === "NAGASHI_MANGAN"
        ? null
        : `${who(e.seat)} ${e.method === "RON" ? "荣和" : "自摸"}`;
    case "draw":
      return reasons[e.reason] ?? "流局";
    default:
      return null;
  }
}

export function CallStamps({
  step,
  view,
  reasons,
}: {
  step: PlayStep | null;
  view: MatchView;
  reasons: Record<string, string>;
}) {
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [spoken, setSpoken] = useState("");
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (!step) return;
    const fresh = step.events.flatMap((e, i) => {
      const s = stampOf(e, view.viewerSeat, reasons);
      return s ? [{ ...s, id: `${step.id}-${i}` }] : [];
    });
    const words = step.events
      .map((e) => spokenOf(e, view, reasons))
      .filter(Boolean)
      .join("，");
    // A trailing zero-width space makes a repeated line ("对家 碰" twice) new.
    if (words) setSpoken(words + (step.id % 2 ? "\u200b" : ""));
    if (!fresh.length) return;
    // A new stamp on a seat replaces the one still there.
    setStamps((list) => [
      ...list.filter((x) => !fresh.some((f) => f.slot === x.slot)),
      ...fresh,
    ]);
    const ids = new Set(fresh.map((f) => f.id));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setStamps((list) => list.filter((x) => !ids.has(x.id)));
    }, STAMP_MS);
    timers.current.add(timer);
  }, [step?.id]);
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );
  return (
    <div className="call-stamps">
      {stamps.map((s) => (
        <div
          key={s.id}
          className={`call-stamp ${s.slot === "center" ? "center" : `seat-${s.slot}`} ${
            s.text.length > 1 && s.slot !== "center" ? "two" : ""
          }`}
          aria-hidden="true"
        >
          {s.text}
          {s.caption && <small>{s.caption}</small>}
        </div>
      ))}
      <p className="visually-hidden" aria-live="polite">
        {spoken}
      </p>
    </div>
  );
}
