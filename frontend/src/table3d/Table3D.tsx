import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree, type RootState } from "@react-three/fiber";
import {
  CanvasTexture,
  ConeGeometry,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Group,
} from "three";
import { tileName, type MatchView, type Seat } from "../../../shared/types";
import { PlayerPlate, windName } from "../PlayerPlate";
import { Tile } from "../Tile";
import { LatestDiscard } from "../turn-feedback";
import type { Anchor, AnchorStore } from "../hand-anchors";
import { createTile } from "./geometry";
import { QUALITY, frameVerdict, type QualityLevel } from "./quality";
import { useReducedMotion } from "../motion";
import { DISCARD_FLIGHT, REVEAL } from "./timing";
import {
  SCENE,
  SELF_HAND,
  TILE,
  isJump,
  layoutTable,
  selfHandUp,
  relativeSeat,
  seatHandOrigin,
  seatQuaternion,
  standingAt,
  type TilePlacement,
} from "./layout";
import {
  atlasCell,
  centerInfo,
  createFaceAtlas,
  drawCenterPlate,
  readPalette,
  srgb,
  type CenterInfo,
  type Palette,
} from "./textures";
import "./table3d.css";

interface Kit {
  palette: Palette;
  marker: BufferGeometry;
  materials: {
    tile: MeshStandardMaterial;
    tileTsumogiri: MeshStandardMaterial;
    tileDim: MeshStandardMaterial;
    marker: MeshStandardMaterial;
  };
  /** One merged geometry per glyph (0–36), plus the blank tile under −1. */
  tiles: Map<number, BufferGeometry>;
  dispose(): void;
}

function createKit(): Kit {
  const palette = readPalette();
  const atlas = createFaceAtlas(palette);
  const marker = new ConeGeometry(0.2, 0.42, 20);
  marker.rotateX(Math.PI);
  // Face colour and glyphs come from the atlas; the back layer from vertex colour.
  const tile = {
    map: atlas,
    vertexColors: true,
    roughness: 0.52,
    metalness: 0,
  };
  const materials = {
    tile: new MeshStandardMaterial(tile),
    tileTsumogiri: new MeshStandardMaterial({
      ...tile,
      color: srgb("#d4d0c8"),
    }),
    tileDim: new MeshStandardMaterial({ ...tile, color: srgb("#aaa59c") }),
    marker: new MeshStandardMaterial({
      color: srgb(palette["--color-signal"]),
      emissive: srgb(palette["--color-signal"]),
      emissiveIntensity: 0.35,
    }),
  };
  const tiles = new Map<number, BufferGeometry>();
  return {
    palette,
    marker,
    materials,
    tiles,
    dispose() {
      atlas.dispose();
      marker.dispose();
      tiles.forEach((g) => g.dispose());
      Object.values(materials).forEach((m) => m.dispose());
    },
  };
}
function tileGeometry(kit: Kit, glyph: number | null) {
  const k = glyph ?? -1;
  let g = kit.tiles.get(k);
  if (!g)
    kit.tiles.set(k, (g = createTile(srgb(kit.palette["--tile-back"]), glyph)));
  return g;
}

/** How far a selected own-hand tile rises, along its own "up". */
const LIFT = selfHandUp().multiplyScalar(0.42 * SELF_HAND.scale);
/** How far the winning tile rises off the table. */
const WIN_LIFT = 0.45;

