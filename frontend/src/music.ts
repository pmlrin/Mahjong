// Table music: an ambient bed under a pentatonic melody that `music-score.ts`
// writes live, so it never repeats. The bed is a recorded loop when one ships
// in assets/music/ (see SOURCE.md there), and a soft synthesised wash until it
// has loaded, or if there is none. Everything here is Web Audio; nothing
// throws. Off by default, like the table sounds.
import {
  MOODS,
  PHRASE,
  createComposer,
  type MusicMood,
} from "./music-score";
import { context } from "./sounds";

const AMBIENT = import.meta.glob<string>("./assets/music/ambient.{ogg,m4a}", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Overall level: the melody's loudest notes sit well under the tile sounds. */
const LEVEL = 0.6;
/**
 * The bed's average loudness (RMS). Rain is steady noise, so it is matched
 * by average rather than by peak; the synthesised stand-in's gain gives it
 * the same level, so the crossfade to the recording does not dip.
 */
const BED_RMS = 0.012;
const SYNTH_BED_GAIN = 0.036;

interface Graph {
  ctx: AudioContext;
  /** Fades the music in and out. */
  master: GainNode;
  /** Dips under a riichi or a result, apart from the fades. */
  duck: GainNode;
  melody: GainNode;
  pad: GainNode;
  low: GainNode;
  bed: GainNode;
  echo: DelayNode;
}
let graph: Graph | undefined;
let mood: MusicMood = "calm";
let playing = false;
let generation = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let nextAt = 0;
let step = 0;
let chord: number[] = MOODS.calm.chords[0];
let composer = createComposer();
let bed: { src: AudioBufferSourceNode; gain: GainNode } | undefined;
let recorded: Promise<AudioBuffer | null> | undefined;
let noiseBuffer: AudioBuffer | undefined;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const stepLength = () => 60 / MOODS[mood].bpm / 2;

function noise(ctx: AudioContext) {
  if (!noiseBuffer) {
    // Four seconds of stereo noise: long enough that its loop is not heard.
    noiseBuffer = ctx.createBuffer(2, ctx.sampleRate * 4, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = noiseBuffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
  }
  return noiseBuffer;
}
/** A small hall: stereo noise with a fading tail. */
function impulse(ctx: AudioContext, seconds: number) {
  const n = Math.floor(ctx.sampleRate * seconds),
    b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++)
      d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
  }
  return b;
}

function build(ctx: AudioContext): Graph {
  const duck = ctx.createGain(),
    master = ctx.createGain();
  master.gain.value = 0;
  master.connect(duck).connect(ctx.destination);
  const reverb = ctx.createConvolver(),
    wet = ctx.createGain();
  reverb.buffer = impulse(ctx, 2.8);
  wet.gain.value = 0.3;
  reverb.connect(wet).connect(master);
  // A soft echo three eighths later, darker each time round.
  const echo = ctx.createDelay(2),
    feedback = ctx.createGain(),
    tone = ctx.createBiquadFilter(),
    echoOut = ctx.createGain();
  echo.delayTime.value = 3 * stepLength();
  feedback.gain.value = 0.28;
  tone.type = "lowpass";
  tone.frequency.value = 2200;
  echoOut.gain.value = 0.5;
  echo.connect(tone).connect(feedback).connect(echo);
  tone.connect(echoOut).connect(master);
  tone.connect(reverb);

  const melody = ctx.createGain(),
    send = ctx.createGain();
  send.gain.value = 0.35;
  melody.connect(master);
  melody.connect(reverb);
  melody.connect(send).connect(echo);

  const pad = ctx.createGain(),
    padTone = ctx.createBiquadFilter();
  padTone.type = "lowpass";
  padTone.frequency.value = 1100;
  pad.connect(padTone);
  padTone.connect(master);
  padTone.connect(reverb);

  const low = ctx.createGain(),
    bedBus = ctx.createGain();
  low.connect(master);
  bedBus.connect(master);
  return { ctx, master, duck, melody, pad, low, bed: bedBus, echo };
}

