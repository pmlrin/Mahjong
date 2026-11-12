// Table sounds, synthesised with Web Audio: no recordings ship with the app.
// Each event kind has one fixed voice, kept about as quiet as the old beep.
import type { MatchEvent } from "./match-events";

export type SoundName =
  "discard" | "call" | "riichi" | "riichi-stick" | "dora" | "win" | "draw";

let audio: AudioContext | undefined;
let noiseBuffer: AudioBuffer | undefined;

function context() {
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}
function noise(ctx: AudioContext) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/** A pitched note with a quick attack and an exponential fade. */
function tone(
  ctx: AudioContext,
  at: number,
  frequency: number,
  length: number,
  peak: number,
  {
    type = "sine",
    to,
    attack = 0.004,
  }: { type?: OscillatorType; to?: number; attack?: number } = {},
) {
  const o = ctx.createOscillator(),
    g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(frequency, at);
  if (to) o.frequency.exponentialRampToValueAtTime(to, at + length);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + length + 0.02);
}
/** A filtered burst of noise: the wood and the clack. */
function burst(
  ctx: AudioContext,
  at: number,
  length: number,
  peak: number,
  filter: BiquadFilterType,
  frequency: number,
  q = 1,
) {
  const src = ctx.createBufferSource(),
    f = ctx.createBiquadFilter(),
    g = ctx.createGain();
  src.buffer = noise(ctx);
  f.type = filter;
  f.frequency.value = frequency;
  f.Q.value = q;
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(at);
  src.stop(at + length + 0.02);
}

const VOICES: Record<SoundName, (ctx: AudioContext, at: number) => void> = {
  // A tile set down on felt: a short knock with a little body under it.
  discard(ctx, at) {
    burst(ctx, at, 0.05, 0.09, "bandpass", 2100, 1.4);
    tone(ctx, at, 190, 0.08, 0.05, { to: 110 });
  },
  // Two notes up: someone takes the tile.
  call(ctx, at) {
    tone(ctx, at, 587.33, 0.1, 0.04, { type: "triangle" });
    tone(ctx, at + 0.08, 880, 0.16, 0.04, { type: "triangle" });
  },
  // A low, held note with its fifth.
  riichi(ctx, at) {
    tone(ctx, at, 392, 0.42, 0.045, { type: "triangle", attack: 0.02 });
    tone(ctx, at, 587.33, 0.36, 0.018, { attack: 0.02 });
  },
  // The stick laid down: a bright click.
  "riichi-stick"(ctx, at) {
    burst(ctx, at, 0.035, 0.07, "highpass", 3200);
    tone(ctx, at, 1450, 0.06, 0.02);
  },
  dora(ctx, at) {
    tone(ctx, at, 1318.5, 0.22, 0.022);
  },
  // A soft, spread major chord.
  win(ctx, at) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(ctx, at + i * 0.06, f, 1.1 - i * 0.12, 0.03, { attack: 0.012 }),
    );
  },
  // Two notes down.
  draw(ctx, at) {
    tone(ctx, at, 493.88, 0.18, 0.035, { type: "triangle" });
    tone(ctx, at + 0.15, 369.99, 0.3, 0.035, { type: "triangle" });
  },
};

/** Play one sound now, or after `delay` seconds. Never throws. */
export function playSound(name: SoundName, delay = 0) {
  try {
    const ctx = context();
    VOICES[name](ctx, ctx.currentTime + 0.005 + delay);
  } catch {}
}

/**
 * Sounds for one step of play. A discard sounds when the tile lands, which
 * on the 3D table is `land` seconds after the step arrives. Several discards
 * or calls in one step sound once each kind, not as a burst.
 */
export function playEvents(events: readonly MatchEvent[], land = 0) {
  const heard = new Set<SoundName>();
  for (const e of events) {
    const name: SoundName = e.type;
    if (heard.has(name)) continue;
    heard.add(name);
    playSound(name, name === "discard" ? land : 0);
  }
}
