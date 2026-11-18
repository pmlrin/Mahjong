// The score behind the table music: which mood a hand is in, and which note
// to pluck on each step. Pure: no audio, DOM or React here, so it can be
// tested on its own. `music.ts` plays what this writes.
import type { MatchView } from "../../shared/types";

/**
 * calm: an ordinary hand. tense: someone has declared riichi. final: the last
 * hand of the match (or an extension round). rest: a result is on show, so
 * the melody steps back and only the pad and the ambience stay.
 */
export type MusicMood = "calm" | "tense" | "final" | "rest";

export function musicMood(v: MatchView): MusicMood {
  const h = v.hand;
  if (h.phase === "HAND_RESULT" || h.phase === "MATCH_RESULT") return "rest";
  if (h.seats.some((s) => s.riichi !== "NONE")) return "tense";
  const lastWind = v.format === "HANCHAN" ? "SOUTH" : "EAST";
  if (h.isExtension || (h.roundWind === lastWind && h.roundNumber === 4))
    return "final";
  return "calm";
}

/** One step is an eighth note; a phrase is two bars of 4/4. */
export const PHRASE = 16;
/** D gong pentatonic: 宫 商 角 徵 羽 = D E F♯ A B. */
const SCALE = [0, 2, 4, 7, 9];
const ROOT = 62; // D4
/** The melody moves over scale steps 0 (D4) to 10 (D6). */
export const LOWEST = 0,
  HIGHEST = 10;
export const pitchOf = (step: number) =>
  ROOT + 12 * Math.floor(step / 5) + SCALE[((step % 5) + 5) % 5];
/** Pitch classes (C = 0) the melody may use. */
export const PITCH_CLASSES = new Set(SCALE.map((s) => (ROOT + s) % 12));

export interface MoodSettings {
  bpm: number;
  /** Chance an open step gets a note. */
  density: number;
  /** Scale steps a phrase may end on. */
  cadence: number[];
  /** Low drone chords (MIDI), one per phrase, cycling. */
  chords: number[][];
  /** A soft heartbeat on each beat. */
  pulse: boolean;
  /** A bass note on each bar. */
  bass: boolean;
  melody: boolean;
}
// calm and final rest on 宫 and 徵 (D, A); tense leans to 羽 and 角 (B, F♯),
// the same five notes heard as minor.
const BRIGHT = [
  [38, 45, 57],
  [35, 42, 54],
  [40, 47, 59],
  [33, 45, 57],
];
const DARK = [
  [35, 42, 54],
  [33, 40, 52],
  [35, 42, 54],
  [30, 42, 54],
];
export const MOODS: Record<MusicMood, MoodSettings> = {
  calm: {
    bpm: 66,
    density: 0.42,
    cadence: [0, 3, 5, 8],
    chords: BRIGHT,
    pulse: false,
    bass: false,
    melody: true,
  },
  final: {
    bpm: 74,
    density: 0.5,
    cadence: [0, 3, 5, 8],
    chords: BRIGHT,
    pulse: false,
    bass: true,
    melody: true,
  },
  tense: {
    bpm: 80,
    density: 0.55,
    cadence: [2, 4, 7, 9],
    chords: DARK,
    pulse: true,
    bass: true,
    melody: true,
  },
  rest: {
    bpm: 60,
    density: 0,
    cadence: [0, 5],
    chords: BRIGHT,
    pulse: false,
    bass: false,
    melody: false,
  },
};

export interface Note {
  midi: number;
  /** In steps. */
  length: number;
  /** 0–1. */
  accent: number;
  /** Bend up into the note from the step below, as on a guzheng. */
  slide: boolean;
}

const MOVES = [-2, -1, -1, -1, 0, 1, 1, 1, 2];
const nearest = (from: number, targets: number[]) =>
  targets.reduce((best, t) =>
    Math.abs(t - from) < Math.abs(best - from) ? t : best,
  );

/**
 * A melody that wanders by small steps, breathes mid-phrase, and settles on a
 * cadence note at the end of each phrase. `next` is called once per step with
 * that step's place in the phrase (0 … PHRASE-1).
 */
export function createComposer(rng: () => number = Math.random) {
  let pos = 5,
    rest = 0;
  return {
    next(mood: MusicMood, i: number): Note | null {
      const m = MOODS[mood];
      if (!m.melody) return null;
      if (i === PHRASE - 2) {
        const target = nearest(pos, m.cadence);
        const slide = target > pos && rng() < 0.4;
        pos = target;
        rest = 1;
        return { midi: pitchOf(pos), length: 6, accent: 0.9, slide };
      }
      if (rest > 0) {
        rest--;
        return null;
      }
      if (i === PHRASE - 1 || rng() >= m.density) return null;
      let move = MOVES[Math.floor(rng() * MOVES.length)];
      if (rng() < 0.08) move = rng() < 0.5 ? -3 : 3;
      let next = pos + move;
      if (next < LOWEST || next > HIGHEST) next = pos - move;
      next = Math.min(HIGHEST, Math.max(LOWEST, next));
      const slide = next > pos && rng() < 0.12;
      pos = next;
      const onBeat = i % 2 === 0;
      const length = onBeat && rng() < 0.35 ? 3 : rng() < 0.3 ? 2 : 1;
      if (i === 6 && rng() < 0.45) rest = 1;
      return {
        midi: pitchOf(pos),
        length,
        accent: i % 4 === 0 ? 1 : 0.72,
        slide,
      };
    },
  };
}
