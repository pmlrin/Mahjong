// Writes the table music, 「灯下」, to a WAV file:
//   node --import tsx scripts/compose-table-music.ts out.wav
// then: afconvert -f m4af -d aac -b 160000 out.wav frontend/src/assets/music/table-theme.m4a
//
// A fixed score, not generated: 32 bars in F major at 72 bpm, about 107
// seconds. Felt piano carries the tune over a warm pad; a music box doubles
// it in the third section and glints at the end of each section (the little
// magic of the copy: a snowy night, a lamp already lit). The tune keeps to
// the pentatonic notes F G A C D. Everything is synthesised here, with no
// samples, and a fixed seed, so the file is the same each time.
//
// The piece is rendered three times end to end, each pass from the same seed
// so all three are identical, and the middle pass kept: it holds the tails of
// the pass before (ringing notes, the reverb) and the early notes of the pass
// after, so it loops without a seam.
import fs from "node:fs";

const SR = 44100;
const BPM = 72;
const BEAT = 60 / BPM;
const BARS = 32;
const LOOP = BARS * 4 * BEAT; // 106.67 s
const N = Math.round(LOOP * SR); // 4,704,000 samples, exactly
const TOTAL = 3 * N;

const left = new Float32Array(TOTAL),
  right = new Float32Array(TOTAL);

const SEED = 20261119;
let seed = SEED;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const jitter = (amount: number) => (rand() * 2 - 1) * amount;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
function pan(p: number) {
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)] as const;
}

/**
 * One sine partial with an exponential decay that steepens once the key is
 * let go (`hold` seconds in). A recurrence keeps it cheap.
 */
function partial(
  start: number,
  freq: number,
  amp: number,
  tau: number,
  hold: number,
  releaseTau: number,
  p: number,
  attack = 0.003,
) {
  if (freq >= SR / 2.2 || amp < 1e-6) return;
  const [gl, gr] = pan(p);
  const w = (2 * Math.PI * freq) / SR,
    k = 2 * Math.cos(w);
  let s1 = 0,
    s2 = -Math.sin(w);
  const decay = Math.exp(-1 / (tau * SR)),
    release = Math.exp(-1 / (Math.min(tau, releaseTau) * SR));
  const first = Math.round(start * SR),
    holdAt = Math.round(hold * SR),
    att = Math.max(1, Math.round(attack * SR));
  let env = amp;
  for (let i = 0; ; i++) {
    const at = first + i;
    if (at >= TOTAL || env < amp * 2e-4) break;
    const s = k * s1 - s2;
    s2 = s1;
    s1 = s;
    if (at >= 0) {
      const v = s * env * (i < att ? i / att : 1);
      left[at] += v * gl;
      right[at] += v * gr;
    }
    env *= i < holdAt ? decay : release;
  }
}

/** Felt piano: soft hammers, slightly stretched partials, a doubled string. */
function piano(start: number, midi: number, vel: number, hold: number) {
  const f0 = hz(midi),
    p = Math.max(-0.55, Math.min(0.55, (midi - 62) / 36)),
    t0 = Math.max(1.4, Math.min(9, 5 * (261.6 / f0) ** 0.55)),
    tilt = 2.3 - 0.9 * vel;
  for (let n = 1; n <= 12; n++) {
    const f = n * f0 * Math.sqrt(1 + 0.00025 * n * n);
    if (f > 7500) break;
    const amp = 0.11 * vel * n ** -tilt,
      tau = t0 / (1 + 0.4 * (n - 1) ** 1.15);
    partial(start, f, amp, tau, hold, 0.14, p);
    if (n <= 3) partial(start, f * 1.0007, amp * 0.4, tau * 1.2, hold, 0.14, p);
  }
  // The felt on the string: a tiny dull knock.
  const at = Math.round(start * SR),
    [gl, gr] = pan(p);
  let lp = 0;
  for (let i = 0; i < SR * 0.015; i++) {
    lp += 0.08 * (rand() * 2 - 1 - lp);
    const v = lp * 0.05 * vel * (1 - i / (SR * 0.015));
    if (at + i < TOTAL) {
      left[at + i] += v * gl;
      right[at + i] += v * gr;
    }
  }
}

/** Music box: a bright, short tine. */
function musicBox(start: number, midi: number, vel: number) {
  const f0 = hz(midi),
    p = 0.35 * Math.sin(midi);
  for (const [ratio, amp, tau] of [
    [1, 1, 1.9],
    [2, 0.22, 0.8],
    [3, 0.08, 0.35],
    [5.43, 0.05, 0.12],
  ])
    partial(start, f0 * ratio, 0.05 * vel * amp, tau, 99, tau, p, 0.0015);
}

