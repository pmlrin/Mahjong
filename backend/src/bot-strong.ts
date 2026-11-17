import M from "@kobalab/majiang-core";
import {
  kind,
  isRed,
  type MatchView,
  type Meld,
  type Option,
  type Seat,
} from "../../shared/types.ts";
import { shanten, hand, terminal, closed, score, waits } from "./rules.ts";

/**
 * 高级 ADVANCED and 大师级 MASTER.
 *
 * Both read the same restricted seat view as the lower levels and share the tile
 * counting, the deal-in model (現物、筋、字牌枚数) and the hand valuation below.
 *
 * ADVANCED turns them into rules: against a riichi (or three open sets) it pushes
 * only a ready hand or a valuable one-shanten, otherwise folds to the safest tile;
 * it keeps dora, stays quiet with a hand that is already 満貫, and does not open a
 * closed hand that is about to riichi.
 *
 * MASTER prices every discard as (chance to win × hand value) against (chance to
 * deal in × what it would cost), so pushing and folding is a matter of degree.
 * It also knows more: tiles that passed a riichi are safe, a 壁 kills a two-sided
 * wait, an open hand with two or more sets is a threat with a price, and an open
 * hand of its own only advances along a route that still has a yaku.
 */
export type StrongLevel = "ADVANCED" | "MASTER";

export function finalStage(view: MatchView): boolean {
  return (
    view.hand.isExtension ||
    (view.hand.roundWind === (view.format === "HANCHAN" ? "SOUTH" : "EAST") &&
      view.hand.roundNumber === 4)
  );
}

interface Threat {
  seat: Seat;
  /** Chance this player is tenpai. */
  prob: number;
  /** Points a deal-in is expected to cost. */
  loss: number;
  safe: Set<number>;
  discards: number;
  riichi: boolean;
}
interface Ctx {
  view: MatchView;
  level: StrongLevel;
  s: Seat;
  tiles: number[];
  melds: Meld[];
  seen: number[];
  unseen: number;
  dealer: boolean;
  seatWind: number;
  roundWind: number;
  dora: number[];
  wallLeft: number;
  turnsLeft: number;
  threats: Threat[];
  ownDiscards: Set<number>;
  final: boolean;
  leading: boolean;
  points: number;
  cache: Map<string, Shape>;
}
interface Shape {
  st: number;
  uke: number;
  kinds: number[];
}
interface Tenpai {
  waits: number[];
  left: number;
  furiten: boolean;
  /** Expected points without riichi; 0 when the hand has no yaku to ron with. */
  dama: number;
  /** Expected points after declaring riichi (closed hands only). */
  riichi: number;
  /** Whether a ron is possible without riichi. */
  ronYaku: boolean;
}

const kindOf = (c: string) =>
  c[0] === "z"
    ? 26 + Number(c[1])
    : ["m", "p", "s"].indexOf(c[0]) * 9 + (Number(c[1]) || 5) - 1;
const up100 = (n: number) => Math.ceil(n / 100) * 100;