/** Where a tile first appears from, when it was not on the table a moment ago. */
interface Origin {
  position: Vector3;
  quaternion: Quaternion;
  arc: number;
}
interface Motion {
  fromP: Vector3;
  fromQ: Quaternion;
  toP: Vector3;
  toQ: Quaternion;
  start: number;
  duration: number;
  arc: number;
  /** A discard: travel to a point above the river, hang, then drop. */
  hover?: Vector3;
}
const now = () => performance.now() / 1000;
function motion(
  fromP: Vector3,
  fromQ: Quaternion,
  toP: Vector3,
  toQ: Quaternion,
  arc?: number,
  delay = 0,
): Motion {
  const distance = fromP.distanceTo(toP);
  return {
    fromP: fromP.clone(),
    fromQ: fromQ.clone(),
    toP,
    toQ,
    start: now() + delay,
    // Short hops (a lift) are quick; flights across the table take longer.
    duration: Math.min(0.46, 0.13 + distance * 0.02),
    arc: arc ?? (distance > 2.5 ? Math.min(1.4, distance * 0.09) : 0),
  };
}
/** The fixed-length discard flight, so its sound can land with it. */
function discardMotion(
  fromP: Vector3,
  fromQ: Quaternion,
  toP: Vector3,
  toQ: Quaternion,
): Motion {
  const hover = toP.clone().setY(toP.y + DISCARD_FLIGHT.hover);
  return {
    fromP: fromP.clone(),
    fromQ: fromQ.clone(),
    toP,
    toQ,
    start: now(),
    duration: DISCARD_FLIGHT.duration,
    arc: 0,
    hover,
  };
}
const scratch = new Vector3();
/** Place a moving tile at `t` (0–1) along its motion. */
function step(g: Group, mv: Motion, t: number) {
  if (!mv.hover) {
    const e = 1 - (1 - t) ** 3;
    g.position.lerpVectors(mv.fromP, mv.toP, e);
    g.position.y += Math.sin(Math.PI * t) * mv.arc;
    g.quaternion.slerpQuaternions(mv.fromQ, mv.toQ, e);
    return;
  }
  const { travel, hang } = DISCARD_FLIGHT;
  // Hang drifts down a quarter of the hover height, then the drop speeds up.
  const low = scratch.lerpVectors(mv.toP, mv.hover, 0.75);
  if (t < travel) {
    // Up to the hover height first, then across: lifted, never tossed.
    const u = t / travel,
      across = 1 - (1 - u) ** 3,
      up = 1 - (1 - u) ** 6;
    g.position.lerpVectors(mv.fromP, mv.hover, across);
    g.position.y = mv.fromP.y + (mv.hover.y - mv.fromP.y) * up;
    g.quaternion.slerpQuaternions(mv.fromQ, mv.toQ, across);
  } else if (t < hang) {
    const u = (t - travel) / (hang - travel);
    g.position.lerpVectors(mv.hover, low, u * u);
    g.quaternion.copy(mv.toQ);
  } else {
    const u = (t - hang) / (1 - hang);
    g.position.lerpVectors(low, mv.toP, u * u);
    g.quaternion.copy(mv.toQ);
  }
}

/**
 * One physical tile. Its transform is driven here, not by props: when its
 * target changes it travels there (keyed by tile id, so a discard flies from
 * hand to river and a called tile from river to meld); when the scene says
 * not to animate, it is placed at once.
 */
function TileMesh({
  p,
  kit,
  lifted = false,
  dim = false,
  animate,
  origin,
  delay = 0,
}: {
  p: TilePlacement;
  kit: Kit;
  lifted?: boolean;
  dim?: boolean;
  animate: boolean;
  origin?: Origin;
  /** Seconds to wait before moving (a finished hand plays out in turn). */
  delay?: number;
}) {
  const m = kit.materials;
  const showFace = p.faceUp && p.tile !== null;
  const ref = useRef<Group>(null);
  const moving = useRef<Motion | null>(null);
  const mounted = useRef(false);
  const group = useRef(p.group);
  const invalidate = useThree((s) => s.invalidate);
  const [x, y, z] = p.position;
  const target = lifted
    ? [x + LIFT.x, y + LIFT.y, z + LIFT.z]
    : p.winning
      ? [x, y + WIN_LIFT, z]
      : [x, y, z];
  const key = [...target, ...p.quaternion].map((n) => n.toFixed(4)).join();
  useLayoutEffect(() => {
    const g = ref.current!;
    const toP = new Vector3(...target),
      toQ = new Quaternion(...p.quaternion);
    const first = !mounted.current;
    mounted.current = true;
    const was = group.current;
    group.current = p.group;
    // Into the river from a hand: an opponent's unseen tile (it has an
    // origin) or the viewer's own tile (it was in the hand a moment ago).
    const discard =
      animate && p.group === "river" && (first ? !!origin : was === "hand");
    if (discard) {
      const from = first
        ? origin!
        : { position: g.position, quaternion: g.quaternion };
      moving.current = discardMotion(from.position, from.quaternion, toP, toQ);
      g.position.copy(from.position);
      g.quaternion.copy(from.quaternion);
    } else if (first && animate && origin) {
      moving.current = motion(
        origin.position,
        origin.quaternion,
        toP,
        toQ,
        origin.arc,
        delay,
      );
      g.position.copy(origin.position);
      g.quaternion.copy(origin.quaternion);
    } else if (first || !animate) {
      moving.current = null;
      g.position.copy(toP);
      g.quaternion.copy(toQ);
    } else {
      moving.current = motion(
        g.position,
        g.quaternion,
        toP,
        toQ,
        undefined,
        delay,
      );
    }
    invalidate();
  }, [key, animate]);
  useFrame((state) => {
    const mv = moving.current;
    if (!mv) return;
    const g = ref.current!;
    // Before a delayed start the tile waits where it was.
    const t = Math.max(0, Math.min(1, (now() - mv.start) / mv.duration));
    step(g, mv, t);
    if (t < 1) state.invalidate();
    else moving.current = null;
  });
  return (
    <group ref={ref} name={p.key} scale={p.scale ?? 1}>
      <mesh
        geometry={tileGeometry(kit, showFace ? atlasCell(p.tile!) : null)}
        material={
          showFace && dim
            ? m.tileDim
            : showFace && p.tsumogiri
              ? m.tileTsumogiri
              : m.tile
        }
        castShadow
        receiveShadow
      />
      {(p.latest || p.winning) && (
        <mesh
          geometry={kit.marker}
          material={m.marker}
          position={[0, TILE.thickness / 2 + 0.75, 0]}
        />
      )}
    </group>
  );
}

