/**
 * 从天凤鳳凰卓牌谱学习大师级 AI 用的三张表：放铳率、未立直者的听牌概率、放铳代价。
 * `node --import tsx scripts/learn-tenhou.ts [牌谱目录]`（默认 data/tenhou/logs，*.xml）
 * 牌谱本身不入库（天凤条款不允许转载）；只把统计结果写入 backend/src/bot-learned-data.ts。
 *
 * - 放铳率：每次有人立直后，其他三家每次摸牌时，对手里的每种牌按 dangerKey 分类，
 *   记下它是否在立直者的听牌里（立直者振听时都不算）。用立直者的真实手牌判定，
 *   而不是只看实际打出的牌，所以不受“大家都挑安全牌打”的偏差影响。
 * - 听牌概率：未立直的人每次打牌后是否听牌，按副露数（不含暗杠）和舍牌数分组。
 * - 放铳代价：每次荣和的得点（不含本场），按和牌者立直、默听、副露（副露显示的番数）
 *   以及是否庄家分组。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import M from "@kobalab/majiang-core";
import { code } from "../backend/src/rules.ts";
import { dangerKey, stageOf, turnOf } from "../backend/src/bot-learned.ts";

const dir = process.argv[2] ?? "data/tenhou/logs";
const kind = (t: number) => t >> 2;
const RED = new Set([16, 52, 88]);

type MeldType = "CHI" | "PON" | "KAKAN" | "MINKAN" | "ANKAN";
interface Meld {
  type: MeldType;
  tiles: number[];
  /** Tiles that left the hand for it. */
  fromHand: number[];
}
/** Tenhou's packed meld code. */
function decode(m: number): {
  type: MeldType;
  tiles: number[];
  called: number | null;
  added: number | null;
} {
  if (m & 0x4) {
    let t = (m & 0xfc00) >> 10;
    const r = t % 3;
    t = Math.floor(t / 3);
    const base = Math.floor(t / 7) * 9 + (t % 7);
    const tiles = [(m >> 3) & 3, (m >> 5) & 3, (m >> 7) & 3].map(
      (o, i) => (base + i) * 4 + o,
    );
    return { type: "CHI", tiles, called: tiles[r], added: null };
  }
  if (m & 0x18) {
    let t = (m & 0xfe00) >> 9;
    const r = t % 3;
    t = Math.floor(t / 3);
    const unused = (m & 0x60) >> 5;
    const all = [0, 1, 2, 3].map((i) => t * 4 + i);
    const three = all.filter((_, i) => i !== unused);
    return m & 0x8
      ? { type: "PON", tiles: three, called: three[r], added: null }
      : { type: "KAKAN", tiles: all, called: null, added: all[unused] };
  }
  const hai0 = (m & 0xff00) >> 8,
    base = kind(hai0);
  const tiles = [0, 1, 2, 3].map((i) => base * 4 + i);
  return m & 3
    ? { type: "MINKAN", tiles, called: hai0, added: null }
    : { type: "ANKAN", tiles, called: null, added: null };
}

const shoupai = (tiles: number[], melds: number) => {
  const s = new M.Shoupai(tiles.map((t) => code(t)));
  // Shanten only counts the sets; their content does not matter here.
  s._fulou = Array(melds).fill("z111=");
  return s;
};
const kindOf = (c: string) =>
  c[0] === "z"
    ? 26 + Number(c[1])
    : ["m", "p", "s"].indexOf(c[0]) * 9 + (Number(c[1]) || 5) - 1;

// Tallies.
const danger = new Map<string, number[][]>(); // key → stage → [cases, hits]
const tenpai = [0, 1, 2, 3, 4].map(() =>
  Array.from({ length: 6 }, () => [0, 0]),
);
const loss = {
  riichi: [[], []] as number[][],
  dama: [[], []] as number[][],
  open: [0, 1, 2, 3, 4].map(() => [[], []] as number[][]),
};
let games = 0,
  hands = 0,
  riichis = 0;