function context(view: MatchView, level: StrongLevel): Ctx {
  const s = view.viewerSeat,
    h = view.hand;
  const tiles = [
    ...view.self.concealedTiles,
    ...(view.self.drawnTile === null ? [] : [view.self.drawnTile]),
  ];
  const seen = Array(34).fill(0);
  for (const t of tiles) seen[kind(t)]++;
  for (const p of h.seats) {
    for (const x of p.discards.filter((x) => !x.claimedByMeldId))
      seen[kind(x.tile)]++;
    for (const m of p.melds) for (const t of m.tiles) seen[kind(t)]++;
  }
  for (const t of h.doraIndicators) seen[kind(t)]++;
  const dora = h.doraIndicators.map((t) => {
    const k = kind(t);
    return k < 27
      ? Math.floor(k / 9) * 9 + (((k % 9) + 1) % 9)
      : k < 31
        ? 27 + ((k - 27 + 1) % 4)
        : 31 + ((k - 31 + 1) % 3);
  });
  const roundWind = ["EAST", "SOUTH", "WEST", "NORTH"].indexOf(h.roundWind);
  const points = view.players[s].points;
  const c: Ctx = {
    view,
    level,
    s,
    tiles,
    melds: h.seats[s].melds,
    seen,
    unseen: Math.max(20, 136 - seen.reduce((a, b) => a + b, 0)),
    dealer: h.dealerSeat === s,
    seatWind: (s - h.dealerSeat + 4) % 4,
    roundWind,
    dora,
    wallLeft: h.liveWallRemaining,
    turnsLeft: Math.ceil(h.liveWallRemaining / 4),
    threats: [],
    ownDiscards: new Set(h.seats[s].discards.map((x) => kind(x.tile))),
    final: finalStage(view),
    leading: view.players.every((p) => p.points <= points),
    points,
    cache: new Map(),
  };
  for (const p of h.seats) {
    if (p.seat === s) continue;
    const riichi = p.riichi !== "NONE";
    const open = p.melds.filter((m) => m.type !== "ANKAN");
    const dealer = h.dealerSeat === p.seat;
    let prob = 0,
      loss = 0;
    if (riichi) {
      prob = 1;
      loss = (dealer ? 10900 : 7500) + h.honba * 300;
    } else if (open.length) {
      const n = open.length,
        d = p.discards.length;
      // ADVANCED only respects a hand that is visibly almost complete.
      if (level === "ADVANCED") prob = n >= 3 ? 0.8 : 0;
      else
        prob =
          n >= 4
            ? 0.95
            : n === 3
              ? 0.75
              : n === 2
                ? d >= 9
                  ? 0.5
                  : 0.25
                : d >= 12
                  ? 0.2
                  : 0;
      const wind = (p.seat - h.dealerSeat + 4) % 4;
      let han = 0.5;
      for (const m of open) {
        const k = kind(m.tiles[0]);
        if (m.type !== "CHI" && k >= 27) {
          if (k >= 31) han++;
          if (k === 27 + wind) han++;
          if (k === 27 + roundWind) han++;
        }
        for (const t of m.tiles) han += doraOf(c, t);
      }
      const pts =
        han < 2
          ? 1500
          : han < 3
            ? 2900
            : han < 4
              ? 5200
              : han < 6
                ? 8000
                : 12000;
      loss = pts * (dealer ? 1.5 : 1) + h.honba * 300;
    }
    if (prob < 0.2) continue;
    const safe = new Set(p.discards.map((x) => kind(x.tile)));
    const declared = p.discards.findIndex((x) => x.riichiDeclaration);
    if (level === "MASTER" && riichi && declared >= 0) {
      // Whatever went past a riichi without being called is safe against it for good.
      // Discards carry no table-wide order, so count turns, allowing one turn of drift per call.
      const calls = h.seats.reduce(
        (n, q) => n + q.melds.filter((m) => m.type !== "ANKAN").length,
        0,
      );
      const order = (q: Seat) => (q - h.dealerSeat + 4) % 4;
      for (const q of h.seats) {
        if (q.seat === p.seat) continue;
        q.discards.forEach((x, j) => {
          if (
            j > declared + calls ||
            (!calls && j === declared && order(q.seat) > order(p.seat))
          )
            safe.add(kind(x.tile));
        });
      }
    }
    c.threats.push({
      seat: p.seat,
      prob,
      loss,
      safe,
      discards: p.discards.length,
      riichi,
    });
  }
  return c;
}

const doraOf = (c: Ctx, tile: number) =>
  c.dora.filter((k) => k === kind(tile)).length + (isRed(tile) ? 1 : 0);
const valueHonor = (c: Ctx, k: number) =>
  k >= 31 || k === 27 + c.seatWind || k === 27 + c.roundWind;
const yakuhaiHan = (c: Ctx, k: number) =>
  k < 27
    ? 0
    : Number(k >= 31) +
      Number(k === 27 + c.seatWind) +
      Number(k === 27 + c.roundWind);

/** Shanten and the live tiles that bring the hand one step closer. */
function shape(c: Ctx, tiles: number[], melds: Meld[]): Shape {
  const key =
    melds.length +
    ":" +
    tiles
      .map(kind)
      .sort((a, b) => a - b)
      .join(",");
  const hit = c.cache.get(key);
  if (hit) return hit;
  const p = hand(tiles, melds, c.s);
  const st: number = M.Util.xiangting(p);
  const own = Array(34).fill(0);
  for (const t of tiles) own[kind(t)]++;
  let uke = 0;
  const kinds: number[] = [];
  for (const code of (M.Util.tingpai(p) ?? []) as string[]) {
    const k = kindOf(code),
      left = Math.max(0, 4 - c.seen[k]);
    if (own[k] >= 4) continue;
    kinds.push(k);
    uke += left;
  }
  const r = { st, uke, kinds };
  c.cache.set(key, r);
  return r;
}

