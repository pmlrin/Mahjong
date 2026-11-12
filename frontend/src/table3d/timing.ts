// Timing shared between the 3D scene and the page around it (sounds), kept
// free of three.js so importing it does not pull the 3D chunk into the page.

/** A discard on the 3D table: lift out, hang a moment, then drop. Seconds. */
export const DISCARD_FLIGHT = {
  duration: 0.46,
  /** End of the travel to the hover point, as a fraction of the duration. */
  travel: 0.56,
  /** End of the hang; the drop takes the rest. */
  hang: 0.72,
  /** Height of the hover point above the resting place, in tile units. */
  hover: 0.55,
};
/** When the dropped tile touches the table, after the step arrives. */
export const DISCARD_LANDS_AFTER = DISCARD_FLIGHT.duration;

/** A finished hand on the 3D table, in seconds after the result arrives. */
export const REVEAL = {
  /** A beat before anything moves. */
  pause: 0.3,
  /** Each revealed tile falls this long after the one before it. */
  stagger: 0.035,
  /** The winning tile rises once the hand is down. */
  lift: 0.85,
  /** Ura dora turn over last, one after another. */
  ura: 1.05,
  uraStagger: 0.12,
};
/**
 * How long the result panel waits so the end of the hand can be seen, and the
 * least display time that must be left to bother (after a reconnect, say).
 */
export const RESULT_HOLD = { table3d: 2, flat: 1.2, minRemaining: 4 };
