import { kind, type Seat } from "./types";
export interface YakuExample {
  id: string;
  name: string;
  closedHan: number;
  openHan: number | null;
  yakuman?: boolean;
  description: string;
  groups: string[];
  winning?: string;
  open?: number[];
  context?: {
    riichi?: number;
    ippatsu?: boolean;
    tsumo?: boolean;
    haitei?: boolean;
    rinshan?: boolean;
    chankan?: boolean;
    first?: boolean;
    seat?: Seat;
    round?: number;
  };
}
const basic = ["m234", "p345", "s456", "p678", "s22"];
const standard = (
  id: string,
  name: string,
  closedHan: number,
  openHan: number | null,
  description: string,
  groups = basic,
  extra: Partial<YakuExample> = {},
): YakuExample => ({
  id,
  name,
  closedHan,
  openHan,
  description,
  groups,
  ...extra,
});
const limit = (
  id: string,
  name: string,
  description: string,
  groups: string[],
  extra: Partial<YakuExample> = {},
): YakuExample =>
  standard(
    id,
    name,
    0,
    ["KOKUSHI", "SUUANKOU", "CHUUREN", "TENHOU", "CHIIHOU"].includes(id)
      ? null
      : 0,
    description,
    groups,
    { yakuman: true, ...extra },
  );