/** A tile that was not on the table before: where does it come from? */
function originOf(p: TilePlacement, viewer: number): Origin | undefined {
  const rel = relativeSeat(p.seat, viewer);
  const at = new Vector3(...p.position),
    q = new Quaternion(...p.quaternion);
  if (p.group === "river" || p.group === "meld") {
    // Out of a concealed hand the viewer could not see.
    const o = seatHandOrigin(rel);
    return { ...o, arc: p.group === "river" ? 1.1 : 0.5 };
  }
  if (p.group === "hand" && p.tile !== null && p.seat !== viewer) {
    // A revealed hand falls flat from standing.
    return { ...standingAt(p, rel), arc: 0 };
  }
  if (p.group === "hand") {
    // A draw drops into place.
    return {
      position: at.clone().add(new Vector3(0, 1.1, 0)),
      quaternion: q,
      arc: 0,
    };
  }
  if (p.group === "dead" && p.faceUp) {
    // A new dora indicator flips over where it lies.
    return {
      position: at,
      quaternion: q.clone().multiply(FLIP),
      arc: 0.6,
    };
  }
  return undefined;
}
const FLIP = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);

function TableBody({ palette }: { palette: Palette }) {
  const half = SCENE.tableHalf,
    rail = 1.1;
  const felt = useMemo(() => srgb(palette["--color-felt"]), [palette]);
  const deep = useMemo(() => srgb(palette["--color-felt-deep"]), [palette]);
  return (
    <group>
      <mesh position={[0, -0.2, 0]} receiveShadow>
        <boxGeometry args={[half * 2, 0.4, half * 2]} />
        <meshStandardMaterial color={felt} roughness={0.95} />
      </mesh>
      {[0, 1, 2, 3].map((r) => (
        <mesh
          key={r}
          position={new Vector3(
            rail / 2 - half - rail,
            0.05,
            0,
          ).applyQuaternion(seatQuaternion(r))}
          quaternion={seatQuaternion(r)}
          receiveShadow
        >
          <boxGeometry args={[rail, 0.9, half * 2 + rail * 2]} />
          <meshStandardMaterial color={deep} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function CenterPlate({
  info,
  palette,
}: {
  info: CenterInfo;
  palette: Palette;
}) {
  const texture = useMemo(() => {
    const t = new CanvasTexture(document.createElement("canvas"));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, []);
  const key = JSON.stringify(info);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    drawCenterPlate(texture.image as HTMLCanvasElement, info, palette);
    texture.needsUpdate = true;
    invalidate();
  }, [key, palette]);
  useEffect(() => () => texture.dispose(), [texture]);
  const size = SCENE.centerHalf * 2;
  return (
    <group>
      <mesh position={[0, 0.12, 0]} castShadow receiveShadow>
        <boxGeometry args={[size, 0.24, size]} />
        <meshStandardMaterial
          color={srgb(palette["--color-felt-deep"])}
          roughness={0.6}
        />
      </mesh>
      <mesh position={[0, 0.242, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size - 0.1, size - 0.1]} />
        <meshStandardMaterial map={texture} roughness={0.8} />
      </mesh>
    </group>
  );
}

/** A riichi stick, once the riichi stands (its discard passed). */
function RiichiStick({
  seat,
  viewer,
  palette,
  animate,
}: {
  seat: number;
  viewer: number;
  palette: Palette;
  animate: boolean;
}) {
  const ref = useRef<Group>(null);
  const slide = useRef<{ from: Vector3; start: number } | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const rel = relativeSeat(seat, viewer);
  const q = seatQuaternion(rel);
  const at = new Vector3(0, 0.05, SCENE.centerHalf + 0.35).applyQuaternion(q);
  useLayoutEffect(() => {
    // Laid down from the player's side of the table, sliding in to the centre.
    if (!animate) return;
    const from = new Vector3(0, 0.35, SCENE.riverStart + 2.2)
      .applyQuaternion(q)
      .setY(0.35);
    slide.current = { from, start: now() };
    ref.current!.position.copy(from);
    invalidate();
  }, []);
  useFrame((state) => {
    const sl = slide.current;
    if (!sl) return;
    const t = Math.min(1, (now() - sl.start) / RIICHI_STICK_SLIDE);
    const e = 1 - (1 - t) ** 3;
    ref.current!.position.lerpVectors(sl.from, at, e);
    if (t < 1) state.invalidate();
    else slide.current = null;
  });
  return (
    <group ref={ref} name={`riichi-${seat}`} position={at} quaternion={q}>
      <mesh castShadow>
        <boxGeometry args={[2.6, 0.1, 0.18]} />
        <meshStandardMaterial
          color={srgb(palette["--tile-face"])}
          roughness={0.4}
        />
      </mesh>
      <mesh position={[0, 0.051, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.07, 16]} />
        <meshStandardMaterial color={srgb(palette["--color-riichi"])} />
      </mesh>
    </group>
  );
}
const RIICHI_STICK_SLIDE = 0.36;
function RiichiSticks({
  view,
  palette,
  animate,
}: {
  view: MatchView;
  palette: Palette;
  animate: boolean;
}) {
  return (
    <>
      {view.hand.seats.map((h, s) =>
        h.riichi === "ESTABLISHED" ? (
          <RiichiStick
            // A new hand gets new sticks.
            key={`${view.hand.handId}-${s}`}
            seat={s}
            viewer={view.viewerSeat}
            palette={palette}
            animate={animate}
          />
        ) : null,
      )}
    </>
  );
}

const EDGE = SCENE.meldRight + 0.4;
const HAND_RIGHT =
  SELF_HAND.left + 14 * 1.04 * SELF_HAND.scale + SELF_HAND.drawnGap;
const HAND_TOP = 2.1 * SELF_HAND.scale;
const FIT_POINTS = [
  [-EDGE, 0, SCENE.meldDistance + TILE.height / 2],
  [EDGE, 0, SCENE.meldDistance + TILE.height / 2],
  [-EDGE, 0, -EDGE],
  [EDGE, 0, -EDGE],
  [0, TILE.height, -SCENE.handDistance - TILE.thickness],
  [SELF_HAND.left - 0.2, 0, SELF_HAND.z + 1],
  [HAND_RIGHT, 0, SELF_HAND.z + 1],
  [SELF_HAND.left - 0.2, HAND_TOP, SELF_HAND.z],
  [HAND_RIGHT, HAND_TOP, SELF_HAND.z],
].map(([x, y, z]) => new Vector3(x, y, z));
/** Place the camera behind the viewer's seat so the whole table fits the canvas. */
function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    // Wide, short canvases (phones in landscape) look in lower so the depth
    // compresses and the camera can come closer; the hand then reads larger.
    const aspect = size.width / Math.max(1, size.height);
    const pitch =
      ((aspect >= 2.2 ? 36 : aspect >= 1.8 ? 41 : 46) * Math.PI) / 180;
    const target = new Vector3(0, 0, 2);
    const direction = new Vector3(0, Math.sin(pitch), Math.cos(pitch));
    camera.fov = 36;
    camera.aspect = size.width / Math.max(1, size.height);
    camera.updateProjectionMatrix();
    const fits = (distance: number) => {
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      return FIT_POINTS.every((p) => {
        const v = p.clone().project(camera);
        return Math.abs(v.x) <= 0.97 && v.y <= 0.84 && v.y >= -0.97;
      });
    };
    let lo = 8,
      hi = 160;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);
    invalidate();
  }, [camera, size.width, size.height]);
  // Resizing the drawing buffer (size or pixel ratio) clears it; on-demand
  // rendering would otherwise leave the canvas empty until the next update.
  const dpr = useThree((s) => s.viewport.dpr);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    invalidate();
    const id = requestAnimationFrame(() => invalidate());
    return () => cancelAnimationFrame(id);
  }, [dpr, gl, size.width, size.height]);
  return null;
}