/** A warm pad: soft, detuned and rolled off, swelling in and letting go. */
function pad(start: number, notes: number[], length: number, level: number) {
  const a = Math.round(2 * SR),
    r = Math.round(2.5 * SR),
    hold = Math.round(length * SR),
    first = Math.round(start * SR);
  for (const midi of notes)
    for (const [cents, p] of [
      [-5, -0.6],
      [5, 0.6],
    ]) {
      const f0 = hz(midi) * 2 ** (cents / 1200),
        [gl, gr] = pan(p);
      for (let h = 1; h <= 6; h++) {
        const f = f0 * h;
        const amp =
          (0.009 * level * Math.min(1, 900 / f)) / h ** 1.1;
        const w = (2 * Math.PI * f) / SR,
          k = 2 * Math.cos(w);
        const ph = rand() * 2 * Math.PI;
        let s1 = Math.sin(ph),
          s2 = Math.sin(ph - w);
        for (let i = 0; i < hold + r; i++) {
          const at = first + i;
          if (at >= TOTAL) break;
          const s = k * s1 - s2;
          s2 = s1;
          s1 = s;
          const env =
            i < a ? i / a : i < hold ? 1 : 1 - (i - hold) / r;
          const v = s * amp * env;
          left[at] += v * gl;
          right[at] += v * gr;
        }
      }
    }
}

// ---- The score -----------------------------------------------------------

/** Each chord: a bass note, four upper notes (low to high). */
const C: Record<string, [number, number[]]> = {
  Fmaj9: [41, [57, 60, 64, 67]],
  Fmaj7: [41, [57, 60, 64, 69]],
  Dm9: [38, [53, 57, 60, 64]],
  Bbmaj7: [46, [53, 57, 62, 65]],
  Bbmaj9: [46, [57, 60, 62, 65]],
  C69: [36, [55, 57, 62, 64]],
  C9sus: [36, [55, 58, 62, 65]],
  C9: [36, [52, 58, 62, 67]],
  Am7: [45, [55, 60, 64, 67]],
  FoverA: [45, [53, 60, 64, 67]],
  Gm7: [43, [53, 58, 62, 65]],
  Gm9: [43, [58, 62, 65, 69]],
};
/** Bars as chord names; "X Y" splits the bar in two halves. */
const CHORDS = [
  // A: the door opens, the lamp is lit.
  "Fmaj9", "Dm9", "Bbmaj7", "C69", "Fmaj9", "Am7", "Bbmaj7", "C9sus",
  // B: settling in by the stove.
  "Dm9", "Bbmaj9", "FoverA", "Gm7 C9", "Dm9", "Bbmaj9", "Gm9", "C9sus",
  // A': the tune again, with the music box.
  "Fmaj9", "Dm9", "Bbmaj7", "C69", "Fmaj9", "Am7", "Bbmaj7", "C9sus",
  // C: snow outside; space between the notes.
  "Bbmaj7", "Am7", "Gm7", "Fmaj7", "Bbmaj7", "Am7", "Gm9", "C9sus",
];
const N_ = (name: string) => {
  const m = /^([A-G])(b?)(\d)$/.exec(name);
  if (!m) throw new Error("bad note " + name);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]!;
  return 12 * (Number(m[3]) + 1) + base - (m[2] ? 1 : 0);
};
/** The tune, one string per bar: note:beats, r for a rest. */
const A_TUNE = [
  "r:1 A4:1 C5:1 D5:1",
  "F5:2 E5:1 D5:1",
  "D5:3 C5:1",
  "G4:4",
  "r:1 A4:1 C5:1 D5:1",
  "G5:1.5 E5:0.5 D5:1 C5:1",
  "D5:2 F5:1 D5:1",
  "C5:4",
];
const TUNE = [
  ...A_TUNE,
  "r:1 D5:1 E5:1 F5:1",
  "A5:2 G5:1 F5:1",
  "G5:1 F5:1 C5:2",
  "D5:2 C5:1 Bb4:1",
  "A4:1 D5:1 F5:1 A5:1",
  "G5:3 F5:1",
  "F5:1 D5:1 C5:1 A4:1",
  "G4:4",
  ...A_TUNE,
  "r:2 F5:2",
  "E5:4",
  "r:2 D5:1 F5:1",
  "C5:4",
  "r:2 A5:1 F5:1",
  "G5:2 E5:2",
  "F5:2 D5:1 C5:1",
  "C5:2 r:2",
];
/** The music box's glint: a quick rising (or, last, falling) figure. */
const GLINTS: Record<number, number[]> = {
  7: [84, 86, 89, 93],
  15: [84, 86, 89, 93],
  23: [86, 89, 93, 96],
  31: [93, 89, 86, 84],
};

if (CHORDS.length !== BARS || TUNE.length !== BARS)
  throw new Error("the score is not 32 bars");

function section(bar: number) {
  return bar < 8 ? "A" : bar < 16 ? "B" : bar < 24 ? "A2" : "C";
}

