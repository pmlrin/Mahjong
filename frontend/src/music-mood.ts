// Whether the table music plays out or steps back. Pure: no audio here, so
// it can be tested on its own.
import type { MatchView } from "../../shared/types";

/** rest: a hand or match result is on show, so the music sits lower. */
export type MusicMood = "play" | "rest";

export function musicMood(v: MatchView): MusicMood {
  const phase = v.hand.phase;
  return phase === "HAND_RESULT" || phase === "MATCH_RESULT" ? "rest" : "play";
}