const attrs = (s: string) =>
  Object.fromEntries(
    [...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );

for (const file of readdirSync(dir).filter((f) => f.endsWith(".xml"))) {
  const xml = readFileSync(join(dir, file), "utf8");
  if (!xml.includes("<INIT")) continue;
  games++;
  // Per-hand state.
  let hand: number[][] = [],
    melds: Meld[][] = [],
    discards: number[][] = [],
    indicators: number[] = [],
    publicSeen: number[] = [],
    dealer = 0,
    roundWind = 0,
    declaring = [false, false, false, false],
    riichi: ({
      waits: Set<number>;
      safe: Set<number>;
      furiten: boolean;
    } | null)[] = [];
  const open = (s: number) => melds[s].filter((m) => m.type !== "ANKAN").length;
  for (const [, tag, num, rest] of xml.matchAll(/<([A-Z]+)(\d*)([^>]*)>/g)) {
    const a = attrs(rest);
    if (tag === "INIT") {
      hands++;
      const seed = a.seed.split(",").map(Number);
      roundWind = Math.floor(seed[0] / 4);
      dealer = Number(a.oya);
      hand = [0, 1, 2, 3].map((s) => a[`hai${s}`].split(",").map(Number));
      melds = [[], [], [], []];
      discards = [[], [], [], []];
      indicators = [seed[5]];
      publicSeen = Array(34).fill(0);
      publicSeen[kind(seed[5])]++;
      declaring = [false, false, false, false];
      riichi = [null, null, null, null];
      continue;
    }
    const draw = "TUVW".indexOf(tag),
      drop = "DEFG".indexOf(tag);
    if (tag.length === 1 && draw >= 0 && num) {
      const o = draw,
        t = Number(num);
      hand[o].push(t);
      // A player in riichi has no choice to make.
      if (riichi[o]) continue;
      // The tiles this player could discard now, against each riichi.
      const seen = [...publicSeen];
      for (const x of hand[o]) seen[kind(x)]++;
      const held = [...new Set(hand[o].map(kind))];
      for (let r = 0; r < 4; r++) {
        const R = riichi[r];
        if (r === o || !R) continue;
        const safe = new Set([...discards[r].map(kind), ...R.safe]);
        const stage = stageOf(discards[r].length);
        for (const k of held) {
          const key = dangerKey(seen, safe, k);
          if (key === null) continue;
          let row = danger.get(key);
          if (!row) danger.set(key, (row = [0, 1, 2, 3].map(() => [0, 0])));
          row[stage][0]++;
          if (!R.furiten && R.waits.has(k)) row[stage][1]++;
        }
      }
      continue;
    }
    if (tag.length === 1 && drop >= 0 && num) {
      const s = drop,
        t = Number(num);
      hand[s].splice(hand[s].indexOf(t), 1);
      discards[s].push(t);
      publicSeen[kind(t)]++;
      for (let r = 0; r < 4; r++) {
        const R = riichi[r];
        if (!R || r === s) continue;
        R.safe.add(kind(t));
        if (R.waits.has(kind(t))) R.furiten = true;
      }
      if (riichi[s]) {
        if (riichi[s]!.waits.has(kind(t))) riichi[s]!.furiten = true;
      } else if (!declaring[s]) {
        const n = melds[s].length;
        const st = M.Util.xiangting(shoupai(hand[s], n));
        const cell = tenpai[open(s)][turnOf(discards[s].length)];
        cell[0]++;
        if (st === 0) cell[1]++;
      }
      continue;
    }
    if (tag === "REACH") {
      const s = Number(a.who);
      if (a.step === "1") declaring[s] = true;
      else {
        declaring[s] = false;
        riichis++;
        const p = shoupai(hand[s], melds[s].length);
        const waits = new Set<number>(
          M.Util.xiangting(p) === 0
            ? (M.Util.tingpai(p) as string[]).map(kindOf)
            : [],
        );
        riichi[s] = {
          waits,
          safe: new Set(),
          furiten: discards[s].some((t) => waits.has(kind(t))),
        };
      }
      continue;
    }
    if (tag === "N") {
      const s = Number(a.who),
        d = decode(Number(a.m));
      if (d.type === "KAKAN") {
        const pon = melds[s].find(
          (m) => m.type === "PON" && kind(m.tiles[0]) === kind(d.added!),
        );
        if (pon) {
          pon.type = "KAKAN";
          pon.tiles = d.tiles;
        }
        hand[s].splice(hand[s].indexOf(d.added!), 1);
        publicSeen[kind(d.added!)]++;
        continue;
      }
      const fromHand = d.tiles.filter((t) => t !== d.called);
      for (const t of fromHand) {
        const i = hand[s].indexOf(t);
        if (i >= 0) hand[s].splice(i, 1);
        publicSeen[kind(t)]++;
      }
      melds[s].push({ type: d.type, tiles: d.tiles, fromHand });
      continue;
    }
    if (tag === "DORA") {
      const t = Number(a.hai);
      indicators.push(t);
      publicSeen[kind(t)]++;
      continue;
    }
    if (tag === "AGARI") {
      const who = Number(a.who),
        from = Number(a.fromWho);
      if (who === from) continue;
      const pts = Number(a.ten.split(",")[1]);
      const isDealer = who === dealer ? 1 : 0;
      if (riichi[who]) loss.riichi[isDealer].push(pts);
      else if (open(who) === 0) loss.dama[isDealer].push(pts);
      else {
        // The han the sets show: 役牌 and dora (red fives included).
        const dora = indicators.map((t) => {
          const k = kind(t);
          return k < 27
            ? Math.floor(k / 9) * 9 + (((k % 9) + 1) % 9)
            : k < 31
              ? 27 + ((k - 27 + 1) % 4)
              : 31 + ((k - 31 + 1) % 3);
        });
        const seatWind = (who - dealer + 4) % 4;
        let han = 0;
        for (const m of melds[who]) {
          const k = kind(m.tiles[0]);
          if (m.type !== "CHI" && k >= 27)
            han +=
              Number(k >= 31) +
              Number(k === 27 + seatWind) +
              Number(k === 27 + roundWind);
          for (const t of m.tiles)
            han +=
              dora.filter((x) => x === kind(t)).length + Number(RED.has(t));
        }
        loss.open[Math.min(4, han)][isDealer].push(pts);
      }
    }
  }
}

// Shrink small groups toward their parent rate.
const smooth = (hits: number, n: number, prior: number, weight: number) =>
  (hits + weight * prior) / (n + weight);
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[], fallback: number) =>
  xs.length >= 30
    ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length / 100) * 100
    : fallback;