/** A plucked string: a bright attack that darkens as it rings. */
function pluck(
  g: Graph,
  at: number,
  midi: number,
  seconds: number,
  accent: number,
  slide: boolean,
) {
  const { ctx } = g,
    f = hz(midi),
    ring = Math.max(1.3, seconds + 0.9) * (midi < 70 ? 1.25 : 1),
    peak = 0.075 * accent;
  const body = ctx.createOscillator(),
    over = ctx.createOscillator(),
    overGain = ctx.createGain(),
    filter = ctx.createBiquadFilter(),
    env = ctx.createGain();
  body.type = "triangle";
  over.type = "sine";
  overGain.gain.value = 0.22;
  filter.type = "lowpass";
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(Math.min(f * 9, 7000), at);
  filter.frequency.exponentialRampToValueAtTime(f * 2.2, at + 0.45);
  for (const [o, mult] of [
    [body, 1],
    [over, 2],
  ] as const) {
    if (slide) {
      o.frequency.setValueAtTime(f * mult * 2 ** (-2 / 12), at);
      o.frequency.exponentialRampToValueAtTime(f * mult, at + 0.13);
    } else o.frequency.setValueAtTime(f * mult, at);
  }
  // Held notes waver a little once they have spoken.
  let vibrato: OscillatorNode | undefined;
  if (seconds > 0.9) {
    vibrato = ctx.createOscillator();
    const depth = ctx.createGain();
    vibrato.frequency.value = 5.2;
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(f * 0.005, at + 0.6);
    vibrato.connect(depth);
    depth.connect(body.frequency);
    vibrato.start(at);
    vibrato.stop(at + ring);
  }
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(peak, at + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, at + ring);
  body.connect(filter);
  over.connect(overGain).connect(filter);
  filter.connect(env).connect(g.melody);
  for (const o of [body, over]) {
    o.start(at);
    o.stop(at + ring + 0.05);
  }
  // The pick on the string.
  const pick = ctx.createBufferSource(),
    pickTone = ctx.createBiquadFilter(),
    pickEnv = ctx.createGain();
  pick.buffer = noise(ctx);
  pickTone.type = "bandpass";
  pickTone.frequency.value = 3200;
  pickEnv.gain.setValueAtTime(0.014 * accent, at);
  pickEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.025);
  pick.connect(pickTone).connect(pickEnv).connect(g.melody);
  pick.start(at, Math.random() * 3);
  pick.stop(at + 0.04);
}

/** A slow drone chord that swells in and lets go into the next one. */
function drone(g: Graph, at: number, notes: number[], seconds: number) {
  const { ctx } = g;
  for (const midi of notes) {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.013, at + 2.5);
    env.gain.setValueAtTime(0.013, at + seconds);
    env.gain.linearRampToValueAtTime(0.0001, at + seconds + 3);
    env.connect(g.pad);
    for (const [type, cents] of [
      ["triangle", 0],
      ["sine", 5],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(midi);
      o.detune.value = cents;
      o.connect(env);
      o.start(at);
      o.stop(at + seconds + 3.1);
    }
  }
}

/** A low, soft thump; two make a heartbeat. */
function thump(g: Graph, at: number, peak: number) {
  const { ctx } = g,
    o = ctx.createOscillator(),
    env = ctx.createGain();
  o.frequency.setValueAtTime(72, at);
  o.frequency.exponentialRampToValueAtTime(42, at + 0.22);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(peak, at + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
  o.connect(env).connect(g.low);
  o.start(at);
  o.stop(at + 0.3);
}

function bass(g: Graph, at: number, midi: number, seconds: number) {
  const { ctx } = g,
    o = ctx.createOscillator(),
    env = ctx.createGain();
  o.type = "triangle";
  o.frequency.value = hz(midi);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(0.05, at + 0.03);
  env.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  o.connect(env).connect(g.low);
  o.start(at);
  o.stop(at + seconds + 0.05);
}

/** Everything that sounds on one eighth-note step. */
function play(g: Graph, t: number, at: number) {
  const m = MOODS[mood],
    i = t % PHRASE,
    eighth = stepLength();
  if (i === 0) {
    chord = m.chords[Math.floor(t / PHRASE) % m.chords.length];
    drone(g, at, chord, PHRASE * eighth);
  }
  if (m.bass && i % 8 === 0) bass(g, at, chord[0], 8 * eighth * 0.9);
  if (m.pulse && i % 4 === 0) {
    thump(g, at, 0.06);
    thump(g, at + 0.2, 0.035);
  }
  const n = composer.next(mood, i);
  if (n) pluck(g, at, n.midi, n.length * eighth, n.accent, n.slide);
}

function tick() {
  if (!graph) return;
  const { ctx } = graph;
  // After a pause (a hidden tab, a suspended context) pick up from now.
  if (nextAt < ctx.currentTime) nextAt = ctx.currentTime + 0.05;
  while (nextAt < ctx.currentTime + 0.4) {
    play(graph, step, nextAt);
    nextAt += stepLength();
    step++;
  }
}
function run() {
  clearInterval(timer);
  timer = setInterval(tick, 100);
  tick();
}

function fade(param: AudioParam, to: number, seconds: number) {
  const now = graph!.ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(to, now + seconds);
}

async function decode(ctx: AudioContext) {
  let vorbis = false;
  try {
    vorbis = !!new Audio().canPlayType('audio/ogg; codecs="vorbis"');
  } catch {}
  for (const ext of vorbis ? ["ogg", "m4a"] : ["m4a", "ogg"]) {
    const url = AMBIENT[`./assets/music/ambient.${ext}`];
    if (!url) continue;
    try {
      return await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    } catch {}
  }
  return null;
}
function rmsOf(buffer: AudioBuffer) {
  let sum = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++)
    for (const v of buffer.getChannelData(c)) sum += v * v;
  return Math.sqrt(sum / (buffer.length * buffer.numberOfChannels)) || 1;
}

