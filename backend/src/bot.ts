import M from "@kobalab/majiang-core";
import {
  kind,
  isRed,
  AUTOPILOT_BOT_LEVEL,
  type BotLevel,
  type MatchView,
  type Option,
} from "../../shared/types.ts";
import { shanten, hand, terminal } from "./rules.ts";
import { chooseStrong, finalStage } from "./bot-strong.ts";
export { finalStage };
/** The level a seat plays at: an AI 牌友 uses its own, a hosted human seat uses 中级. */
export function botLevelOf(view: MatchView): BotLevel {
  const p = view.players[view.viewerSeat];
  return p.participantKind === "BOT"
    ? (p.botLevel ?? AUTOPILOT_BOT_LEVEL)
    : AUTOPILOT_BOT_LEVEL;
}
/**
 * 初级 BASIC: shanten and a plain count of useful tile kinds; never defends, always riichi.
 * 中级 STANDARD: live-tile efficiency, folds to 现物 against a riichi, protects a final-stage lead.
 * 高级 ADVANCED／大师级 MASTER live in bot-strong.ts.
 */
export function chooseBot(view: MatchView): string {
  const d = view.self.decision!;
  const opts = d.options,
    win = opts.find((o) => o.type === "TSUMO" || o.type === "RON");
  if (win) return win.optionId;
  const level = botLevelOf(view);
  if (level === "ADVANCED" || level === "MASTER")
    return chooseStrong(view, level);
  const s = view.viewerSeat,
    melds = view.hand.seats[s].melds;
  const basic = level === "BASIC";
  const leading = view.players.every((p) => p.points <= view.players[s].points);
  const tiles = [
    ...view.self.concealedTiles,
    ...(view.self.drawnTile === null ? [] : [view.self.drawnTile]),
  ];
  const threat = view.hand.seats.filter(
    (p) => p.seat !== s && p.riichi === "ESTABLISHED",
  );
  const seen = Array(34).fill(0);
  for (const t of tiles) seen[kind(t)]++;
  for (const p of view.hand.seats) {
    for (const x of p.discards.filter((x) => !x.claimedByMeldId))
      seen[kind(x.tile)]++;
    for (const m of p.melds) for (const t of m.tiles) seen[kind(t)]++;
  }
  for (const t of view.hand.doraIndicators) seen[kind(t)]++;
  const efficiency = (ts: number[], ms = melds) => {
    const st = shanten(ts, ms, s);
    let uke = 0;
    if (st <= 2) {
      const p = hand(ts, ms, s);
      const improves = M.Util.tingpai(p);
      for (const c of improves) {
        const k =
          c[0] === "z"
            ? 26 + Number(c[1])
            : ["m", "p", "s"].indexOf(c[0]) * 9 + Number(c[1]) - 1;
        // 初级 counts kinds only; it does not notice which tiles are already gone.
        uke += basic ? 2 : Math.max(0, 4 - seen[k]);
      }
    }
    return { st, uke };
  };
  const discards = opts.filter((o) => o.type === "DISCARD");
  if (discards.length) {
    const ranked = discards.map((o) => {
      const rest = tiles.filter((t) => t !== o.tile),
        e = efficiency(rest);
      const safe = threat.filter((p) =>
        p.discards.some((x) => kind(x.tile) === kind(o.tile!)),
      ).length;
      const danger = threat.length - safe;
      return {
        o,
        st: e.st,
        score:
          e.st * 1000 -
          e.uke * 5 +
          (!basic && isRed(o.tile!) ? 20 : 0) +
          (terminal(kind(o.tile!)) ? 0 : 1),
        danger,
      };
    });
    const bestSt = Math.min(...ranked.map((x) => x.st));
    const defend =
      !basic &&
      threat.length > 0 &&
      (bestSt >= 1 ||
        (leading && view.players[s].points >= 30000 && finalStage(view)));
    ranked.sort(
      (a, b) =>
        (defend ? a.danger - b.danger : 0) ||
        a.score - b.score ||
        a.o.tile! - b.o.tile!,
    );
    const best = ranked[0].o,
      riichi = opts.find(
        (o) => o.type === "RIICHI_DISCARD" && o.tile === best.tile,
      );
    const protectLead =
      !basic && finalStage(view) && leading && view.players[s].points >= 30000;
    // A leading final-stage hand may already win without putting another 1,000 points at risk.
    const dama =
      shanten(
        tiles.filter((t) => t !== best.tile),
        melds,
        s,
      ) === 0;
    if (riichi && !defend && !(protectLead && dama)) return riichi.optionId;
    const kan = opts.find((o) => o.type === "ANKAN");
    if (kan && (basic || !threat.length)) return kan.optionId;
    const kakan = opts.find((o) => o.type === "KAKAN");
    if (kakan && (basic || !threat.length)) return kakan.optionId;
    return best.optionId;
  }
  const pass = opts.find((o) => o.type === "PASS")!;
  if (threat.length && !basic) return pass.optionId;
  const before = shanten(tiles, melds, s);
  let best: Option = pass,
    bestSt = before;
  for (const o of opts.filter(
    (o) => o.type === "PON" || o.type === "CHI" || o.type === "DAIMINKAN",
  )) {
    const k = kind(o.consumedTiles![0]);
    const yakuhai =
      o.type !== "CHI" &&
      (k >= 31 ||
        k === 27 + ((s - view.hand.dealerSeat + 4) % 4) ||
        k === 27 + ["EAST", "SOUTH", "WEST"].indexOf(view.hand.roundWind));
    const tanyao =
      tiles.every((t) => !terminal(kind(t))) &&
      melds.every((m) => m.tiles.every((t) => !terminal(kind(t))));
    if (
      !yakuhai &&
      !tanyao &&
      !melds.some((m) => m.type !== "ANKAN" && kind(m.tiles[0]) >= 31)
    )
      continue;
    const remaining = tiles.filter((t) => !o.consumedTiles!.includes(t));
    const extra = {
      meldId: "bot",
      type: o.type as "PON",
      tiles: o.consumedTiles!,
      sourceSeat: null,
      sourceDiscardId: null,
      calledTile: null,
      addedTile: null,
    };
    let st = Infinity;
    if (o.type === "DAIMINKAN") st = shanten(remaining, [...melds, extra], s);
    else
      for (const tile of remaining) {
        if (kind(tile) === k && o.type === "PON") continue;
        st = Math.min(
          st,
          shanten(
            remaining.filter((t) => t !== tile),
            [...melds, extra],
            s,
          ),
        );
      }
    if (st < bestSt) {
      bestSt = st;
      best = o;
    }
  }
  return best.optionId;
}
