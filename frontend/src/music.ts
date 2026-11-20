// Table music: 「雪夜灯下的小魔术」 (assets/music/table-theme.m4a; see
// SOURCE.md there), looped. The file is cut so its closing ring-out already
// lies over its opening, so a plain loop has no seam. Nothing here throws.
// Off by default, like the table sounds.
import type { MusicMood } from "./music-mood";
import { context } from "./sounds";

const FILES = import.meta.glob<string>("./assets/music/*.m4a", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Average loudness (RMS) the piece is played at. */
const THEME_RMS = 0.022;
/** How far the music steps back while a result is on show. */
const REST_LEVEL = 0.55;

interface Graph {
  ctx: AudioContext;
  /** Fades the whole thing in and out. */
  master: GainNode;
  /** Dips under a riichi or a result, apart from the fades. */
  duck: GainNode;
  /** Steps back while a result is on show. */
  mood: GainNode;
}
let graph: Graph | undefined;
let mood: MusicMood = "play";
let playing = false;
let generation = 0;
let voices: AudioBufferSourceNode[] = [];
let loading: Promise<AudioBuffer | null> | undefined;

function build(ctx: AudioContext): Graph {
  const master = ctx.createGain(),
    duck = ctx.createGain(),
    moodGain = ctx.createGain();
  master.gain.value = 0;
  moodGain.gain.value = mood === "rest" ? REST_LEVEL : 1;
  moodGain.connect(master).connect(duck).connect(ctx.destination);
  return { ctx, master, duck, mood: moodGain };
}

function fade(param: AudioParam, to: number, seconds: number) {
  const now = graph!.ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(to, now + seconds);
}

/** Fetch and decode the piece once. */
function load(ctx: AudioContext) {
  return (loading ??= (async () => {
    const url = FILES["./assets/music/table-theme.m4a"];
    try {
      if (url)
        return await ctx.decodeAudioData(
          await (await fetch(url)).arrayBuffer(),
        );
    } catch {}
    // Nothing decoded (offline, say): try again next time.
    loading = undefined;
    return null;
  })());
}
function rmsOf(buffer: AudioBuffer) {
  let sum = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++)
    for (const v of buffer.getChannelData(c)) sum += v * v;
  return Math.sqrt(sum / (buffer.length * buffer.numberOfChannels)) || 1;
}
const levels = new WeakMap<AudioBuffer, number>();

function loop(g: Graph, buffer: AudioBuffer, rms: number) {
  const src = g.ctx.createBufferSource(),
    gain = g.ctx.createGain();
  let level = levels.get(buffer);
  if (level === undefined) levels.set(buffer, (level = rms / rmsOf(buffer)));
  src.buffer = buffer;
  src.loop = true;
  gain.gain.value = level;
  src.connect(gain).connect(g.mood);
  src.start();
  voices.push(src);
}
function stopVoices() {
  for (const v of voices)
    try {
      v.stop();
    } catch {}
  voices = [];
}

function onVisibility() {
  if (!graph || !playing) return;
  fade(graph.master.gain, document.hidden ? 0 : 1, document.hidden ? 0.4 : 1.5);
}
// Browsers keep audio silent until the page is touched; the first touch
// while the music is on lets it start.
function onGesture() {
  if (graph && playing && graph.ctx.state === "suspended")
    void graph.ctx.resume();
}

/** Start the music (fading in once it has loaded). Safe to call twice. */
export function startMusic() {
  try {
    if (playing) return;
    const ctx = context();
    graph ??= build(ctx);
    const g = graph,
      gen = ++generation;
    playing = true;
    stopVoices();
    void load(ctx).then((theme) => {
      if (!playing || gen !== generation || !theme) return;
      loop(g, theme, THEME_RMS);
      if (!document.hidden) fade(g.master.gain, 1, 2.5);
    });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
  } catch {}
}

/** Fade the music out and stop it. */
export function stopMusic() {
  try {
    if (!playing || !graph) return;
    playing = false;
    const gen = generation;
    fade(graph.master.gain, 0, 1.2);
    setTimeout(() => {
      if (!playing && gen === generation) stopVoices();
    }, 1400);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
  } catch {}
}

/** Step back while a result is on show; come forward again after. */
export function setMusicMood(next: MusicMood) {
  if (next === mood) return;
  mood = next;
  if (!graph) return;
  try {
    fade(graph.mood.gain, mood === "rest" ? REST_LEVEL : 1, 1.5);
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
