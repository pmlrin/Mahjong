// Pure scene layout: MatchView → world transforms for every visible tile.
// No React, no WebGL; safe to run in Node tests.
import { Euler, Quaternion, Vector3 } from "three";
import type { MatchView, Meld, Seat } from "../../../shared/types";

/** World units: one tile is 1 wide. */
export const TILE = { width: 1, height: 1.36, thickness: 0.78, radius: 0.08 };
const GAP = 0.04;
const STEP = TILE.width + GAP;
// Rivers start beyond half a river row (plus one sideways tile) so the four
// rivers pinwheel without touching; four rows still clear the wall.
export const SCENE = {
  tableHalf: 14.6,
  centerHalf: 2.8,
  riverStart: 3.55,
  wallDistance: 10.3,
  handDistance: 12.3,
  meldDistance: 12.4,
  meldRight: 13.6,
  handLeft: -8.6,
} as const;
/**
 * The viewer's own hand is drawn larger than life and leans back toward the
 * camera, as in most 3D mahjong clients, standing just inside the near rail.
 */
export const SELF_HAND = {
  scale: 1.32,
  /** Lean back from vertical, radians; close to the camera pitch. */
  tilt: 0.72,
  left: -10.4,
  z: 13.5,
  drawnGap: 0.45,
} as const;
const WALL_STACKS = 17;
const RING = WALL_STACKS * 4;
const LIVE_TOTAL = 122; // 136 − 14 dead-wall tiles, including the 52 dealt

export type TileGroup = "river" | "meld" | "hand" | "wall" | "dead";
export interface TilePlacement {
  /** Stable key: `t<id>` for known tiles, positional otherwise. */
  key: string;
  /** Physical tile id 0–135, or null when the identity is not public. */
  tile: number | null;
  /** Whether the face is shown. Hidden tiles are never face up. */
  faceUp: boolean;
  group: TileGroup;
  seat: Seat;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  tsumogiri?: boolean;
  latest?: boolean;
  /** The tile a finished hand was won on (raised and marked). */
  winning?: boolean;
  /** Uniform scale; the viewer's own hand is enlarged. */
  scale?: number;
}
export interface LayoutOptions {
  /** Render the viewer's own concealed hand, enlarged and facing the camera. */
  selfHand?: boolean;
}

type Pose = "up" | "upSide" | "down" | "downSide" | "stand";
const POSES: Record<Pose, Quaternion> = {
  up: new Quaternion(),
  upSide: new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)),
  down: new Quaternion().setFromEuler(new Euler(0, 0, Math.PI)),
  downSide: new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, Math.PI)),
  stand: new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0)),
};
/** Rotation that turns seat-local space (+z toward the player) into world space. */
export function seatQuaternion(relative: number) {
  return new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    (relative * Math.PI) / 2,
  );
}
export const relativeSeat = (seat: number, viewer: number) =>
  (seat - viewer + 4) % 4;

function place(
  out: TilePlacement[],
  relative: number,
  seat: Seat,
  local: [number, number, number],
  pose: Pose,
  fields: Omit<TilePlacement, "position" | "quaternion" | "seat">,
) {
  const sq = seatQuaternion(relative);
  const p = new Vector3(...local).applyQuaternion(sq);
  const q = sq.clone().multiply(POSES[pose]);
  out.push({
    ...fields,
    seat,
    position: [round(p.x), round(p.y), round(p.z)],
    quaternion: [q.x, q.y, q.z, q.w],
  });
}
const round = (n: number) => Math.round(n * 1e4) / 1e4;
const lying = TILE.thickness / 2;

