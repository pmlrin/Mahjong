import M from "@kobalab/majiang-core";
import { createRequire } from "node:module";
const explain = createRequire(import.meta.url)("../vendor/hule.cjs").explain;
import {
  kind,
  isRed,
  type Meld,
  type Seat,
  type Win,
  type Yaku,
} from "../../shared/types.ts";
export const rule = M.rule({
  場数: 1,
  ダブル役満あり: false,
  役満パオあり: false,
  カンドラ後乗せ: false,
  リーチ後暗槓許可レベル: 1,
  連風牌は2符: false,
  切り上げ満貫あり: false,
});
export function code(t: number, red = true): string {
  const k = kind(t);
  return k < 27
    ? ["m", "p", "s"][Math.floor(k / 9)] + (red && isRed(t) ? 0 : (k % 9) + 1)
    : "z" + (k - 26);
}
const dir = (self: Seat, source: Seat) =>
  ["", "+", "=", "-"][(source - self + 4) % 4];
export function meldCode(m: Meld, self: Seat): string {
  const c = code(m.tiles[0])[0];
  if (m.type === "ANKAN")
    return (
      c +
      m.tiles
        .map((t) => code(t)[1])
        .sort()
        .reverse()
        .join("")
    );
  if (m.type === "CHI")
    return (
      c +
      [...m.tiles]
        .sort((a, b) => kind(a) - kind(b))
        .map((t) => code(t)[1] + (t === m.calledTile ? "-" : ""))
        .join("")
    );
  const other = m.tiles
    .filter((t) => t !== m.calledTile && t !== m.addedTile)
    .map((t) => code(t)[1])
    .sort()
    .reverse()
    .join("");
  return (
    c +
    other +
    code(m.calledTile!)[1] +
    dir(self, m.sourceSeat!) +
    (m.addedTile === null ? "" : code(m.addedTile)[1])
  );
}
export function hand(
  tiles: number[],
  melds: Meld[] = [],
  seat: Seat = 0,
  drawn: number | null = null,
): any {
  const s = new M.Shoupai(tiles.map((t) => code(t)));
  s._fulou = melds.map((m) => meldCode(m, seat));
  if (drawn !== null) s.zimo(code(drawn), false);
  return s;
}
export function shanten(
  tiles: number[],
  melds: Meld[] = [],
  seat: Seat = 0,
): number {
  return M.Util.xiangting(hand(tiles, melds, seat));
}
export function waits(
  tiles: number[],
  melds: Meld[] = [],
  seat: Seat = 0,
): number[] {
  const own = Array(34).fill(0);
  for (const t of [...tiles, ...melds.flatMap((m) => m.tiles)]) own[kind(t)]++;
  const s = hand(tiles, melds, seat);
  if (M.Util.xiangting(s) !== 0) return [];
  return M.Util.tingpai(s)
    .map((p: string) =>
      p[0] === "z"
        ? 26 + Number(p[1])
        : ["m", "p", "s"].indexOf(p[0]) * 9 + Number(p[1]) - 1,
    )
    .filter((k: number) => own[k] < 4);
}
export const terminal = (k: number) => k >= 27 || k % 9 === 0 || k % 9 === 8;
export const closed = (melds: Meld[]) => melds.every((m) => m.type === "ANKAN");
export interface ScoreContext {
  seat: Seat;
  dealer: Seat;
  round: number;
  tiles: number[];
  drawn: number | null;
  melds: Meld[];
  winningTile: number;
  source: Seat | null;
  riichi: number;
  ippatsu: boolean;
  haitei: boolean;
  rinshan: boolean;
  chankan: boolean;
  first: boolean;
  indicators: number[];
  ura: number[];
}
const names: Record<string, string> = {
  立直: "RIICHI",
  ダブル立直: "DOUBLE_RIICHI",
  一発: "IPPATSU",
  門前清自摸和: "MENZEN_TSUMO",
  断幺九: "TANYAO",
  平和: "PINFU",
  一盃口: "IIPEIKOU",
  "翻牌 白": "YAKUHAI_WHITE",
  "翻牌 發": "YAKUHAI_GREEN",
  "翻牌 中": "YAKUHAI_RED",
  海底摸月: "HAITEI",
  河底撈魚: "HOUTEI",
  嶺上開花: "RINSHAN",
  槍槓: "CHANKAN",
  七対子: "CHIITOITSU",
  対々和: "TOITOI",
  三暗刻: "SANANKOU",
  三槓子: "SANKANTSU",
  三色同刻: "SANSHOKU_DOUKOU",
  三色同順: "SANSHOKU_DOUJUN",
  一気通貫: "ITTSUU",
  混全帯幺九: "CHANTA",
  混老頭: "HONROUTOU",
  小三元: "SHOUSANGEN",
  二盃口: "RYANPEIKOU",
  純全帯幺九: "JUNCHAN",
  混一色: "HONITSU",
  清一色: "CHINITSU",
  国士無双: "KOKUSHI",
  四暗刻: "SUUANKOU",
  大三元: "DAISANGEN",
  小四喜: "SHOUSUUSHII",
  大四喜: "DAISUUSHII",
  字一色: "TSUUIISOU",
  清老頭: "CHINROUTOU",
  緑一色: "RYUUIISOU",
  九蓮宝燈: "CHUUREN",
  四槓子: "SUUKANTSU",
  天和: "TENHOU",
  地和: "CHIIHOU",
};
export const SUPPORTED_YAKU_IDS = [...Object.values(names), 'YAKUHAI_ROUND_WIND', 'YAKUHAI_SEAT_WIND'];
export function score(c: ScoreContext): Win | null {
  const s = hand(c.tiles, c.melds, c.seat, c.source === null ? c.drawn : null);
  const p = M.Util.hule_param({
    rule,
    zhuangfeng: c.round,
    menfeng: (c.seat - c.dealer + 4) % 4,
    lizhi: c.riichi,
    yifa: c.ippatsu,
    qianggang: c.chankan,
    lingshang: c.rinshan,
    haidi: c.haitei ? (c.source === null ? 1 : 2) : 0,
    tianhu: c.first ? (c.seat === c.dealer ? 1 : 2) : 0,
    baopai: c.indicators.map((t) => code(t, false)),
    fubaopai: c.riichi ? c.ura.map((t) => code(t, false)) : null,
    jicun: { changbang: 0, lizhibang: 0 },
  });
  const explained = explain(
    s,
    c.source === null ? null : code(c.winningTile) + dir(c.seat, c.source),
    p,
  );
  const r = explained.result;
  if (!r?.hupai?.length) return null;
  const dora = { omote: 0, ura: 0, aka: 0 };
  const yaku: Yaku[] = [];
  for (const y of r.hupai) {
    if (y.name === "ドラ") dora.omote += Number(y.fanshu);
    else if (y.name === "裏ドラ") dora.ura += Number(y.fanshu);
    else if (y.name === "赤ドラ") dora.aka += Number(y.fanshu);
    else {
      const name = y.name;
      const id =
        names[name] ??
        (name.startsWith("場風")
          ? "YAKUHAI_ROUND_WIND"
          : name.startsWith("自風")
            ? "YAKUHAI_SEAT_WIND"
            : name);
      yaku.push({
        yakuId: id,
        name,
        han: typeof y.fanshu === "number" ? y.fanshu : 0,
        yakumanMultiplier: typeof y.fanshu === "string" ? y.fanshu.length : 0,
      });
    }
  }
  if (!yaku.length) return null;
  const yakuman = yaku.reduce((n, y) => n + y.yakumanMultiplier, 0),
    han = r.fanshu ?? 0,
    fu = r.fu ?? 0;
  const base = yakuman
    ? 8000 * yakuman
    : han >= 13
      ? 8000
      : han >= 11
        ? 6000
        : han >= 8
          ? 4000
          : han >= 6
            ? 3000
            : Math.min(2000, fu * 2 ** (han + 2));
  return {
    winnerSeat: c.seat,
    sourceSeat: c.source,
    winningTile: c.winningTile,
    method: c.source === null ? "TSUMO" : "RON",
    yaku,
    fu: yakuman ? null : fu,
    han: yakuman ? null : han,
    yakumanMultiplier: yakuman,
    limit: yakuman
      ? "YAKUMAN"
      : han >= 13
        ? "KAZOE_YAKUMAN"
        : han >= 11
          ? "SANBAIMAN"
          : han >= 8
            ? "BAIMAN"
            : han >= 6
              ? "HANEMAN"
              : base === 2000
                ? "MANGAN"
                : "NONE",
    dora: yakuman ? { omote: 0, ura: 0, aka: 0 } : dora,
    basePoints: base,
    fuDetails: yakuman ? [] : fuBreakdown(explained.groups, c, fu, yaku),
    decomposition: physicalGroups(explained.groups, c),
    pao: [],
  };
}
export function strictRiichiKan(
  tiles: number[],
  drawn: number,
  k: number,
  melds: Meld[],
  seat: Seat,
): boolean {
  if (kind(drawn) !== k || tiles.filter((t) => kind(t) === k).length !== 3)
    return false;
  const before = waits(tiles, melds, seat);
  const remaining = tiles.filter((t) => kind(t) !== k);
  const m: Meld = {
    meldId: "candidate",
    type: "ANKAN",
    tiles: [...tiles.filter((t) => kind(t) === k), drawn],
    sourceSeat: null,
    sourceDiscardId: null,
    calledTile: null,
    addedTile: null,
  };
  const after = waits(remaining, [...melds, m], seat);
  if (JSON.stringify(before) !== JSON.stringify(after) || !before.length)
    return false;
  // Enumerate every complete interpretation: the three original tiles must remain one triplet.
  for (const w of before) {
    const h = hand(tiles, melds, seat);
    h.zimo(code(w * 4, false), false);
    const groups = M.Util.hule_mianzi(h, null);
    const trip =
      code(k * 4, false)[0] + String(k < 27 ? (k % 9) + 1 : k - 26).repeat(3);
    if (
      !groups.length ||
      groups.some(
        (g: string[]) => !g.some((x) => x.replace(/[+\-=!]/g, "") === trip),
      )
    )
      return false;
  }
  return true;
}