/** Full supported yaku set. Event yaku require the stated context as well as these tiles. */
export const YAKU_CATALOG: YakuExample[] = [
  standard(
    "RIICHI",
    "立直",
    1,
    null,
    "门清听牌后支付1000点宣布立直，之后只能摸切或执行允许的和牌、暗杠。",
    basic,
    { winning: "m4", context: { riichi: 1 } },
  ),
  standard(
    "DOUBLE_RIICHI",
    "双立直",
    2,
    null,
    "在本人首次弃牌、且此前没有吃碰杠中断时立直。替代普通立直。",
    basic,
    { winning: "m4", context: { riichi: 2 } },
  ),
  standard(
    "IPPATSU",
    "一发",
    1,
    null,
    "立直成立后，在未被成功吃碰杠中断的一巡内和牌。仅有牌形不成立一发。",
    basic,
    { winning: "m4", context: { riichi: 1, ippatsu: true } },
  ),
  standard(
    "MENZEN_TSUMO",
    "门前清自摸和",
    1,
    null,
    "没有吃、碰或明杠，靠自己摸到的牌和牌；暗杠不破坏门清。",
    basic,
    { winning: "m4", context: { tsumo: true } },
  ),
  standard(
    "TANYAO",
    "断幺九",
    1,
    1,
    "整副牌只有二至八的数牌，没有一、九和字牌；本桌允许食断。",
    basic,
    { winning: "m4" },
  ),
  standard(
    "PINFU",
    "平和",
    1,
    null,
    "四个顺子、非役牌雀头，并以两面听和牌。示例用二三万等一万或四万，和四万。",
    basic,
    { winning: "m4" },
  ),
  standard(
    "IIPEIKOU",
    "一杯口",
    1,
    null,
    "门清时有两个完全相同的顺子。",
    ["m234", "m234", "p567", "s789", "p22"],
    { winning: "p7" },
  ),
  standard(
    "YAKUHAI_WHITE",
    "役牌·白",
    1,
    1,
    "白的刻子或杠子。每组役牌各计一番。",
    ["z555", "m234", "p345", "s678", "p22"],
  ),
  standard("YAKUHAI_GREEN", "役牌·发", 1, 1, "发的刻子或杠子。", [
    "z666",
    "m234",
    "p345",
    "s678",
    "p22",
  ]),
  standard("YAKUHAI_RED", "役牌·中", 1, 1, "中的刻子或杠子。", [
    "z777",
    "m234",
    "p345",
    "s678",
    "p22",
  ]),
  standard(
    "YAKUHAI_SEAT_WIND",
    "役牌·自风",
    1,
    1,
    "本局自风的刻子或杠子。示例玩家是西家，以西刻子成立。",
    ["z333", "m234", "p345", "s678", "p22"],
    { context: { seat: 2 } },
  ),
  standard(
    "YAKUHAI_ROUND_WIND",
    "役牌·场风",
    1,
    1,
    "本圈场风的刻子或杠子。示例为东场的东刻子；双东等可分别计自风、场风。",
    ["z111", "m234", "p345", "s678", "p22"],
  ),
  standard(
    "HAITEI",
    "海底摸月",
    1,
    1,
    "摸到通常牌山最后一张牌并自摸。岭上摸牌不算海底。",
    basic,
    { winning: "m4", context: { tsumo: true, haitei: true } },
  ),
  standard(
    "HOUTEI",
    "河底捞鱼",
    1,
    1,
    "荣和通常牌山摸完后最后打出的那张牌。",
    basic,
    { winning: "m4", context: { haitei: true } },
  ),
  standard(
    "RINSHAN",
    "岭上开花",
    1,
    1,
    "成功开杠后，从王牌摸到的岭上牌恰好自摸。示例包含一组暗杠。",
    ["m1111", "p345", "s678", "m234", "p22"],
    { context: { tsumo: true, rinshan: true } },
  ),
  standard(
    "CHANKAN",
    "抢杠",
    1,
    1,
    "荣和别人加杠的那一张牌；示例抢四万。不能用这副普通牌抢暗杠。",
    basic,
    { winning: "m4", context: { chankan: true } },
  ),
  standard(
    "CHIITOITSU",
    "七对子",
    2,
    null,
    "七种不同的对子；同种四张不能拆作两对。固定25符。",
    ["m22", "m55", "p33", "p66", "s44", "s88", "z77"],
  ),
  standard(
    "TOITOI",
    "对对和",
    2,
    2,
    "四组刻子或杠子，加一对雀头。示例二万已碰出。",
    ["m222", "p444", "s777", "z666", "m99"],
    { open: [0] },
  ),
  standard(
    "SANANKOU",
    "三暗刻",
    2,
    2,
    "有三组在暗手中完成的刻子或暗杠；荣和补成的刻子不算暗刻。",
    ["m222", "p444", "s777", "m345", "p99"],
  ),
  standard(
    "SANKANTSU",
    "三杠子",
    2,
    2,
    "同一玩家有三组已成立的杠。杠包含四张实体牌，仍按一组面子计算。",
    ["m1111", "p2222", "s3333", "p456", "s88"],
    { open: [0, 1, 2] },
  ),
  standard(
    "SANSHOKU_DOUKOU",
    "三色同刻",
    2,
    2,
    "万、筒、索各有一组相同数字的刻子或杠子。",
    ["m333", "p333", "s333", "m678", "p55"],
  ),
  standard(
    "SANSHOKU_DOUJUN",
    "三色同顺",
    2,
    1,
    "万、筒、索各有一组数字相同的顺子；副露后减一番。",
    ["m234", "p234", "s234", "m678", "p55"],
  ),
  standard(
    "ITTSUU",
    "一气通贯",
    2,
    1,
    "同一种花色拥有123、456、789三组顺子。",
    ["m123", "m456", "m789", "p234", "s55"],
  ),
  standard(
    "CHANTA",
    "混全带幺九",
    2,
    1,
    "每个面子和雀头都含一、九或字牌；必须同时有顺子和字牌。",
    ["m123", "p789", "s111", "z555", "z22"],
  ),
  standard(
    "HONROUTOU",
    "混老头",
    2,
    2,
    "整副牌只有一、九和字牌，没有顺子。可与对对和或七对子复合。",
    ["m111", "m999", "p111", "z555", "z77"],
    { open: [0] },
  ),
  standard(
    "SHOUSANGEN",
    "小三元",
    2,
    2,
    "白、发、中里两种做刻子或杠子，另一种做雀头；已有役牌另计。",
    ["z555", "z666", "m123", "p789", "z77"],
  ),
  standard(
    "RYANPEIKOU",
    "两杯口",
    3,
    null,
    "门清的四个顺子组成两组相同顺子对；不再加一杯口，也不兼算七对子。",
    ["m123", "m123", "p789", "p789", "s55"],
  ),
  standard(
    "JUNCHAN",
    "纯全带幺九",
    3,
    2,
    "每个面子和雀头都含一或九，有顺子，且整副牌没有字牌。",
    ["m123", "p789", "s123", "s789", "m11"],
  ),
  standard(
    "HONITSU",
    "混一色",
    3,
    2,
    "一种数牌花色加字牌，两者都要出现。示例东已碰出。",
    ["m123", "m345", "m678", "z111", "z55"],
    { open: [3] },
  ),
  standard("CHINITSU", "清一色", 6, 5, "全部是同一种花色的数牌，没有字牌。", [
    "m123",
    "m234",
    "m456",
    "m789",
    "m55",
  ]),
  limit(
    "KOKUSHI",
    "国士无双",
    "十三种幺九牌各至少一张，其中一种再做对子。本桌十三面也只计一倍。",
    ["m119", "p19", "s19", "z1234567"],
  ),
  limit(
    "SUUANKOU",
    "四暗刻",
    "四组暗刻或暗杠加雀头。荣和时必须单骑完成雀头；本桌单骑不翻倍。",
    ["m222", "p444", "s777", "z666", "m99"],
    { winning: "m2", context: { tsumo: true } },
  ),
  limit(
    "DAISANGEN",
    "大三元",
    "白、发、中各一组刻子或杠子。",
    ["z555", "z666", "z777", "m123", "p22"],
    { open: [0] },
  ),
  limit(
    "SHOUSUUSHII",
    "小四喜",
    "三种风牌做刻子或杠子，第四种风牌做雀头。",
    ["z111", "z222", "z333", "m456", "z44"],
    { open: [0] },
  ),
  limit(
    "DAISUUSHII",
    "大四喜",
    "东、南、西、北都做成刻子或杠子；本桌单独计一倍役满。",
    ["z111", "z222", "z333", "z444", "m55"],
    { open: [0] },
  ),
  limit(
    "TSUUIISOU",
    "字一色",
    "整副牌只有字牌，可以是四面子一雀头，也可以是字牌七对子。",
    ["z111", "z222", "z555", "z666", "z77"],
    { open: [0] },
  ),
  limit(
    "CHINROUTOU",
    "清老头",
    "全部只有一、九数牌，没有字牌。",
    ["m111", "m999", "p111", "p999", "s11"],
    { open: [0] },
  ),
  limit(
    "RYUUIISOU",
    "绿一色",
    "只用二、三、四、六、八索和发组成和牌，不要求必须有发。",
    ["s222", "s333", "s444", "s666", "z66"],
    { open: [0] },
  ),
  limit(
    "CHUUREN",
    "九莲宝灯",
    "门清同花色1112345678999再加该花色任一张。不能有杠；本桌纯正九面不翻倍。",
    ["m111", "m234", "m55", "m678", "m999"],
    { winning: "m1" },
  ),
  limit(
    "SUUKANTSU",
    "四杠子",
    "同一人完成四组杠并和牌；单骑也允许和。此时实体牌共18张。",
    ["m1111", "p2222", "s3333", "z6666", "p55"],
    { open: [0, 1, 2, 3] },
  ),
  limit(
    "TENHOU",
    "天和",
    "庄家配牌和首摸即自摸，之前没有弃牌或杠。仅有这个牌形不代表天和。",
    basic,
    { winning: "m4", context: { tsumo: true, first: true, seat: 0 } },
  ),
  limit(
    "CHIIHOU",
    "地和",
    "子家首次摸牌即自摸，此前没有成功吃碰杠，且本人没有杠。",
    basic,
    { winning: "m4", context: { tsumo: true, first: true } },
  ),
];
/** Allocate genuine distinct physical tiles, avoiding red fives unless all four are used. */
export function exampleHand(example: Pick<YakuExample, "groups" | "winning">) {
  const used = new Map<number, number>();
  const groups = example.groups.map((group) => {
    if (!/^[mpsz][1-9]+$/.test(group)) throw Error("Invalid example notation");
    return [...group.slice(1)].map((d) => {
      const n = Number(d),
        k = group[0] === "z" ? 26 + n : "mps".indexOf(group[0]) * 9 + n - 1;
      if (k > 33) throw Error("Invalid honor");
      const count = used.get(k) ?? 0;
      if (count >= 4) throw Error("Example has five copies");
      used.set(k, count + 1);
      return k * 4 + (k < 27 && k % 9 === 4 ? [1, 2, 3, 0][count] : count);
    });
  });
  const code =
    example.winning ??
    example.groups.at(-1)![0] + example.groups.at(-1)!.at(-1)!;
  const winning = groups
    .flat()
    .filter((t) => {
      const k = kind(t);
      return (
        (k >= 27
          ? "z" + (k - 26)
          : "mps"[Math.floor(k / 9)] + ((k % 9) + 1)) === code
      );
    })
    .at(-1);
  if (winning === undefined) throw Error("Winning tile absent");
  return { groups, winning };
}