/** Start a looping bed, crossfading from whatever bed is playing. */
function startBed(g: Graph, buffer: AudioBuffer, level: number, synth: boolean) {
  const { ctx } = g,
    src = ctx.createBufferSource(),
    gain = ctx.createGain(),
    now = ctx.currentTime;
  src.buffer = buffer;
  src.loop = true;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(level, now + 2.5);
  if (synth) {
    // Wash the noise down to a soft rain-on-the-roof hush that breathes.
    const hi = ctx.createBiquadFilter(),
      lo = ctx.createBiquadFilter(),
      sway = ctx.createOscillator(),
      swayDepth = ctx.createGain();
    hi.type = "highpass";
    hi.frequency.value = 450;
    lo.type = "lowpass";
    lo.frequency.value = 4200;
    sway.frequency.value = 0.06;
    swayDepth.gain.value = 900;
    sway.connect(swayDepth).connect(lo.frequency);
    sway.start();
    src.addEventListener("ended", () => sway.stop());
    src.connect(hi).connect(lo).connect(gain);
  } else src.connect(gain);
  gain.connect(g.bed);
  src.start(now, synth ? Math.random() * 3 : 0);
  const old = bed;
  bed = { src, gain };
  if (old) {
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + 2.5);
    old.src.stop(now + 2.6);
  }
}
function stopBed() {
  try {
    bed?.src.stop();
  } catch {}
  bed = undefined;
}

function onVisibility() {
  if (!graph || !playing) return;
  if (document.hidden) {
    clearInterval(timer);
    fade(graph.master.gain, 0, 0.4);
  } else {
    fade(graph.master.gain, LEVEL, 1.5);
    run();
  }
}
// Browsers keep audio silent until the page is touched; the first touch
// while the music is on lets it start.
function onGesture() {
  if (graph && playing && graph.ctx.state === "suspended")
    void graph.ctx.resume();
}

/** Start the music (fading in). Safe to call when it is already playing. */
export function startMusic() {
  try {
    if (playing) return;
    const ctx = context();
    graph ??= build(ctx);
    const g = graph;
    playing = true;
    const gen = ++generation;
    composer = createComposer();
    step = 0;
    nextAt = ctx.currentTime + 0.1;
    if (!document.hidden) fade(g.master.gain, LEVEL, 3);
    g.melody.gain.value = MOODS[mood].melody ? 1 : 0;
    // A synthesised hush now, the recording when (if) it has loaded.
    startBed(g, noise(ctx), SYNTH_BED_GAIN, true);
    recorded ??= decode(ctx);
    void recorded.then((buffer) => {
      if (buffer && playing && gen === generation)
        startBed(g, buffer, BED_RMS / rmsOf(buffer), false);
      if (!buffer) recorded = undefined;
    });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    if (!document.hidden) run();
  } catch {}
}

/** Fade the music out and stop it. */
export function stopMusic() {
  try {
    if (!playing || !graph) return;
    playing = false;
    const gen = generation;
    clearInterval(timer);
    fade(graph.master.gain, 0, 1.2);
    setTimeout(() => {
      if (!playing && gen === generation) stopBed();
    }, 1400);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
  } catch {}
}

/** Change the mood: the next steps take its tempo, notes and layers. */
export function setMusicMood(next: MusicMood) {
  if (next === mood) return;
  mood = next;
  if (!graph) return;
  try {
    const now = graph.ctx.currentTime;
    graph.melody.gain.setTargetAtTime(MOODS[mood].melody ? 1 : 0, now, 0.8);
    graph.echo.delayTime.setTargetAtTime(3 * stepLength(), now, 0.3);
  } catch {}
}

/** Dip the music for a moment so a riichi or a result is heard clearly. */
export function duckMusic(seconds = 1.6) {
  if (!graph || !playing) return;
  try {
    const p = graph.duck.gain,
      now = graph.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.setTargetAtTime(0.35, now, 0.06);
    p.setTargetAtTime(1, now + seconds, 0.5);
  } catch {}
}