function physicalGroups(
  groups: string[],
  c: ScoreContext,
): Win["decomposition"] {
  if (groups.length === 1) {
    const h = hand(
      c.tiles,
      c.melds,
      c.seat,
      c.source === null ? c.drawn : null,
    );
    groups =
      M.Util.hule_mianzi(
        h,
        c.source === null ? null : code(c.winningTile) + dir(c.seat, c.source),
      ).find((g: string[]) => g.length === 5) ?? groups;
  }
  const available = [
    ...c.tiles,
    ...(c.source === null
      ? c.drawn === null
        ? []
        : [c.drawn]
      : [c.winningTile]),
    ...c.melds.flatMap((m) => m.tiles),
  ];
  const result = groups.map((g) =>
    [...g.slice(1).matchAll(/\d/g)].map((x) => {
      const n = Number(x[0]);
      const k =
        g[0] === "z"
          ? 26 + n
          : ["m", "p", "s"].indexOf(g[0]) * 9 + (n || 5) - 1;
      const i = available.findIndex((t) => kind(t) === k);
      if (i < 0) throw new Error("SCORER_TILE_MISMATCH");
      return available.splice(i, 1)[0];
    }),
  );
  return {
    kind:
      groups.length === 7
        ? "CHIITOITSU"
        : groups.length === 13
          ? "KOKUSHI"
          : "STANDARD",
    groups: result,
  };
}
function fuBreakdown(
  groups: string[],
  c: ScoreContext,
  fu: number,
  yaku: Yaku[],
): Win["fuDetails"] {
  const rows: Win["fuDetails"] = [];
  const add = (code: string, value: number, meldId: string | null = null) => {
    if (value) rows.push({ code, value, meldId });
  };
  if (groups.length === 7) {
    add("FIXED_CHIITOITSU", 25);
    return rows;
  }
  if (yaku.some((y) => y.yakuId === "PINFU")) {
    add(c.source === null ? "FIXED_PINFU_TSUMO" : "BASE", 20);
    if (c.source !== null) add("CLOSED_RON", 10);
    return rows;
  }
  add("BASE", 20);
  if (c.source === null) add("TSUMO", 2);
  else if (closed(c.melds)) add("CLOSED_RON", 10);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i],
      digits = g.match(/\d/g) ?? [],
      n = Number(digits[0]);
    if (i === 0) {
      let value =
        g[0] === "z"
          ? 2 * Number(n === c.round + 1) +
            2 * Number(n === ((c.seat - c.dealer + 4) % 4) + 1) +
            2 * Number(n >= 5)
          : 0;
      add("PAIR", value);
      if (/^[mpsz](\d)\1[+=_-]!$/.test(g)) add("WAIT", 2);
    } else if (/^[mpsz](\d)\1\1/.test(g)) {
      let value = 2;
      if (g[0] === "z" || n === 1 || n === 9) value *= 2;
      if (/^[mpsz](\d)\1\1(?:\1|_!)?$/.test(g)) value *= 2;
      if (digits.length === 4) value *= 4;
      add(
        "MELD",
        value,
        c.melds.find(
          (m) =>
            code(m.tiles[0], false)[0] === g[0] &&
            (kind(m.tiles[0]) % 9) + 1 === n,
        )?.meldId ?? null,
      );
    } else if (
      /^[mps]\d\d[+=_-]!\d$/.test(g) ||
      /^[mps](123[+=_-]!|7[+=_-]!89)$/.test(g)
    )
      add("WAIT", 2);
  }
  let total = rows.reduce((n, r) => n + r.value, 0);
  if (!closed(c.melds) && c.source !== null && total === 20) {
    add("OPEN_MINIMUM", 10);
    total = 30;
  }
  add("ROUNDING", fu - total);
  return rows;
}
