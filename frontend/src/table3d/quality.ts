// Rendering quality steps for the 3D table, from best to cheapest, and the
// rule for stepping down when frames are slow. No React or WebGL here.

export interface QualityLevel {
  /** Device pixel ratio range handed to the canvas. */
  dpr: [number, number];
  shadows: boolean;
  shadowSize: number;
}
// Constant objects: the canvas reconfigures when the dpr array changes identity.
export const QUALITY: readonly QualityLevel[] = [
  { dpr: [1, 2], shadows: true, shadowSize: 2048 },
  { dpr: [1, 1.5], shadows: true, shadowSize: 1024 },
  { dpr: [1, 1], shadows: false, shadowSize: 1024 },
];

/** Frames are only drawn while something moves, so judge only those runs. */
export const FRAME_SAMPLE = {
  /** Shorter gaps than this are not real frame intervals. */
  min: 0.004,
  /** Longer gaps are idle time or a throttled, hidden page, not slowness. */
  max: 0.25,
  /** Frames needed before judging. */
  count: 24,
  /** A median interval above this (about 28 fps) is too slow. */
  slow: 1 / 28,
};

/**
 * Judge a run of frame intervals (seconds): "slow", "ok", or null when there
 * are not yet enough real frames to say.
 */
export function frameVerdict(intervals: readonly number[]) {
  const real = intervals.filter(
    (d) => d >= FRAME_SAMPLE.min && d <= FRAME_SAMPLE.max,
  );
  if (real.length < FRAME_SAMPLE.count) return null;
  const sorted = [...real].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median > FRAME_SAMPLE.slow ? "slow" : "ok";
}
