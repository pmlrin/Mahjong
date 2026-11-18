import test from "node:test";
import assert from "node:assert/strict";
import {
  HIGHEST,
  LOWEST,
  MOODS,
  PHRASE,
  PITCH_CLASSES,
  createComposer,
  musicMood,
  pitchOf,
  type MusicMood,
} from "../frontend/src/music-score.ts";
import type { MatchView } from "../shared/types.ts";

/** A seeded generator, so a failure can be reproduced. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function view(hand: Record<string, unknown>, format = "EAST_ONLY") {
  return {
    format,
    hand: {
      phase: "SELF_ACTION",
      roundWind: "EAST",
      roundNumber: 1,
      isExtension: false,
      seats: [0, 1, 2, 3].map(() => ({ riichi: "NONE" })),
      ...hand,
    },
  } as unknown as MatchView;
}

test("the mood follows the hand", () => {
  assert.equal(musicMood(view({})), "calm");
  assert.equal(musicMood(view({ roundNumber: 4 })), "final");
  assert.equal(musicMood(view({ roundNumber: 4 }, "HANCHAN")), "calm");
  assert.equal(
    musicMood(view({ roundWind: "SOUTH", roundNumber: 4 }, "HANCHAN")),
    "final",
  );
  assert.equal(
    musicMood(view({ roundWind: "SOUTH", isExtension: true })),
    "final",
  );
  const riichi = [0, 1, 2, 3].map((s) => ({
    riichi: s === 2 ? "DECLARED" : "NONE",
  }));
  assert.equal(musicMood(view({ seats: riichi })), "tense");
  assert.equal(musicMood(view({ seats: riichi, roundNumber: 4 })), "tense");
  assert.equal(musicMood(view({ phase: "HAND_RESULT", seats: riichi })), "rest");
  assert.equal(musicMood(view({ phase: "MATCH_RESULT" })), "rest");
});

test("the melody stays in the pentatonic scale and its range", () => {
  for (const mood of ["calm", "tense", "final"] as MusicMood[]) {
    const c = createComposer(seeded(7));
    let notes = 0;
    for (let t = 0; t < PHRASE * 200; t++) {
      const n = c.next(mood, t % PHRASE);
      if (!n) continue;
      notes++;
      assert.ok(PITCH_CLASSES.has(n.midi % 12), `${mood}: ${n.midi}`);
      assert.ok(n.midi >= pitchOf(LOWEST) && n.midi <= pitchOf(HIGHEST));
      assert.ok(n.length >= 1 && n.accent > 0 && n.accent <= 1);
    }
    // Neither silent nor wall-to-wall.
    assert.ok(notes > PHRASE * 200 * 0.2, `${mood}: ${notes}`);
    assert.ok(notes < PHRASE * 200 * 0.7, `${mood}: ${notes}`);
  }
});

test("every phrase ends on one of its mood's cadence notes", () => {
  for (const mood of ["calm", "tense", "final"] as MusicMood[]) {
    const c = createComposer(seeded(42));
    const ends = new Set(MOODS[mood].cadence.map(pitchOf));
    for (let t = 0; t < PHRASE * 50; t++) {
      const i = t % PHRASE,
        n = c.next(mood, i);
      if (i === PHRASE - 2) assert.ok(n && ends.has(n.midi), `${mood} @${t}`);
      if (i === PHRASE - 1) assert.equal(n, null);
    }
  }
});

test("a result on show silences the melody", () => {
  const c = createComposer(seeded(1));
  for (let t = 0; t < PHRASE * 10; t++)
    assert.equal(c.next("rest", t % PHRASE), null);
});