/**
 * An open hand only counts as advancing if it still has a yaku to win with:
 * a 役牌 set lets every tile work, otherwise only the 断幺九 part of the hand does.
 */
function route(c: Ctx, tiles: number[], melds: Meld[], strict = false): Shape {
  if (closed(melds)) return shape(c, tiles, melds);
  const yakuhai =
    melds.some((m) => m.type !== "CHI" && yakuhaiHan(c, kind(m.tiles[0]))) ||
    [27, 28, 29, 30, 31, 32, 33].some(
      (k) => yakuhaiHan(c, k) && tiles.filter((t) => kind(t) === k).length >= 3,
    );
  if (yakuhai) return shape(c, tiles, melds);
  // No route (terminals melded, no 役牌): a call must not lead here; a hand already
  // there keeps its shape and hopes for a late yaku.
  if (melds.some((m) => m.tiles.some((t) => terminal(kind(t)))))
    return strict ? { st: 8, uke: 0, kinds: [] } : shape(c, tiles, melds);
  const sh = shape(
    c,
    tiles.filter((t) => !terminal(kind(t))),
    melds,
  );
  const kinds = sh.kinds.filter((k) => !terminal(k));
  return {
    st: sh.st,
    kinds,
    uke: kinds.reduce((n, k) => n + Math.max(0, 4 - c.seen[k]), 0),
  };
}

/**
 * Chance that discarding kind `k` deals into `t`, given that `t` is tenpai.
 * 現物 is safe; number tiles are graded by how many two-sided waits could still take
 * them (筋 and 壁 remove a side); honors by how many copies are still unaccounted for.
 */
export function dangerRate(
  seen: number[],
  safe: Set<number>,
  k: number,
  discards = 9,
  walls = true,
): number {
  if (safe.has(k)) return 0;
  const left = 4 - seen[k];
  let rate: number;
  if (k >= 27)
    rate = left <= 0 ? 0.002 : left === 1 ? 0.012 : left === 2 ? 0.03 : 0.05;
  else {
    const n = (k % 9) + 1,
      base = k - (n - 1);
    const gone = (m: number) => safe.has(base + m - 1);
    const wall = (m: number) => walls && seen[base + m - 1] >= 4;
    const lower = n >= 4 && !gone(n - 3) && !wall(n - 1) && !wall(n - 2);
    const upper = n <= 6 && !gone(n + 3) && !wall(n + 1) && !wall(n + 2);
    const sides = Number(lower) + Number(upper),
      edge = Math.min(n, 10 - n);
    if (sides === 2) rate = 0.125;
    else if (sides === 1)
      rate = edge === 1 ? 0.06 : edge === 2 ? 0.075 : edge === 3 ? 0.085 : 0.08;
    else {
      rate = edge === 1 ? 0.022 : edge === 2 ? 0.04 : edge === 3 ? 0.05 : 0.035;
      if (left <= 0) rate *= 0.4;
    }
  }
  return Math.min(0.5, rate * (0.7 + 0.03 * Math.min(18, discards)));
}

interface Risk {
  /** Chance of dealing in to anyone. */
  p: number;
  /** Expected points lost. */
  loss: number;
}
function risk(c: Ctx, tile: number): Risk {
  let keep = 1,
    loss = 0;
  const k = kind(tile);
  for (const t of c.threats) {
    const p =
      t.prob * dangerRate(c.seen, t.safe, k, t.discards, c.level === "MASTER");
    keep *= 1 - p;
    loss += p * t.loss * (1 + 0.4 * doraOf(c, tile));
  }
  return { p: 1 - keep, loss };
}

