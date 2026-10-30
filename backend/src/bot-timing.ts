import type { PublicWindow } from "../../shared/types.ts";
export const BOT_SELF_DELAY_MS = 2000;
export const BOT_RESPONSE_DELAY_MS = 1200;
/** Use the same monotonic window clock as expiry; wall clock changes must not speed up play. */
export function botReadyAt(
  window: PublicWindow,
  deadlineMono: number,
  fastTest = false,
): number {
  const duration = window.kind === "SELF_ACTION" ? 15000 : 8000;
  const pause = fastTest
    ? 0
    : window.kind === "SELF_ACTION"
      ? BOT_SELF_DELAY_MS
      : BOT_RESPONSE_DELAY_MS;
  return deadlineMono - duration + pause;
}