/** The glyph face of an own-hand tile, resting and raised, as screen rectangles. */
const FACE_CORNERS = [-1, 1].flatMap((x) =>
  [-1, 1].map(
    (z) =>
      new Vector3(
        (x * TILE.width) / 2,
        TILE.thickness / 2,
        (z * TILE.height) / 2,
      ),
  ),
);
function HandAnchors({
  placements,
  viewer,
  anchors,
}: {
  placements: TilePlacement[];
  viewer: Seat;
  anchors: AnchorStore;
}) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  // Runs after CameraRig's layout effect (sibling order), so the camera is placed.
  useLayoutEffect(() => {
    const out = new Map<number, Anchor>();
    const corner = new Vector3();
    for (const p of placements) {
      // Only the viewer's own hand: the others' are face up at a hand's end.
      if (p.group !== "hand" || p.seat !== viewer || p.tile === null) continue;
      const q = new Quaternion(...p.quaternion);
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const raised of [false, true])
        for (const c of FACE_CORNERS) {
          corner
            .copy(c)
            .multiplyScalar(p.scale ?? 1)
            .applyQuaternion(q)
            .add(new Vector3(...p.position));
          if (raised) corner.add(LIFT);
          corner.project(camera);
          const x = ((corner.x + 1) / 2) * size.width,
            y = ((1 - corner.y) / 2) * size.height;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      out.set(p.tile, {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      });
    }
    anchors.set(out);
  }, [placements, viewer, camera, size.width, size.height, anchors]);
  useEffect(() => () => anchors.set(new Map()), [anchors]);
  return null;
}

