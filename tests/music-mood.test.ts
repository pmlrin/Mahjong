import test from "node:test";
import assert from "node:assert/strict";
import { musicMood } from "../frontend/src/music-mood.ts";
import type { MatchView } from "../shared/types.ts";

const view = (phase: string) => ({ hand: { phase } }) as unknown as MatchView;

test("the music steps back only while a result is on show", () => {
  for (const phase of ["DEALING", "SELF_ACTION", "CALL_RESPONSE"])
    assert.equal(musicMood(view(phase)), "play");
  assert.equal(musicMood(view("HAND_RESULT")), "rest");
  assert.equal(musicMood(view("MATCH_RESULT")), "rest");
});