/** Rough han a hand is heading for, used while it is not tenpai yet. */
function estimate(c: Ctx, tiles: number[], melds: Meld[]) {
  const count = Array(34).fill(0);
  for (const t of tiles) count[kind(t)]++;
  const meldTiles = melds.flatMap((m) => m.tiles);
  let han = 0;
  for (const t of meldTiles) han += doraOf(c, t);
  for (const t of tiles) {
    const w = doraOf(c, t);
    if (!w) continue;
    const k = kind(t),
      n = k % 9;
    const near =
      count[k] >= 2 ||
      (k < 27 &&
        [-2, -1, 1, 2].some(
          (d) => n + d >= 0 && n + d <= 8 && count[k + d] > 0,
        ));
    han += w * (near ? 0.9 : 0.45);
  }
  let yakuhai = 0;
  for (const m of melds)
    if (m.type !== "CHI") yakuhai += yakuhaiHan(c, kind(m.tiles[0]));
  for (let k = 27; k < 34; k++) {
    const y = yakuhaiHan(c, k);
    if (!y) continue;
    if (count[k] >= 3) yakuhai += y;
    else if (count[k] === 2 && c.seen[k] < 4) han += 0.5 * y;
  }
  han += yakuhai;
  const isClosed = closed(melds);
  const simple = [...tiles, ...meldTiles].every((t) => !terminal(kind(t)));
  const rough = tiles.filter((t) => terminal(kind(t))).length;
  let yaku = true;
  if (isClosed) han += 1.4 + (rough <= 2 ? 0.5 : 0);
  else {
    if (simple) han++;
    yaku = yakuhai > 0 || simple;
  }
  return { han, yaku };
}
function pointsFor(c: Ctx, han: number, yaku = true): number {
  const table = [700, 1300, 2600, 5200, 7900, 8300, 12000, 12500, 16000];
  const h = Math.max(0, Math.min(8, han)),
    i = Math.floor(h),
    v = i >= 8 ? table[8] : table[i] + (table[i + 1] - table[i]) * (h - i);
  return v * (c.dealer ? 1.5 : 1) * (yaku ? 1 : 0.3);
}

/** Exact value of a tenpai hand, averaged over its live waits. */
function tenpai(c: Ctx, tiles: number[], melds: Meld[]): Tenpai | null {
  const w = waits(tiles, melds, c.s);
  if (!w.length) return null;
  const own = new Set([...tiles, ...melds.flatMap((m) => m.tiles)]);
  const h = c.view.hand;
  let left = 0,
    dama = 0,
    riichi = 0,
    weight = 0,
    ronYaku = false;
  const isClosed = closed(melds);
  for (const k of w) {
    const live = Math.max(0, 4 - c.seen[k]);
    left += live;
    const id =
      [0, 1, 2, 3]
        .map((j) => k * 4 + j)
        .find((t) => !own.has(t) && !isRed(t)) ?? k * 4;
    const value = (source: Seat | null, declared: number) => {
      const win = score({
        seat: c.s,
        dealer: h.dealerSeat,
        round: c.roundWind,
        tiles,
        drawn: source === null ? id : null,
        melds,
        winningTile: id,
        source,
        riichi: declared,
        ippatsu: false,
        haitei: false,
        rinshan: false,
        chankan: false,
        first: false,
        indicators: h.doraIndicators,
        ura: [],
      });
      if (!win) return 0;
      const b = win.basePoints;
      return source === null
        ? c.dealer
          ? 3 * up100(b * 2)
          : up100(b * 2) + 2 * up100(b)
        : up100(b * (c.dealer ? 6 : 4));
    };
    const other = ((c.s + 1) % 4) as Seat,
      ron = value(other, 0),
      tsumo = value(null, 0);
    if (ron > 0) ronYaku = true;
    const x = Math.max(live, 0.01);
    weight += x;
    dama += x * (ron > 0 ? 0.65 * ron + 0.35 * tsumo : 0.35 * tsumo);
    if (isClosed)
      // Ura dora and ippatsu are worth about a sixth of a riichi hand.
      riichi += x * 1.15 * (0.65 * value(other, 1) + 0.35 * value(null, 1));
  }
  return {
    waits: w,
    left,
    furiten: w.some((k) => c.ownDiscards.has(k)),
    dama: dama / weight,
    riichi: riichi / weight,
    ronYaku,
  };
}