export interface Table3DHand {
  selected: number | null;
  /** Comma-joined ids of own tiles that cannot be played right now. */
  dim: string;
  anchors: AnchorStore;
}

/** Watches frame times while tiles move and reports a sustained slow run. */
function FrameMonitor({ onSlow }: { onSlow: () => void }) {
  const intervals = useRef<number[]>([]);
  useFrame((_, delta) => {
    const run = intervals.current;
    run.push(delta);
    const verdict = frameVerdict(run);
    if (verdict === null) return;
    intervals.current = [];
    if (verdict === "slow") onSlow();
  });
  return null;
}

function Scene({
  view,
  kit,
  hand,
  quality,
  reduce,
  onSlow,
}: {
  view: MatchView;
  kit: Kit;
  hand?: Table3DHand;
  quality: QualityLevel;
  /** Leave motion out: tiles are placed, not moved. */
  reduce: boolean;
  onSlow: () => void;
}) {
  const placements = useMemo(
    () => layoutTable(view, { selfHand: !!hand }),
    [view, !!hand],
  );
  const dim = useMemo(
    () => new Set((hand?.dim ?? "").split(",").filter(Boolean).map(Number)),
    [hand?.dim],
  );
  // Compare with the previous layout: animate a single step of play; place
  // everything at once on first show, a new hand, or a jump.
  const previous = useRef<{
    handId: string;
    phase: string;
    byKey: Map<string, TilePlacement>;
  } | null>(null);
  const { animate, origins, delays } = useMemo(() => {
    const before = previous.current;
    const origins = new Map<string, Origin>();
    const delays = new Map<string, number>();
    if (reduce || !before || before.handId !== view.hand.handId)
      return { animate: false, origins, delays };
    for (const p of placements)
      if (p.group !== "wall" && !before.byKey.has(p.key)) {
        const o = originOf(p, view.viewerSeat);
        if (o) origins.set(p.key, o);
      }
    // The hand just ended: after a beat the revealed hands fall one tile
    // after another, the winning tile rises, then any ura dora turn over.
    if (before.phase !== "HAND_RESULT" && view.hand.phase === "HAND_RESULT") {
      const fallen = new Map<number, number>();
      let ura = 0;
      for (const p of placements) {
        if (before.byKey.has(p.key)) {
          if (p.winning) delays.set(p.key, REVEAL.lift);
        } else if (p.group === "hand" && p.tile !== null) {
          const i = fallen.get(p.seat) ?? 0;
          fallen.set(p.seat, i + 1);
          delays.set(p.key, REVEAL.pause + i * REVEAL.stagger);
        } else if (
          p.group === "dead" &&
          p.faceUp &&
          !view.hand.doraIndicators.includes(p.tile!)
        )
          delays.set(p.key, REVEAL.ura + ura++ * REVEAL.uraStagger);
      }
    }
    return { animate: !isJump(before.byKey, placements), origins, delays };
  }, [placements, reduce]);
  useEffect(() => {
    previous.current = {
      handId: view.hand.handId,
      phase: view.hand.phase,
      byKey: new Map(placements.map((p) => [p.key, p])),
    };
  }, [placements]);
  const info = centerInfo(view);
  return (
    <>
      <hemisphereLight
        args={[srgb("#fff8ee"), srgb(kit.palette["--color-felt-deep"]), 1.5]}
      />
      <directionalLight
        // A new light per quality step: a shadow map cannot be resized in place.
        key={`${quality.shadows}-${quality.shadowSize}`}
        position={[-8, 24, 14]}
        intensity={2.1}
        castShadow={quality.shadows}
        shadow-mapSize={[quality.shadowSize, quality.shadowSize]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-17}
        shadow-camera-right={17}
        shadow-camera-top={17}
        shadow-camera-bottom={-17}
        shadow-camera-near={1}
        shadow-camera-far={60}
      />
      <TableBody palette={kit.palette} />
      <CenterPlate info={info} palette={kit.palette} />
      <RiichiSticks view={view} palette={kit.palette} animate={animate} />
      {placements.map((p) => (
        <TileMesh
          key={p.key}
          p={p}
          kit={kit}
          lifted={
            p.group === "hand" && p.tile !== null && p.tile === hand?.selected
          }
          dim={p.group === "hand" && p.tile !== null && dim.has(p.tile)}
          animate={animate}
          origin={origins.get(p.key)}
          delay={delays.get(p.key)}
        />
      ))}
      <CameraRig />
      <FrameMonitor onSlow={onSlow} />
      {hand && (
        <HandAnchors
          placements={placements}
          viewer={view.viewerSeat}
          anchors={hand.anchors}
        />
      )}
    </>
  );
}

