import { createGame, project, quad } from "../backend/src/engine.ts";
import {
  BOT_POLICY_VERSION,
  type BotLevel,
  type Discard,
  type Meld,
  type MatchView,
  type Option,
  type Seat,
} from "../shared/types.ts";

/** Hands out physical tile ids for text such as "m123p0z11" (0 is a red five). */
export class Tiles {
  used = new Set<number>();
  take(text: string): number[] {
    return [...text.matchAll(/([mpsz])([0-9]+)/g)].flatMap(([, s, ns]) =>
      [...ns].map((n) => {
        const red = n === "0";
        const k =
          s === "z"
            ? 26 + Number(n)
            : ["m", "p", "s"].indexOf(s) * 9 + (red ? 5 : Number(n)) - 1;
        const ids = [0, 1, 2, 3].map((j) => k * 4 + j);
        const reds = [16, 52, 88];
        const id = ids.find(
          (t) => !this.used.has(t) && reds.includes(t) === red,
        );
        if (id === undefined) throw Error(`No ${s}${n} left`);
        this.used.add(id);
        return id;
      }),
    );
  }
}

export interface Position {
  /** Seat 0's hand; the last tile is the one just drawn. */
  hand: string;
  level?: BotLevel;
  /** Seat 0 is a human whose seat was handed to the AI. */
  hosted?: boolean;
  discards?: Partial<Record<Seat, string>>;
  riichi?: Seat[];
  /** Index of the discard a riichi was declared on (defaults to that seat's last). */
  riichiAt?: Partial<Record<Seat, number>>;
  melds?: Partial<Record<Seat, { type: Meld["type"]; tiles: string }[]>>;
  dora?: string;
  wall?: number;
  points?: number[];
  /** Offer riichi on every discard that leaves a ready hand's shape; the caller names them. */
  riichiOn?: string;
  /** A discard by `from` that seat 0 may answer. */
  call?: {
    from: Seat;
    tile: string;
    options: { type: Option["type"]; tiles: string }[];
  };
  round?: { wind: string; number: number };
}

/** A seat-0 view built by hand, so each case states exactly what the AI can see. */
export function position(p: Position): { view: MatchView; tiles: Tiles } {
  const g = createGame(
    "ai",
    quad((s) => ({
      memberId: "m" + s,
      userId: s === 0 && p.hosted ? "user0" : null,
      displayName: "P" + s,
      participantKind: s === 0 && p.hosted ? "HUMAN" : "BOT",
      ready: true,
      connected: true,
      botLevel:
        s === 0 && !p.hosted
          ? (p.level ?? "STANDARD")
          : s === 0
            ? null
            : "STANDARD",
      botPolicyVersion: BOT_POLICY_VERSION,
    })),
    undefined,
    Date.now(),
    7,
    "HANCHAN",
  );
  if (p.hosted) g.players[0].desiredControl = "AI";
  const view = project(g, 0),
    tiles = new Tiles();
  const own = tiles.take(p.hand);
  let id = 0;
  const option = (o: Omit<Option, "optionId">): Option => ({
    optionId: "o" + id++,
    ...o,
  });
  view.hand.dealerSeat = 1;
  view.hand.roundWind = p.round?.wind ?? "EAST";
  view.hand.roundNumber = p.round?.number ?? 1;
  view.hand.liveWallRemaining = p.wall ?? 50;
  view.hand.doraIndicators = tiles.take(p.dora ?? "z4");
  if (p.points) p.points.forEach((n, s) => (view.players[s].points = n));
  for (const s of [0, 1, 2, 3] as Seat[]) {
    const seat = view.hand.seats[s];
    seat.melds = (p.melds?.[s] ?? []).map((m, i) => {
      const ts = tiles.take(m.tiles);
      return {
        meldId: `meld${s}${i}`,
        type: m.type,
        tiles: ts,
        sourceSeat: m.type === "ANKAN" ? null : (((s + 3) % 4) as Seat),
        sourceDiscardId: null,
        calledTile: m.type === "ANKAN" ? null : ts[0],
        addedTile: null,
      };
    });
    seat.discards = tiles
      .take(p.discards?.[s] ?? "")
      .map((tile, i): Discard => ({
        discardId: `d${s}${i}`,
        tile,
        tsumogiri: false,
        riichiDeclaration: false,
        claimedByMeldId: null,
      }));
    seat.riichi = p.riichi?.includes(s) ? "ESTABLISHED" : "NONE";
    if (p.riichi?.includes(s) && seat.discards.length)
      seat.discards[
        p.riichiAt?.[s] ?? seat.discards.length - 1
      ].riichiDeclaration = true;
    seat.concealedCount = 13 - 3 * seat.melds.length;
  }
  const decision = view.self.decision!;
  if (p.call) {
    const tile = tiles.take(p.call.tile)[0];
    view.self.concealedTiles = own;
    view.self.drawnTile = null;
    view.hand.phase = "CALL_RESPONSE";
    view.hand.lastDiscard = {
      seat: p.call.from,
      discardId: "last",
      tile,
      tsumogiri: false,
      riichiDeclaration: false,
      claimedByMeldId: null,
    };
    decision.options = [
      option({ type: "PASS" }),
      ...p.call.options.map((o) => {
        // Two copies of one kind must be two different tiles from the hand.
        const picked: number[] = [];
        for (const [, suit, n] of o.tiles.matchAll(/([mpsz])([0-9])/g)) {
          const k =
            suit === "z"
              ? 26 + Number(n)
              : ["m", "p", "s"].indexOf(suit) * 9 + (Number(n) || 5) - 1;
          picked.push(
            own.find((t) => Math.floor(t / 4) === k && !picked.includes(t))!,
          );
        }
        return option({ type: o.type, consumedTiles: picked });
      }),
    ];
  } else {
    view.self.concealedTiles = own.slice(0, -1);
    view.self.drawnTile = own.at(-1)!;
    view.hand.phase = "SELF_ACTION";
    const riichi = p.riichiOn
      ? new Tiles().take(p.riichiOn).map((t) => Math.floor(t / 4))
      : [];
    decision.options = [
      ...own.map((tile) => option({ type: "DISCARD", tile })),
      ...own
        .filter((t) => riichi.includes(Math.floor(t / 4)))
        .map((tile) => option({ type: "RIICHI_DISCARD", tile })),
    ];
  }
  return { view, tiles };
}

/** What the chosen option does, as text: "DISCARD s5", "PON", "PASS"… */
export function describe(view: MatchView, optionId: string): string {
  const o = view.self.decision!.options.find((o) => o.optionId === optionId)!;
  if (o.tile === undefined) return o.type;
  const k = Math.floor(o.tile / 4);
  return `${o.type} ${k < 27 ? "mps"[Math.floor(k / 9)] + ((k % 9) + 1) : "z" + (k - 26)}`;
}