function renderOnce(offset: number) {
  seed = SEED;
  for (let bar = 0; bar < BARS; bar++) {
    const t = offset + bar * 4 * BEAT,
      part = section(bar),
      names = CHORDS[bar].split(" "),
      span = 4 / names.length;
    names.forEach((name, half) => {
      const [bass, upper] = C[name],
        at = t + half * span * BEAT,
        holdFor = span * BEAT + 0.15;
      pad(at, upper, span * BEAT, part === "C" ? 0.75 : part === "A" ? 0.85 : 1);
      piano(at + jitter(0.006), bass, 0.4, holdFor);
      // Broken chord, sparser in the snowy last section.
      const pattern: [number, number, number][] =
        part === "C"
          ? [
              [0, 0, 0.24],
              [0.04, 1, 0.22],
              [0.08, 2, 0.2],
              [2.5, 3, 0.18],
            ]
          : [
              [0, 0, 0.32],
              [1, 1, 0.28],
              [1.5, 2, 0.26],
              [2, 3, 0.3],
              ...(part === "B" ? [[2.5, 0, 0.22] as [number, number, number]] : []),
              [3, 1, 0.24],
              [3.5, 2, 0.2],
            ];
      for (const [beat, which, vel] of pattern) {
        if (beat >= span) continue;
        const when = at + beat * BEAT + jitter(0.008);
        piano(when, upper[which], vel * (0.92 + 0.16 * rand()), at + holdFor - when);
      }
    });
    // The tune, a touch behind the beat.
    let beat = 0;
    for (const token of TUNE[bar].split(" ")) {
      const [name, len] = token.split(":"),
        beats = Number(len);
      if (name !== "r") {
        const midi = N_(name),
          when = t + beat * BEAT + 0.012 + jitter(0.006),
          vel = 0.56 + (beat === 0 ? 0.08 : 0) + (beats >= 2 ? 0.04 : 0) + jitter(0.04);
        piano(when, midi, vel, beats * BEAT + 0.12);
        if (part === "A2") musicBox(when + 0.004, midi + 12, 0.38);
      }
      beat += beats;
    }
    if (Math.abs(beat - 4) > 1e-9) throw new Error(`bar ${bar + 1} has ${beat} beats`);
    const glint = GLINTS[bar];
    if (glint)
      glint.forEach((midi, i) =>
        musicBox(t + (bar === 31 ? 2 : 3) * BEAT + (i * BEAT) / 4, midi, 0.42 - i * 0.04),
      );
  }
}

// ---- Room and master ------------------------------------------------------

/** Freeverb: eight damped combs and four allpasses per side. */
function reverb(inL: Float32Array, inR: Float32Array) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617],
    allpasses = [556, 441, 341, 225],
    spread = 23,
    feedback = 0.86,
    damp = 0.35,
    pre = Math.round(0.025 * SR);
  const outL = new Float32Array(TOTAL),
    outR = new Float32Array(TOTAL);
  for (const [out, extra] of [
    [outL, 0],
    [outR, spread],
  ] as const) {
    const cb = combs.map((n) => ({ buf: new Float32Array(n + extra), i: 0, store: 0 }));
    const ab = allpasses.map((n) => ({ buf: new Float32Array(n + extra), i: 0 }));
    for (let s = 0; s < TOTAL; s++) {
      const j = s - pre,
        input = j >= 0 ? (inL[j] + inR[j]) * 0.015 : 0;
      let acc = 0;
      for (const c of cb) {
        const y = c.buf[c.i];
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.i] = input + c.store * feedback;
        if (++c.i >= c.buf.length) c.i = 0;
        acc += y;
      }
      for (const a of ab) {
        const y = a.buf[a.i];
        a.buf[a.i] = acc + y * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        acc = y - acc;
      }
      out[s] = acc;
    }
  }
  return [outL, outR] as const;
}

function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: compose-table-music.ts out.wav");
  for (let pass = 0; pass < 3; pass++) renderOnce(pass * LOOP);
  const [wl, wr] = reverb(left, right);
  const WET = 0.32;
  // Keep the middle pass.
  const mixL = new Float32Array(N),
    mixR = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const s = N + i;
    // A soft tape-like curve rounds the few loudest moments.
    mixL[i] = Math.tanh((left[s] + WET * (wl[s] * 0.75 + wr[s] * 0.25)) * 1.3);
    mixR[i] = Math.tanh((right[s] + WET * (wr[s] * 0.75 + wl[s] * 0.25)) * 1.3);
    peak = Math.max(peak, Math.abs(mixL[i]), Math.abs(mixR[i]));
  }
  const gain = 0.89 / peak; // −1 dBFS
  const data = Buffer.alloc(44 + N * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + N * 4, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(N * 4, 40);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const l = mixL[i] * gain,
      r = mixR[i] * gain;
    sum += l * l + r * r;
    data.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    data.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  fs.writeFileSync(out, data);
  console.log(
    `${out}: ${(N / SR).toFixed(2)} s, ${N} frames, peak −1 dBFS, rms ${Math.sqrt(sum / (2 * N)).toFixed(4)}`,
  );
}
main();
