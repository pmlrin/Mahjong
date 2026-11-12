// Table sounds. Tiles (a discard landing, a dora turning, the deal) play
// short ceramic samples; calls, riichi and results stay synthesised with Web
// Audio. Each sample has a synthesised stand-in that plays until the files
// have loaded, or if this browser cannot decode them.
import type { MatchEvent } from "./match-events";

export type SoundName =
  | "discard"
  | "call"
  | "riichi"
  | "riichi-stick"
  | "dora"
  | "win"
  | "draw"
  | "deal";

// Open Tabletop's CC0 ceramic tile cues (see THIRD_PARTY_NOTICES.md), each
// shipped as Ogg Vorbis and as AAC for browsers without Vorbis.
const FILES = import.meta.glob<string>("./assets/sounds/*.{ogg,m4a}", {
  eager: true,
  query: "?url",
  import: "default",
});
const SAMPLED = {
  discard: ["drop-1", "drop-2", "drop-3", "drop-4"],
  dora: ["flip-1", "flip-2", "flip-3"],
  deal: ["shuffle-1", "shuffle-2", "shuffle-3"],
} as const;
type Sampled = keyof typeof SAMPLED;
/**
 * Each file is scaled so its loudest moment reaches this level: the
 * variants of one cue then sound alike, and sit near the synthesised voices.
 */
const PEAK: Record<Sampled, number> = { discard: 0.25, dora: 0.18, deal: 0.2 };
const buffers: Partial<
  Record<Sampled, { buffer: AudioBuffer; gain: number }[]>
> = {};
let loading: Promise<void> | undefined;

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
  // A soft rush of tiles, standing in for the shuffle sample.
  deal(ctx, at) {
    burst(ctx, at, 0.5, 0.025, "bandpass", 5200, 0.8);
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

function format() {
  try {
    return new Audio().canPlayType('audio/ogg; codecs="vorbis"')
      ? "ogg"
      : "m4a";
  } catch {
    return "m4a";
  }
}
async function decode(ctx: AudioContext, name: string) {
  const first = format(),
    order = first === "ogg" ? ["ogg", "m4a"] : ["m4a", "ogg"];
  for (const ext of order) {
    const url = FILES[`./assets/sounds/ceramic-tile-${name}.${ext}`];
    if (!url) continue;
    try {
      const data = await (await fetch(url)).arrayBuffer();
      return await ctx.decodeAudioData(data);
    } catch {}
  }
  return null;
}
function peakOf(buffer: AudioBuffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++)
    for (const v of buffer.getChannelData(c))
      peak = Math.max(peak, Math.abs(v));
  return peak || 1;
}
/**
 * Fetch and decode the tile samples once. Called when sound is switched on,
 * so the first discard after that already has its sample. Never throws.
 */
export function loadSounds() {
  loading ??= (async () => {
    try {
      const ctx = context();
      await Promise.all(
        (Object.keys(SAMPLED) as Sampled[]).map(async (cue) => {
          const decoded = await Promise.all(
            SAMPLED[cue].map((name) => decode(ctx, name)),
          );
          const ready = decoded
            .filter((b): b is AudioBuffer => !!b)
            .map((buffer) => ({ buffer, gain: PEAK[cue] / peakOf(buffer) }));
          if (ready.length) buffers[cue] = ready;
        }),
      );
    } catch {}
    // Nothing loaded (offline, say): try again the next time sound is used.
    if (!Object.keys(buffers).length) loading = undefined;
  })();
  return loading;
}
function sample(ctx: AudioContext, at: number, cue: Sampled) {
  const pool = buffers[cue];
  if (!pool?.length) return false;
  const { buffer, gain } = pool[Math.floor(Math.random() * pool.length)];
  const src = ctx.createBufferSource(),
    g = ctx.createGain();
  src.buffer = buffer;
  g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.start(at);
  return true;
}

/** Play one sound now, or after `delay` seconds. Never throws. */
export function playSound(name: SoundName, delay = 0) {
  try {
    const ctx = context(),
      at = ctx.currentTime + 0.005 + delay;
    if (name in SAMPLED && sample(ctx, at, name as Sampled)) return;
    VOICES[name](ctx, at);
  } catch {}
}

/**
 * Sounds for one step of play. A discard sounds when the tile lands, which
 * on the 3D table is `land` seconds after the step arrives. Several discards
 * or calls in one step sound once each kind, not as a burst.
 */
export function playEvents(events: readonly MatchEvent[], land = 0) {
  void loadSounds();
  const heard = new Set<SoundName>();
  for (const e of events) {
    const name: SoundName = e.type;
    if (heard.has(name)) continue;
    heard.add(name);
    playSound(name, name === "discard" ? land : 0);
  }
}