/** Chance to win this hand from here. */
function winProb(
  c: Ctx,
  st: number,
  uke: number,
  o: { wait?: number; riichi?: boolean; furiten?: boolean; open?: boolean },
): number {
  const U = c.unseen,
    T = c.turnsLeft;
  // How readily the other three let a winning tile go.
  const others = o.furiten ? 0 : o.riichi ? 0.4 : 0.65;
  const q = (w: number) => 1 - (1 - Math.min(0.9, w / U)) ** (1 + 3 * others);
  const rival = 0.75 * 0.88 ** c.threats.filter((t) => t.prob >= 0.5).length;
  if (st <= 0) return rival * (1 - (1 - q(o.wait ?? 5)) ** T);
  const two = (a: number, w: number, turns: number) => {
    if (turns <= 0) return 0;
    const b = q(w);
    if (Math.abs(a - b) < 1e-6) a += 1e-3;
    return 1 - (a * (1 - b) ** turns - b * (1 - a) ** turns) / (a - b);
  };
  const advance = Math.max(
    0.01,
    Math.min(0.95, (uke / U) * (o.open ? 1.5 : 1.15)),
  );
  if (st === 1) return rival * two(advance, o.wait ?? 5, T);
  const turns = T - 1 / advance - (st - 2) / 0.45;
  return rival * two(o.open ? 0.3 : 0.22, 5, turns);
}

interface Candidate {
  o: Option;
  rest: number[];
  sh: Shape;
  risk: Risk;
  tp: Tenpai | null;
  canRiichi: boolean;
  /** Efficiency within the same shanten (ADVANCED). */
  eff: number;
  /** Chance to win × value (MASTER). */
  attack: number;
  ev: number;
}