/** Display order of a meld's tiles, left → right, with the sideways ones marked. */
export function meldDisplay(meld: Meld, owner: Seat) {
  const relation =
    meld.sourceSeat === null ? null : relativeSeat(meld.sourceSeat, owner);
  if (meld.type === "ANKAN")
    return meld.tiles.map((tile, i) => ({
      tile,
      sideways: false,
      stacked: false,
      back: i === 0 || i === 3,
    }));
  const base = meld.tiles.filter((t) => t !== meld.addedTile);
  const called = meld.calledTile;
  const rest = base.filter((t) => t !== called);
  // Kamicha (left, 3) → leftmost; toimen (2) → second; shimocha (1) → rightmost.
  const at = relation === 3 ? 0 : relation === 2 ? 1 : rest.length;
  const order = called === null ? rest : [...rest];
  if (called !== null) order.splice(at, 0, called);
  const tiles = order.map((tile) => ({
    tile,
    sideways: tile === called,
    stacked: false,
    back: false,
  }));
  if (meld.type === "KAKAN" && meld.addedTile !== null)
    tiles.splice(tiles.findIndex((t) => t.sideways) + 1, 0, {
      tile: meld.addedTile,
      sideways: true,
      stacked: true,
      back: false,
    });
  return tiles;
}

export function layoutTable(
  view: MatchView,
  options: LayoutOptions = {},
): TilePlacement[] {
  const out: TilePlacement[] = [];
  const hand = view.hand,
    viewer = view.viewerSeat;
  const latestId = hand.lastDiscard?.discardId;
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const rel = relativeSeat(seat, viewer),
      h = hand.seats[seat];

    // River: rows of six, as on the flat table. A called tile has physically
    // moved to the caller's meld; when that was the riichi tile, the next
    // discard is laid sideways instead.
    let row = 0,
      inRow = 0,
      x = -3 * STEP + GAP / 2,
      sidewaysOwed = false;
    h.discards.forEach((d, i) => {
      if (d.claimedByMeldId) {
        if (d.riichiDeclaration) sidewaysOwed = true;
        return;
      }
      if (inRow === 6) {
        row++;
        inRow = 0;
        x = -3 * STEP + GAP / 2;
      }
      const side = d.riichiDeclaration || sidewaysOwed;
      sidewaysOwed = false;
      const w = side ? TILE.height : TILE.width;
      const z = SCENE.riverStart + row * (TILE.height + GAP) + TILE.height / 2;
      place(out, rel, seat, [x + w / 2, lying, z], side ? "upSide" : "up", {
        key: `t${d.tile}`,
        tile: d.tile,
        faceUp: true,
        group: "river",
        tsumogiri: d.tsumogiri,
        latest: d.discardId === latestId && i === h.discards.length - 1,
      });
      x += w + GAP;
      inRow++;
    });

    // Melds: from the player's right corner leftwards, first meld outermost.
    let cursor = SCENE.meldRight;
    for (const meld of h.melds) {
      const tiles = meldDisplay(meld, seat);
      const flat = tiles.filter((t) => !t.stacked);
      const width =
        flat.reduce((s, t) => s + (t.sideways ? TILE.height : TILE.width), 0) +
        GAP * (flat.length - 1);
      let mx = cursor - width;
      let sidewaysX = 0;
      for (const t of tiles) {
        if (t.stacked) {
          const z =
            SCENE.meldDistance + TILE.height / 2 - TILE.width * 1.5 - GAP;
          place(out, rel, seat, [sidewaysX, lying, z], "upSide", {
            key: `t${t.tile}`,
            tile: t.tile,
            faceUp: true,
            group: "meld",
          });
          continue;
        }
        const w = t.sideways ? TILE.height : TILE.width;
        const z = t.sideways
          ? SCENE.meldDistance + TILE.height / 2 - TILE.width / 2
          : SCENE.meldDistance;
        if (t.sideways) sidewaysX = mx + w / 2;
        place(
          out,
          rel,
          seat,
          [mx + w / 2, lying, z],
          t.back ? "down" : t.sideways ? "upSide" : "up",
          { key: `t${t.tile}`, tile: t.tile, faceUp: !t.back, group: "meld" },
        );
        mx += w + GAP;
      }
      cursor -= width + 0.35;
    }

    // Concealed hands: opponents only by count; the viewer's own on request.
    // At the hand's result, hands the result reveals lie face up.
    const standing = TILE.height / 2;
    const shown = revealed(view, seat);
    if (seat !== viewer && shown) {
      shown.forEach((t, i) =>
        place(
          out,
          rel,
          seat,
          [
            SCENE.handLeft +
              i * STEP +
              (i === shown.length - 1 && shown.drawn ? 0.35 : 0) +
              TILE.width / 2,
            lying,
            SCENE.handDistance,
          ],
          "up",
          { key: `t${t}`, tile: t, faceUp: true, group: "hand" },
        ),
      );
    } else if (seat !== viewer) {
      for (let i = 0; i < h.concealedCount; i++)
        place(
          out,
          rel,
          seat,
          [
            SCENE.handLeft + i * STEP + TILE.width / 2,
            standing,
            SCENE.handDistance,
          ],
          "stand",
          { key: `h${seat}-${i}`, tile: null, faceUp: false, group: "hand" },
        );
    } else if (options.selfHand) {
      selfHand(view, out);
    }
  }
  layoutWall(view, out);
  const result = handResult(view);
  if (result) {
    const won = new Set(result.wins.map((w) => w.winningTile));
    for (const p of out)
      if (p.tile !== null && won.has(p.tile)) p.winning = true;
  }
  return out;
}