function RiverSummary({ view }: { view: MatchView }) {
  return (
    <div className="visually-hidden">
      {[0, 1, 2, 3].map((rel) => {
        const s = ((view.viewerSeat + rel) % 4) as Seat;
        const discards = view.hand.seats[s].discards;
        return (
          <p key={s}>
            {view.players[s].displayName}的牌河：
            {discards.length
              ? discards
                  .map(
                    (d) =>
                      tileName(d.tile) +
                      (d.riichiDeclaration ? "（立直）" : "") +
                      (d.claimedByMeldId ? "（被鸣）" : "") +
                      (d.tsumogiri ? "（摸切）" : ""),
                  )
                  .join("、")
              : "无"}
          </p>
        );
      })}
    </div>
  );
}

/** How long to wait for the browser to restore a lost WebGL context. */
const CONTEXT_RESTORE_WAIT = 3000;

// Canvas configuration must keep its identity: R3F reconfigures the root when
// these change, and the game page re-renders several times a second.
const CAMERA = {
  fov: 36,
  near: 1,
  far: 300,
  position: [0, 30, 30] as [number, number, number],
};
const GL = {
  antialias: true,
  alpha: true,
  powerPreference: "high-performance" as const,
};

function Table3D({
  view,
  hand: handState,
  onFail,
}: {
  view: MatchView;
  hand?: Table3DHand;
  onFail: (reason: string) => void;
}) {
  const kit = useMemo(createKit, []);
  const reduce = useReducedMotion();
  useEffect(() => () => kit.dispose(), [kit]);
  const fail = useRef(onFail);
  fail.current = onFail;
  // Step down quality on a slow device; when even the cheapest step is slow,
  // hand over to the flat table.
  const [level, setLevel] = useState(0);
  const levelRef = useRef(level);
  levelRef.current = level;
  const slower = useCallback(() => {
    if (levelRef.current + 1 < QUALITY.length) setLevel(levelRef.current + 1);
    else fail.current("slow");
  }, []);
  // R3F sizes its canvas with react-use-measure, whose first ResizeObserver
  // report can land before it marks itself mounted and is then dropped; the
  // canvas would stay unconfigured until the next layout change. It also
  // listens for window resize, so one resize after mount settles the size.
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
    const id = requestAnimationFrame(() =>
      window.dispatchEvent(new Event("resize")),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  // Unmounting forces a context loss of its own; only a loss while shown is a failure.
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const created = useCallback((state: RootState) => {
    // Development only: lets the scene be inspected from the browser console.
    if (import.meta.env.DEV)
      (window as { __table3d?: RootState }).__table3d = state;
    // A lost context (GPU reset, memory pressure, a backgrounded tab) is often
    // restored by the browser; three.js then re-uploads everything. Wait a
    // moment for that before giving up on 3D.
    const canvas = state.gl.domElement;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      if (!alive.current) return;
      clearTimeout(giveUp);
      giveUp = setTimeout(() => {
        if (alive.current) fail.current("context-lost");
      }, CONTEXT_RESTORE_WAIT);
    });
    canvas.addEventListener("webglcontextrestored", () => {
      clearTimeout(giveUp);
      state.get().invalidate();
    });
  }, []);
  const hand = view.hand,
    self = view.viewerSeat;
  const seat = (rel: number) => ((self + rel) % 4) as Seat;
  const riverCounts = hand.seats.map((h) => h.discards.length).join(",");
  return (
    <section
      className="game-table table-3d"
      aria-label="3D 牌桌"
      data-river-counts={riverCounts}
      data-wall={hand.liveWallRemaining}
    >
      <Canvas
        className="table-3d-canvas"
        aria-hidden="true"
        shadows="percentage"
        flat
        dpr={QUALITY[level].dpr}
        frameloop="demand"
        camera={CAMERA}
        gl={GL}
        onCreated={created}
      >
        <Scene
          view={view}
          kit={kit}
          hand={handState}
          quality={QUALITY[level]}
          reduce={reduce}
          onSlow={slower}
        />
      </Canvas>
      <div className="table-3d-hud">
        <PlayerPlate view={view} seat={seat(2)} className="hud-top" />
        <PlayerPlate view={view} seat={seat(3)} className="hud-left" />
        <PlayerPlate view={view} seat={seat(1)} className="hud-right" />
        <PlayerPlate view={view} seat={self} className="hud-self" />
        <div className="hud-round">
          <strong>
            {windName(hand.roundWind)}
            {["一", "二", "三", "四"][hand.roundNumber - 1]}局
          </strong>
          <span>
            {hand.honba} 本场，供托 {hand.kyotakuPoints.toLocaleString()}
          </span>
          <span>
            余 <b>{hand.liveWallRemaining}</b> 张
          </span>
          <span className="hud-dora">
            <small>宝牌指示</small>
            {hand.doraIndicators.map((t) => (
              <Tile key={t} tile={t} small />
            ))}
          </span>
        </div>
        <LatestDiscard view={view} />
      </div>
      <RiverSummary view={view} />
    </section>
  );
}

/** Re-render only for a new view; the page's countdown ticks never reach the canvas. */
export default memo(
  Table3D,
  (a, b) =>
    a.view === b.view &&
    a.hand?.selected === b.hand?.selected &&
    a.hand?.dim === b.hand?.dim &&
    a.hand?.anchors === b.hand?.anchors,
);
