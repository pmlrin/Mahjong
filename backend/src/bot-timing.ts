import type { PublicWindow, Seat } from "../../shared/types.ts";
/** AI "thinking" pause after a window opens, drawn from [MIN, MAX] ms. */
export const BOT_DELAY_MIN_MS = 2000;
export const BOT_DELAY_MAX_MS = 6000;
/** Stable 0..1 from window and seat: a retried decision keeps its pause, seats differ. */
function jitter(windowId: string, seat: Seat): number {
  let h = 2166136261;
  for (const c of `${windowId}:${seat}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}
export function botDelayMs(window: PublicWindow, seat: Seat): number {
  return Math.round(
    BOT_DELAY_MIN_MS +
      (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS) * jitter(window.windowId, seat),
  );
}
/** Use the same monotonic window clock as expiry; wall clock changes must not speed up play. */
export function botReadyAt(
  window: PublicWindow,
  deadlineMono: number,
  seat: Seat,
  fastTest = false,
): number {
  const duration = window.kind === "SELF_ACTION" ? 15000 : 8000;
  const pause = fastTest ? 0 : botDelayMs(window, seat);
  return deadlineMono - duration + pause;
}