/** This hand's result, while it is being shown. */
function handResult(view: MatchView) {
  const result = view.lastHandResult;
  return view.hand.phase === "HAND_RESULT" &&
    result &&
    result.handId === view.hand.handId
    ? result
    : null;
}

/**
 * Tiles a finished hand's result reveals for one seat, in order, with a drawn
 * (tsumo) tile last. A ron tile stays where it lies, in the discarder's river.
 */
function revealed(view: MatchView, seat: Seat) {
  const result = handResult(view);
  if (!result) return null;
  const hand = result.revealedHands.find((r) => r.seat === seat);
  if (!hand) return null;
  const tiles = [...hand.concealedTiles] as number[] & { drawn?: boolean };
  if (hand.drawnTile !== null && !tiles.includes(hand.drawnTile)) {
    tiles.push(hand.drawnTile);
    tiles.drawn = true;
  }
  return tiles;
}

/**
 * Whether going from one layout to the next is more than one action moves (a
 * call moves four tiles, a kan five with its dora): a resync, a reconnect or
 * several steps in one update. Such changes are placed, not replayed.
 * Tiles merely shifting within a hand or the wall shrinking do not count.
 */
export function isJump(
  before: ReadonlyMap<string, TilePlacement>,
  after: TilePlacement[],
) {
  let moved = 0;
  for (const p of after) {
    if (p.group === "wall") continue;
    const old = before.get(p.key);
    if (!old) {
      if (p.group !== "hand" && p.group !== "dead") moved++;
    } else if (old.group !== p.group || old.seat !== p.seat) moved++;
  }
  return moved > 6;
}

/** Where a seat's concealed hand sits, standing: the start of tiles it plays. */
export function seatHandOrigin(relative: number) {
  const sq = seatQuaternion(relative);
  const p = new Vector3(
    SCENE.handLeft + 6.5,
    TILE.height / 2,
    SCENE.handDistance,
  ).applyQuaternion(sq);
  const q = sq.clone().multiply(POSES.stand);
  return { position: p, quaternion: q };
}
/** A placement's pose standing upright in place, for revealed hands falling flat. */
export function standingAt(p: TilePlacement, relative: number) {
  return {
    position: new Vector3(p.position[0], TILE.height / 2, p.position[2]),
    quaternion: seatQuaternion(relative).multiply(POSES.stand),
  };
}