function discard(c: Ctx): string {
  const opts = c.view.self.decision!.options;
  const riichiTiles = new Set(
    opts.filter((o) => o.type === "RIICHI_DISCARD").map((o) => o.tile!),
  );
  const isClosed = closed(c.melds),
    open = !isClosed;
  const cands: Candidate[] = opts
    .filter((o) => o.type === "DISCARD")
    .map((o) => {
      const rest = c.tiles.filter((t) => t !== o.tile);
      const sh =
        c.level === "MASTER"
          ? route(c, rest, c.melds)
          : shape(c, rest, c.melds);
      return {
        o,
        rest,
        sh,
        risk: risk(c, o.tile!),
        tp: sh.st <= 0 ? tenpai(c, rest, c.melds) : null,
        canRiichi: riichiTiles.has(o.tile!),
        eff: 0,
        attack: 0,
        ev: 0,
      };
    });
  const minSt = Math.min(...cands.map((x) => x.sh.st));
  // An open hand without 役牌 has to stay 断幺九, so its terminals are dead weight.
  const est0 = estimate(c, c.tiles, c.melds);
  const needSimple =
    open &&
    c.level === "ADVANCED" &&
    !c.melds.some((m) => m.type !== "CHI" && yakuhaiHan(c, kind(m.tiles[0]))) &&
    ![27, 28, 29, 30, 31, 32, 33].some(
      (k) =>
        yakuhaiHan(c, k) && c.tiles.filter((t) => kind(t) === k).length >= 3,
    );
  for (const x of cands) {
    const k = kind(x.o.tile!),
      tp = x.tp;
    const value = tp
      ? x.canRiichi
        ? tp.riichi
        : tp.dama
      : (() => {
          const e = estimate(c, x.rest, c.melds);
          return pointsFor(c, e.han, e.yaku);
        })();
    x.eff = tp
      ? 100 + (tp.left * (1000 + value) * (tp.furiten ? 0.3 : 1)) / 1000
      : x.sh.uke -
        1.5 * doraOf(c, x.o.tile!) +
        (terminal(k) ? 0.3 : 0) +
        (needSimple && terminal(k) ? 6 : 0) +
        (k >= 27 && !valueHonor(c, k) ? 0.2 : 0);
    x.attack =
      winProb(c, x.sh.st, x.sh.uke, {
        wait: tp?.left,
        riichi: !!tp && x.canRiichi,
        furiten: tp?.furiten,
        open,
      }) *
        (value + c.view.hand.kyotakuPoints + c.view.hand.honba * 300) +
      (needSimple && terminal(k) ? 150 : 0) +
      (terminal(k) ? 1 : 0);
  }
  const push = cands.filter((x) => x.sh.st === minSt);
  const byTile = (a: Candidate, b: Candidate) => a.o.tile! - b.o.tile!;
  const protect = c.final && c.leading && c.points >= 30000;
  let best: Candidate;
  if (c.level === "ADVANCED") {
    const top = [...push].sort((a, b) => b.eff - a.eff || byTile(a, b))[0];
    if (!c.threats.length) best = top;
    else {
      const han = est0.han;
      const attack =
        !protect &&
        (minSt === 0
          ? (top.tp?.left ?? 0) > 0
          : minSt === 1 &&
            (han >= 3 || (han >= 2 && top.sh.uke >= 16 && c.wallLeft >= 28)));
      if (attack) {
        // Keep the shape, but let go of efficiency for a clearly safer tile.
        const scale = Math.max(1, top.eff - (minSt === 0 ? 100 : 0));
        const rate = (x: Candidate) =>
          (x.eff - (minSt === 0 ? 100 : 0)) / scale - 4 * x.risk.p;
        best = [...push].sort((a, b) => rate(b) - rate(a) || byTile(a, b))[0];
      } else
        best = [...cands].sort(
          (a, b) =>
            a.risk.loss - b.risk.loss ||
            a.sh.st - b.sh.st ||
            b.eff - a.eff ||
            byTile(a, b),
        )[0];
    }
  } else {
    // Protecting a final-stage lead makes every point given away count more.
    const weight = protect ? 1.8 : c.final && !c.leading ? 0.85 : 1;
    const strong = c.threats.reduce((n, t) => n + t.prob, 0);
    const avgLoss = strong
      ? c.threats.reduce((n, t) => n + t.prob * t.loss, 0) / strong
      : 0;
    const top = [...push].sort((a, b) => b.eff - a.eff || byTile(a, b))[0];
    const base = minSt === 0 ? 100 : 0,
      scale = Math.max(1, top.eff - base);
    for (const x of cands) {
      // Tiles still to be pushed before this hand can win.
      const more =
        x.sh.st === 0
          ? Math.min(c.turnsLeft, 4) * 0.6
          : x.sh.st === 1
            ? 3.5
            : 6;
      const tax =
        Math.min(c.turnsLeft, more) * strong * 0.045 * avgLoss * weight * 0.3;
      // Among tiles that keep the hand moving, efficiency decides; risk is priced on top.
      const attack = top.attack * Math.max(0, (x.eff - base) / scale);
      const pushEv =
        x.sh.st === minSt
          ? (1 - x.risk.p) * (attack - tax) - x.risk.loss * weight
          : -Infinity;
      const foldEv = -x.risk.loss * weight + (strong ? 0.08 : 0) * x.attack;
      x.ev = strong ? Math.max(pushEv, foldEv) : pushEv;
    }
    best = [...cands].sort((a, b) => b.ev - a.ev || byTile(a, b))[0];
  }
  const kyuushu = opts.find((o) => o.type === "ABORT_KYUUSHU");
  if (kyuushu && minSt >= 4) return kyuushu.optionId;
  // Kans: only while nobody threatens, and never at the cost of the hand's shape.
  const quiet = !c.threats.some((t) => t.prob >= 0.5);
  const inRiichi = c.view.hand.seats[c.s].riichi !== "NONE";
  for (const o of opts.filter(
    (o) => o.type === "ANKAN" || o.type === "KAKAN",
  )) {
    if (!quiet && !inRiichi) break;
    if (inRiichi) return o.optionId;
    const used = o.type === "ANKAN" ? o.tiles! : [o.tile!];
    const rest = c.tiles.filter((t) => !used.includes(t));
    const melds: Meld[] =
      o.type === "ANKAN"
        ? [...c.melds, fakeMeld("ANKAN", o.tiles!, null, null)]
        : c.melds;
    if (shanten(rest, melds, c.s) <= minSt) return o.optionId;
  }
  const riichi = opts.find(
    (o) => o.type === "RIICHI_DISCARD" && o.tile === best.o.tile,
  );
  if (riichi && best.tp && declare(c, best, protect)) return riichi.optionId;
  return best.o.optionId;
}

/** Riichi or stay quiet. */
function declare(c: Ctx, x: Candidate, protect: boolean): boolean {
  const tp = x.tp!;
  if (tp.left <= 0 || tp.furiten || c.wallLeft < 8) return false;
  const threatened = c.threats.some((t) => t.prob >= 0.5);
  // A leading final-stage hand may already win without putting another 1,000 points at risk.
  if (protect) return false;
  if (c.level === "ADVANCED") {
    if (tp.ronYaku && tp.dama >= 8000) return false;
    if (threatened && tp.left <= 2 && tp.riichi < 5200) return false;
    return true;
  }
  // Against this field a declared riichi pays; only a hand that is already big stays quiet.
  return !(tp.ronYaku && tp.dama >= 11600);
}