const dangerOut: Record<string, number[]> = {};
const dangerCounts: Record<string, number[]> = {};
for (const [key, row] of [...danger].sort()) {
  const n = row.reduce((a, c) => a + c[0], 0),
    hits = row.reduce((a, c) => a + c[1], 0);
  if (n < 200) continue;
  const all = hits / n;
  dangerOut[key] = row.map((c) => round(smooth(c[1], c[0], all, 100)));
  dangerCounts[key] = row.map((c) => c[0]);
}
const tenpaiOut = tenpai.map((row) => {
  const n = row.reduce((a, c) => a + c[0], 0),
    hits = row.reduce((a, c) => a + c[1], 0),
    all = n ? hits / n : 0;
  return row.map((c) => round(smooth(c[1], c[0], all, 50), 3));
});
// Fallbacks: the hand-made values used before.
const OPEN_FALLBACK = [1500, 1500, 2900, 5200, 8000];
const lossOut = {
  riichi: [mean(loss.riichi[0], 7500), mean(loss.riichi[1], 10900)],
  dama: [mean(loss.dama[0], 5200), mean(loss.dama[1], 7700)],
  open: OPEN_FALLBACK.map((v, h) => [
    mean(loss.open[h][0], v),
    mean(loss.open[h][1], v * 1.5),
  ]),
};

const json = (x: unknown) => JSON.stringify(x);
writeFileSync(
  "backend/src/bot-learned-data.ts",
  `// Generated by scripts/learn-tenhou.ts from ${games} Tenhou 鳳凰卓 games (${hands} hands, ${riichis} riichi).
// Do not edit by hand; see backend/src/bot-learned.ts for what each table means.
export const LEARNED = {
  /** dangerKey → chance per riichi stage (discards ≤6, 7–9, 10–12, 13+). */
  danger: ${json(dangerOut)} as Record<string, number[]>,
  /** [open sets 0–4][discards 0–2, 3–5, … 15+] → chance of tenpai without riichi. */
  tenpai: ${json(tenpaiOut)} as number[][],
  /** Average ron points: [non-dealer, dealer]; open by the han its sets show (0–4+). */
  loss: ${json(lossOut)},
};
`,
);
writeFileSync(
  "data/tenhou/learned-summary.json",
  JSON.stringify(
    {
      games,
      hands,
      riichis,
      dangerCounts,
      tenpaiCounts: tenpai.map((r) => r.map((c) => c[0])),
      tenpaiRaw: tenpai.map((r) =>
        r.map((c) => (c[0] ? round(c[1] / c[0], 3) : null)),
      ),
      lossCounts: {
        riichi: loss.riichi.map((x) => x.length),
        dama: loss.dama.map((x) => x.length),
        open: loss.open.map((r) => r.map((x) => x.length)),
      },
    },
    null,
    1,
  ),
);
console.log(
  `${games} games, ${hands} hands, ${riichis} riichi; ${Object.keys(dangerOut).length} danger classes`,
);