/** Local "up" of a self-hand tile's glyph, used to lift a selected tile. */
export function selfHandUp() {
  return new Vector3(0, Math.cos(SELF_HAND.tilt), -Math.sin(SELF_HAND.tilt));
}
function selfHand(view: MatchView, out: TilePlacement[]) {
  const { scale, tilt, left, z, drawnGap } = SELF_HAND;
  const q = new Quaternion().setFromEuler(new Euler(Math.PI / 2 - tilt, 0, 0));
  const quaternion: TilePlacement["quaternion"] = [q.x, q.y, q.z, q.w];
  // Rest the lower edge on the felt.
  const y =
    (scale / 2) *
    (TILE.height * Math.cos(tilt) + TILE.thickness * Math.sin(tilt));
  const step = STEP * scale;
  const put = (tile: number, x: number) =>
    out.push({
      key: `t${tile}`,
      tile,
      faceUp: true,
      group: "hand",
      seat: view.viewerSeat,
      position: [round(x), round(y), z],
      quaternion,
      scale,
    });
  const tiles = view.self.concealedTiles;
  tiles.forEach((t, i) => put(t, left + i * step + (TILE.width * scale) / 2));
  if (view.self.drawnTile !== null)
    put(
      view.self.drawnTile,
      left + tiles.length * step + drawnGap + (TILE.width * scale) / 2,
    );
}

/** Ring slot i (0–67) → seat-relative side and local x along that wall. */
function wallSlot(i: number) {
  const r = ((i % RING) + RING) % RING;
  return {
    rel: Math.floor(r / WALL_STACKS),
    x: ((r % WALL_STACKS) - (WALL_STACKS - 1) / 2) * (TILE.width + 0.02),
  };
}
/**
 * The wall is decorative: MatchView has no dice, so the break sits at a fixed
 * stack on the dealer's side. Counts come from liveWallRemaining,
 * rinshanRemaining and doraIndicators; tile identities are never invented.
 */
function layoutWall(view: MatchView, out: TilePlacement[]) {
  const hand = view.hand,
    viewer = view.viewerSeat;
  const dealerRel = relativeSeat(hand.dealerSeat, viewer);
  const breakSlot = dealerRel * WALL_STACKS + 12;
  const seatOf = (rel: number) => ((viewer + rel) % 4) as Seat;
  const level = (top: boolean) => (top ? TILE.thickness * 1.5 : lying);
  const live = Math.max(0, Math.min(LIVE_TOTAL, hand.liveWallRemaining));
  for (let p = LIVE_TOTAL - live; p < LIVE_TOTAL; p++) {
    const slot = wallSlot(breakSlot - 1 - Math.floor(p / 2));
    place(
      out,
      slot.rel,
      seatOf(slot.rel),
      [slot.x, level(p % 2 === 0), SCENE.wallDistance],
      "down",
      { key: `w${p}`, tile: null, faceUp: false, group: "wall" },
    );
  }
  // Dead wall: seven stacks after the break; f counts from the far end.
  const taken = Math.max(0, Math.min(4, 4 - hand.rinshanRemaining));
  for (let f = 0; f < 7; f++) {
    const slot = wallSlot(breakSlot + 6 - f);
    for (const top of [true, false]) {
      const order = f * 2 + (top ? 0 : 1);
      if (f < 2 && order < taken) continue;
      const dora = top && f >= 2 ? hand.doraIndicators[f - 2] : undefined;
      place(
        out,
        slot.rel,
        seatOf(slot.rel),
        [slot.x, level(top), SCENE.wallDistance],
        dora === undefined ? "down" : "up",
        dora === undefined
          ? {
              key: `d${f}${top ? "t" : "b"}`,
              tile: null,
              faceUp: false,
              group: "dead",
            }
          : { key: `t${dora}`, tile: dora, faceUp: true, group: "dead" },
      );
    }
  }
  // A riichi win turns over the ura dora: laid face up just inside the dead
  // wall, in front of the indicator each one sits under.
  const ura = handResult(view)?.revealedUraIndicators ?? [];
  ura.forEach((tile, i) => {
    const slot = wallSlot(breakSlot + 6 - (i + 2));
    place(
      out,
      slot.rel,
      seatOf(slot.rel),
      [slot.x, lying, SCENE.wallDistance - TILE.height - 0.15],
      "up",
      { key: `t${tile}`, tile, faceUp: true, group: "dead" },
    );
  });
}