function fakeMeld(
  type: Meld["type"],
  tiles: number[],
  called: number | null,
  source: Seat | null,
): Meld {
  return {
    meldId: "bot",
    type,
    tiles,
    sourceSeat: source,
    sourceDiscardId: null,
    calledTile: called,
    addedTile: null,
  };
}

function respond(c: Ctx): string {
  const opts = c.view.self.decision!.options;
  const pass = opts.find((o) => o.type === "PASS")!;
  const last = c.view.hand.lastDiscard;
  const calls = opts.filter(
    (o) => o.type === "PON" || o.type === "CHI" || o.type === "DAIMINKAN",
  );
  if (!calls.length || !last) return pass.optionId;
  const threatened = c.threats.some((t) => t.prob >= 0.5);
  const yakuRoute = c.level === "MASTER";
  const before = yakuRoute
    ? route(c, c.tiles, c.melds)
    : shape(c, c.tiles, c.melds);
  if (before.st <= 0) return pass.optionId;
  const wasClosed = closed(c.melds);
  const called = kind(last.tile);
  let best: Option = pass,
    bestSt = before.st,
    bestUke = -1;
  for (const o of calls) {
    const consumed = o.consumedTiles!;
    const remaining = c.tiles.filter((t) => !consumed.includes(t));
    const melds = [
      ...c.melds,
      fakeMeld(
        o.type as Meld["type"],
        [...consumed, last.tile],
        last.tile,
        last.seat,
      ),
    ];
    const all = [...remaining, ...melds.flatMap((m) => m.tiles)];
    const yakuhai =
      melds.some((m) => m.type !== "CHI" && yakuhaiHan(c, kind(m.tiles[0]))) ||
      [27, 28, 29, 30, 31, 32, 33].some(
        (k) =>
          yakuhaiHan(c, k) &&
          remaining.filter((t) => kind(t) === k).length >= 3,
      );
    if (!yakuRoute && !yakuhai && !all.every((t) => !terminal(kind(t))))
      continue;
    if (o.type === "DAIMINKAN") {
      // Opening a closed hand for a kan throws away riichi for one dora indicator.
      if (wasClosed || threatened) continue;
      if (shanten(remaining, melds, c.s) <= before.st && best === pass)
        best = o;
      continue;
    }
    // 喰い替え: the called tile, or the far end of the same run, cannot follow the call.
    const banned = [called];
    if (o.type === "CHI") {
      const ks = consumed.map(kind).sort((a, b) => a - b);
      if (ks[0] === called + 1 && called % 9 <= 5) banned.push(called + 3);
      if (ks[1] === called - 1 && called % 9 >= 3) banned.push(called - 3);
    }
    let after: Shape | null = null,
      afterRest: number[] = [];
    for (const t of remaining) {
      if (banned.includes(kind(t))) continue;
      const rest = remaining.filter((x) => x !== t);
      const sh = yakuRoute
        ? route(c, rest, melds, true)
        : shape(c, rest, melds);
      if (
        !after ||
        sh.st < after.st ||
        (sh.st === after.st && sh.uke > after.uke)
      ) {
        after = sh;
        afterRest = rest;
      }
    }
    if (!after) continue;
    if (threatened && after.st > 0) continue;
    if (after.st >= before.st) continue;
    if (wasClosed && !(o.type === "PON" && yakuhaiHan(c, called) > 0)) {
      // Do not trade a closed hand that is about to riichi for a cheap open one.
      if (before.st <= 1 && c.wallLeft > 24) continue;
      if (estimate(c, afterRest, melds).han < 2 && c.wallLeft > 40) continue;
    }
    if (after.st < bestSt || (after.st === bestSt && after.uke > bestUke)) {
      best = o;
      bestSt = after.st;
      bestUke = after.uke;
    }
  }
  return best.optionId;
}

export function chooseStrong(view: MatchView, level: StrongLevel): string {
  const c = context(view, level);
  return view.self.decision!.options.some((o) => o.type === "DISCARD")
    ? discard(c)
    : respond(c);
}
