// Players' arms on the 3D table. Each other player's figure sits past their
// table edge, out of shot; when that player discards, draws, calls a discard
// or lays down a riichi stick, its right arm reaches in, pinches the tile (or
// stick), carries it along its flight, lets go and pulls back. When their hand
// is shown at the end, both hands push it down.
// Driven by code (two-bone IK on the VRM's normalized humanoid bones and two
// finger poses), not by animation files.
//
// Figure: Seed-san by VirtualCast, Inc., VRM Public License 1.0
// (https://vrm.dev/licenses/1.0/); see THIRD_PARTY_NOTICES.md.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Group,
  SkinnedMesh,
} from "three";
import type { MToonMaterial, VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import seedSanUrl from "../assets/models/seed-san.vrm?url";
import { seatQuaternion } from "./layout";
import { ARM, DISCARD_FLIGHT } from "./timing";

/**
 * Where the figure sits and how big it is, in table units (a tile is about
 * 2.6 cm wide, so a person is drawn a little larger than life to reach the
 * river). Tunable from the console in development (`__arms`).
 */
export const FIGURE = {
  /** Metres of the model to table units. */
  scale: 44,
  /** Shoulder height above the felt. */
  shoulderHeight: 12,
  /** Body from the table centre, along the player's side. */
  distance: 23,
  /** Forward lean of the upper body, radians. */
  lean: 0.3,
  /** Wrist held this far back from the tile (toward the body) and above it. */
  gripBack: 2.4,
  gripUp: 1.7,
  /** The hands are drawn smaller than the model's, which read as huge here. */
  handScale: 0.75,
  /** Fingers point down toward the tile at this angle, radians. */
  gripPitch: 0.75,
  /** Height of the arc while reaching in and pulling back. */
  arc: 2.5,
  /** The body may shift this far toward a distant tile; farther ones get no arm. */
  stretch: 6,
};

const now = () => performance.now() / 1000;
/** Materials of the figure that are drawn: the clothes and the body. */
const SHOWN = ["huku_bake", "body_nm", "body_bake"];
/** Development only: hold a reach at this many seconds in, for inspection. */
let frozen: number | null = null;

const meshes = (vrm: VRM) => {
  const out: Mesh[] = [];
  vrm.scene.traverse((o) => (o as Mesh).isMesh && out.push(o as Mesh));
  return out;
};

let loading: Promise<VRM[]> | null = null;
/**
 * One figure per other seat (relative seats 1–3). The file is fetched once
 * and parsed three times for three skeletons; the copies then share the first
 * one's meshes and materials, so the GPU holds one set.
 */
function loadFigures() {
  loading ??= (async () => {
    // The loaders come in their own chunk, so the table never waits on them.
    const [data, { GLTFLoader }, { VRMLoaderPlugin, VRMUtils }] =
      await Promise.all([
        fetch(seedSanUrl).then((r) => r.arrayBuffer()),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("@pixiv/three-vrm"),
      ]);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const figures: VRM[] = [];
    for (let i = 0; i < 3; i++) {
      const gltf = await loader.parseAsync(data, "");
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      if (i === 0) bareHands(vrm);
      else {
        const first = meshes(figures[0]);
        meshes(vrm).forEach((m, k) => {
          m.geometry.dispose();
          m.geometry = first[k].geometry;
          m.material = first[k].material;
        });
      }
      for (const side of ["left", "right"] as const)
        vrm.humanoid
          .getRawBoneNode(`${side}Hand`)
          ?.scale.setScalar(FIGURE.handScale);
      vrm.scene.traverse((o) => {
        // Skinned bounds follow the bind pose, not the reaching arm.
        o.frustumCulled = false;
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        // Only the body and clothes (which carry the arms) are drawn: the
        // head, hair and backpack would only peek over the far edge.
        const names = [mesh.material]
          .flat()
          .map((m) => m.name.replace(/ \(Outline\)$/, ""));
        if (
          /^(head|hair)/.test(mesh.name) ||
          !names.every((n) => SHOWN.includes(n))
        )
          mesh.visible = false;
      });
      figures.push(vrm);
    }
    // The side players' bodies would lean into the edges of the shot (the
    // across player's sits behind the far edge): draw only their right arms.
    for (const i of [0, 2]) {
      const left: SkinnedMesh[] = [];
      for (const m of meshes(figures[i]).filter((m) => m.visible)) {
        const mesh = m as SkinnedMesh;
        // The left arm only shows to push a hand down.
        const arm = new SkinnedMesh(armOnly(mesh, LEFT_ARM), mesh.material);
        arm.bind(mesh.skeleton, mesh.bindMatrix);
        arm.position.copy(mesh.position);
        arm.quaternion.copy(mesh.quaternion);
        arm.scale.copy(mesh.scale);
        arm.frustumCulled = false;
        arm.castShadow = true;
        arm.visible = false;
        mesh.parent!.add(arm);
        left.push(arm);
        mesh.geometry = armOnly(mesh, RIGHT_ARM);
      }
      figures[i].scene.userData.leftArm = left;
    }
    // The across player sits behind the table: nothing below it is seen.
    for (const m of meshes(figures[1]).filter((m) => m.visible))
      m.geometry = armOnly(m as SkinnedMesh, ABOVE_TABLE);
    return figures;
  })();
  return loading;
}

/**
 * The figures of relative seats 1–3 once loaded (index 0 is seat 1), or null
 * while loading, on failure, or when off.
 */
export function useFigures(enabled: boolean) {
  const [figures, setFigures] = useState<VRM[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadFigures().then(
      (v) => live && setFigures(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? figures : null;
}

/** A tile to take: its key, where it starts, and how long it travels. */
export interface Reach {
  key: string;
  from: Vector3;
  /** Seconds (performance clock) when the arm starts to move. */
  start: number;
  /** Seconds the tile travels in the hand once picked up. */
  carry: number;
  /**
   * Instead of taking a tile, push a revealed hand down with both hands:
   * where each hand pushes along the row (the tiles fall during `carry`).
   */
  push?: { left: Vector3; right: Vector3 };
}

/** A seated figure's shoulder and arm length, measured when it sits down. */
const seated = new WeakMap<VRM, { shoulder: Vector3; arm: number }>();
const NO_LEAN = new Vector3();
/**
 * How far the figure must lean (a horizontal shift of the whole body) for its
 * hand to take a tile at `at`, or null if the tile is too far to reach.
 */
export function leanFor(vrm: VRM, at: Vector3) {
  const m = seated.get(vrm);
  if (!m) return null;
  const flat = at.clone().sub(m.shoulder).setY(0);
  const wrist = at
    .clone()
    .addScaledVector(flat.clone().normalize(), -FIGURE.gripBack)
    .addScaledVector(UP, FIGURE.gripUp);
  const drop = m.shoulder.y - wrist.y;
  const comfortable = Math.sqrt(Math.max(0, (m.arm * 0.95) ** 2 - drop ** 2));
  const across = wrist.sub(m.shoulder).setY(0);
  const excess = across.length() - comfortable;
  if (excess <= 0) return NO_LEAN;
  if (excess > FIGURE.stretch) return null;
  return across.normalize().multiplyScalar(excess);
}

const FINGERS = ["Index", "Middle", "Ring", "Little"] as const;
const JOINTS = ["Proximal", "Intermediate", "Distal"] as const;
/** Finger curl per joint for an open hand and a pinch, radians. */
const CURL = {
  open: { Index: 0.1, Middle: 0.12, Ring: 0.15, Little: 0.18 },
  pinch: { Index: 0.42, Middle: 0.55, Ring: 0.95, Little: 1.05 },
};
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);
const ease = (u: number) => u * u * (3 - 2 * u);
/** Wrist heights pushing a hand down: over the standing tiles, then flat. */
const PUSH = { high: 2.6, low: 1.5 };

/** A seated player's figure, taking that player's tiles with its right hand. */
export function Figure({
  vrm,
  relative,
  reach,
}: {
  vrm: VRM;
  relative: number;
  reach: Reach | null;
}) {
  const root = useRef<Group>(null);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const current = useRef<
    | (Reach & {
        tile?: Object3D;
        lean?: Vector3;
        startWrist?: Vector3;
        /** How far a side figure sits back at the start and the end. */
        awayIn?: number;
        awayOut?: number;
      })
    | null
  >(null);
  const rest = useRef({ right: new Vector3(), left: new Vector3() });
  const seat = useRef(new Vector3());
  /** Where the wrist was last drawn, so a new reach can start from there. */
  const wristAt = useRef<Vector3 | null>(null);
  const lengths = useRef({ upper: 1, lower: 1 });
  const bone = (name: VRMHumanBoneName) =>
    vrm.humanoid.getNormalizedBoneNode(name)!;

  const begin = (r: Reach) => {
    // Still busy with the last one (a discard right after a draw): go on
    // from where the hand is instead of from rest.
    current.current = {
      ...r,
      startWrist: current.current ? wristAt.current?.clone() : undefined,
    };
    invalidate();
  };
  useEffect(() => {
    if (reach) begin(reach);
  }, [reach]);

  // Sit down: place the body past the edge, lean in, arms hanging below the
  // felt. Then measure the arm and where the wrist rests.
  const sitDown = () => {
    const g = root.current!;
    const seatAt = seat.current;
    const turn = seatQuaternion(relative);
    // The model faces +z; a seat at +z faces the centre (-z).
    g.quaternion
      .copy(turn)
      .multiply(new Quaternion().setFromAxisAngle(UP, Math.PI));
    vrm.scene.scale.setScalar(FIGURE.scale);
    vrm.scene.position.set(0, 0, 0);
    restPose(vrm, 0);
    vrm.scene.updateMatrixWorld(true);
    const shoulder = new Vector3();
    bone("rightUpperArm").getWorldPosition(shoulder);
    vrm.scene.position.y = FIGURE.shoulderHeight - shoulder.y;
    g.position.copy(new Vector3(0, 0, FIGURE.distance).applyQuaternion(turn));
    seatAt.copy(g.position);
    g.updateMatrixWorld(true);
    const a = new Vector3(),
      b = new Vector3(),
      c = new Vector3();
    bone("rightUpperArm").getWorldPosition(a);
    bone("rightLowerArm").getWorldPosition(b);
    bone("rightHand").getWorldPosition(c);
    bone("leftHand").getWorldPosition(rest.current.left);
    lengths.current = { upper: a.distanceTo(b), lower: b.distanceTo(c) };
    seated.set(vrm, {
      shoulder: a.clone(),
      arm: lengths.current.upper + lengths.current.lower,
    });
    rest.current.right.copy(c);
    vrm.update(0);
    // Out of sight until it reaches in.
    vrm.scene.visible = false;
    invalidate();
  };
  useLayoutEffect(sitDown, [vrm, relative]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Console hooks for tuning: change FIGURE then sitDown(); reach for any
    // tile by its key, optionally held at a moment of the reach.
    const w = window as { __arms?: Record<string | number, unknown> };
    w.__arms ??= {
      FIGURE,
      release() {
        frozen = null;
        invalidate();
      },
    };
    w.__arms[relative] = {
      sitDown,
      /** The reach under way, if any. */
      get current() {
        return current.current;
      },
      /** Replay any reach, optionally held at a moment of it. */
      play(r: Reach, at?: number) {
        begin({ ...r, start: now() });
        frozen = at ?? null;
      },
      reach(key: string, at?: number) {
        const tile = scene.getObjectByName(key);
        if (!tile) return false;
        begin({
          key,
          from: tile.getWorldPosition(new Vector3()),
          start: now(),
          carry: DISCARD_FLIGHT.duration,
        });
        frozen = at ?? null;
        return true;
      },
    };
  });

  useFrame((state, delta) => {
    const r = current.current;
    if (!r) return;
    const t = frozen ?? now() - r.start;
    const flight = r.carry;
    const total = ARM.reach + flight + ARM.retract;
    const g = root.current!;
    // A push waits for the hand result's pause.
    if (t < 0) {
      state.invalidate();
      return;
    }
    const leftArm = (vrm.scene.userData.leftArm ?? []) as Object3D[];
    if (t >= total) {
      current.current = null;
      wristAt.current = null;
      vrm.scene.visible = false;
      for (const m of leftArm) m.visible = false;
      g.position.copy(seat.current);
      restPose(vrm, 0);
      vrm.update(delta);
      state.invalidate();
      return;
    }
    vrm.scene.visible = true;
    for (const m of leftArm) m.visible = !!r.push;
    r.tile ??= scene.getObjectByName(r.key);
    r.lean ??= r.push ? NO_LEAN : (leanFor(vrm, r.from) ?? NO_LEAN);
    const tile = r.tile?.getWorldPosition(new Vector3()) ?? r.from;
    const grip = (at: Vector3) => {
      const toward = at.clone().sub(seated.get(vrm)!.shoulder).setY(0);
      return at
        .clone()
        .addScaledVector(toward.normalize(), -FIGURE.gripBack)
        .addScaledVector(UP, FIGURE.gripUp);
    };
    const out = seat.current.clone().normalize();
    // What each hand does: where it arrives, where it is while the tile
    // travels (u from 0 to 1), where it lets go, and what the fingers aim at.
    type Hand = {
      side: Side;
      arrive: Vector3;
      carry: (u: number) => Vector3;
      leave: Vector3;
      aimAt: Vector3;
      home: Vector3;
    };
    let hands: Hand[];
    if (r.push) {
      // Behind the standing tiles' tops, then forward and down as they fall.
      const forward = out.clone().negate();
      const before = (at: Vector3) =>
        at.clone().addScaledVector(forward, -1.7).setY(PUSH.high);
      const after = (at: Vector3) =>
        at.clone().addScaledVector(forward, 0.5).setY(PUSH.low);
      hands = (["right", "left"] as const).map((side) => {
        const at = r.push![side];
        return {
          side,
          arrive: before(at),
          carry: (u) => before(at).lerp(after(at), ease(u)),
          leave: after(at),
          aimAt: at.clone().addScaledVector(forward, 6),
          home: rest.current[side],
        };
      });
    } else {
      hands = [
        {
          side: "right",
          arrive: grip(r.from),
          carry: () => grip(tile),
          leave: grip(tile),
          aimAt: tile,
          home: rest.current.right,
        },
      ];
    }
    // A side player's arms slide in from out of shot along their seat and
    // back out the same way (past the table's sides nothing would hide a
    // hand hanging below the felt). The across player's arms rise from
    // behind the far edge instead.
    const side = relative % 2 === 1;
    const away = (points: Vector3[]) => {
      if (!side) return 0;
      const hidden = (p: Vector3) => {
        const n = p.clone().project(state.camera);
        return n.z > 1 || Math.abs(n.x) > 1.08 || Math.abs(n.y) > 1.08;
      };
      for (let k = 0; k < 60; k += 2)
        if (points.every((p) => hidden(p.clone().addScaledVector(out, k))))
          return k;
      return 60;
    };
    r.awayIn ??= r.startWrist
      ? 0
      : away([r.from, ...hands.map((h) => h.arrive)]);
    // Lean toward a far tile while reaching, and back while bringing it home.
    let leaning: number, withdrawn: number;
    if (t < ARM.reach) {
      leaning = ease(t / ARM.reach);
      withdrawn = r.awayIn * (1 - leaning);
    } else if (t < ARM.reach + flight) {
      leaning = 1 - ease((t - ARM.reach) / flight);
      withdrawn = 0;
    } else {
      leaning = 0;
      r.awayOut ??= away([tile, ...hands.map((h) => h.leave)]);
      withdrawn = r.awayOut * ease((t - ARM.reach - flight) / ARM.retract);
    }
    const offset = r.lean
      .clone()
      .multiplyScalar(leaning)
      .addScaledVector(out, withdrawn);
    g.position.copy(seat.current).add(offset);
    g.updateMatrixWorld(true);
    const lift = (u: number) =>
      Math.sin(Math.PI * u) * FIGURE.arc * (side ? 0.4 : 1);
    const pinch = !r.push;
    let closed: number;
    let wrists: Vector3[];
    if (t < ARM.reach) {
      const u = t / ARM.reach;
      // From out of shot (side), from rest (across), or from wherever the
      // last reach left the hand.
      wrists = hands.map((h) => {
        const from =
          (h.side === "right" && r.startWrist) ||
          (side
            ? h.arrive.clone().addScaledVector(out, withdrawn)
            : h.home.clone().add(offset));
        const w = from.clone().lerp(h.arrive, ease(u));
        w.y += lift(u);
        return w;
      });
      closed = pinch ? Math.max(0, (u - 0.6) / 0.4) : 0;
    } else if (t < ARM.reach + flight) {
      wrists = hands.map((h) => h.carry((t - ARM.reach) / flight));
      closed = pinch ? 1 : 0;
    } else {
      const u = (t - ARM.reach - flight) / ARM.retract;
      wrists = hands.map((h) => {
        const w = side
          ? h.leave.clone().addScaledVector(out, withdrawn)
          : h.leave.clone().lerp(h.home.clone().add(offset), ease(u));
        w.y += lift(u);
        return w;
      });
      closed = pinch ? Math.max(0, 1 - u / 0.3) : 0;
    }
    restPose(vrm, closed);
    hands.forEach((h, i) =>
      reachTo(vrm, h.side, wrists[i], h.aimAt, lengths.current),
    );
    wristAt.current = wrists[0];
    vrm.update(delta);
    if (frozen === null) state.invalidate();
  });

  return (
    <group ref={root}>
      <primitive object={vrm.scene} />
    </group>
  );
}

type Side = "left" | "right";
/** +1 for the right side, -1 for the left: the model is mirror-symmetric. */
const SIGN = { right: 1, left: -1 } as const;

/** Lean in, arms hanging down past the felt, hands relaxed. */
function restPose(vrm: VRM, closed: number) {
  const b = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n);
  b("spine")?.quaternion.setFromAxisAngle(X, FIGURE.lean * 0.5);
  b("chest")?.quaternion.setFromAxisAngle(X, FIGURE.lean * 0.5);
  // T-pose arms point sideways; swing them down (about z, opposite ways).
  b("rightUpperArm")?.quaternion.setFromAxisAngle(Z, 1.25);
  // The idle left arm hangs straight down, out of sight below the far edge.
  b("leftUpperArm")?.quaternion.setFromAxisAngle(Z, -1.5);
  for (const side of ["right", "left"] as const) {
    b(`${side}LowerArm`)?.quaternion.identity();
    b(`${side}Hand`)?.quaternion.identity();
    fingers(vrm, side, closed);
  }
}

/** Curl a hand's fingers between open (0) and a pinch (1). */
function fingers(vrm: VRM, side: Side, closed: number) {
  const sign = SIGN[side];
  for (const f of FINGERS) {
    const angle = CURL.open[f] + (CURL.pinch[f] - CURL.open[f]) * closed;
    for (const j of JOINTS)
      vrm.humanoid
        .getNormalizedBoneNode(`${side}${f}${j}` as VRMHumanBoneName)
        // Right hand: fingers point -x, the palm faces -y; +z curls them in
        // (the left hand mirrors it).
        ?.quaternion.setFromAxisAngle(Z, sign * angle);
  }
  // The thumb comes across under the index finger.
  const thumb = new Vector3(0, -sign, 0);
  vrm.humanoid
    .getNormalizedBoneNode(`${side}ThumbProximal`)
    ?.quaternion.setFromAxisAngle(thumb, 0.15 + 0.45 * closed);
  vrm.humanoid
    .getNormalizedBoneNode(`${side}ThumbDistal`)
    ?.quaternion.setFromAxisAngle(thumb, 0.1 + 0.4 * closed);
}

const qa = new Quaternion(),
  qb = new Quaternion(),
  va = new Vector3(),
  vb = new Vector3();
/** Point `node` so its child lies along `direction` (world), keeping its parent. */
function aim(node: Object3D, child: Object3D, direction: Vector3) {
  node.quaternion.identity();
  node.updateMatrixWorld(true);
  node.getWorldQuaternion(qa);
  // The child's offset is in the node's own (identity-rest) frame.
  va.copy(child.position).normalize().applyQuaternion(qa);
  qb.setFromUnitVectors(va, vb.copy(direction).normalize()).multiply(qa);
  node.quaternion.copy(qa.invert().multiply(qb));
  node.updateMatrixWorld(true);
}

/**
 * Two-bone IK for one arm: shoulder fixed, wrist at `wrist`, the elbow
 * bending outward and down; the hand palm down with fingers toward `toward`.
 * Call after `restPose`.
 */
function reachTo(
  vrm: VRM,
  side: Side,
  wrist: Vector3,
  toward: Vector3,
  len: { upper: number; lower: number },
) {
  const b = (n: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(n)!;
  const upper = b(`${side}UpperArm`),
    lower = b(`${side}LowerArm`),
    hand = b(`${side}Hand`);
  vrm.scene.updateMatrixWorld(true);
  const s = upper.getWorldPosition(new Vector3());
  const along = wrist.clone().sub(s);
  const reach = Math.min(
    Math.max(along.length(), Math.abs(len.upper - len.lower) + 0.01),
    len.upper + len.lower - 0.01,
  );
  const u = along.normalize();
  const cos =
    (len.upper ** 2 + reach ** 2 - len.lower ** 2) / (2 * len.upper * reach);
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
  // The figure's own right (or left), in the world: the elbow swings out.
  const outward = new Vector3(-SIGN[side], 0, 0).applyQuaternion(
    vrm.scene.getWorldQuaternion(new Quaternion()),
  );
  const pole = outward.multiplyScalar(0.7).add(new Vector3(0, -1, 0));
  const v = pole.sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
  const elbow = s
    .clone()
    .addScaledVector(u, len.upper * cos)
    .addScaledVector(v, len.upper * sin);
  const end = s.clone().addScaledVector(u, reach);
  aim(upper, lower, elbow.clone().sub(s));
  aim(lower, hand, end.clone().sub(elbow));
  // Palm down, fingers toward the target and tipped down onto it.
  const flat = toward.clone().sub(end).setY(0).normalize();
  const fingersDir = flat
    .multiplyScalar(Math.cos(FIGURE.gripPitch))
    .addScaledVector(UP, -Math.sin(FIGURE.gripPitch))
    .normalize();
  const back = UP.clone()
    .sub(fingersDir.clone().multiplyScalar(UP.dot(fingersDir)))
    .normalize();
  // Bone axes: the fingers along -x (right hand) or +x (left), +y the back.
  const xAxis = fingersDir.clone().multiplyScalar(-SIGN[side]);
  const want = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(xAxis, back, xAxis.clone().cross(back)),
  );
  const parent = lower.getWorldQuaternion(new Quaternion());
  hand.quaternion.copy(parent.invert().multiply(want));
}

/** Bones of the black glove: palm, finger roots and thumb. */
const GLOVE = /^(hand|palm0\d|f_(index|middle|ring|pinky)01|thumb0[12])[LR]$/;
/**
 * How far up the forearm from the wrist joint is bare too, in metres. The
 * left sleeve has no cuff (her armgear, hidden here, covered that wrist), so
 * bare skin reaches further there to hide the suit's ragged end.
 */
const CUFF = { L: 0.09, R: 0.06 };
/** Texture slots that would read the suit's UVs from another texture. */
const TEXTURES = [
  "map",
  "normalMap",
  "emissiveMap",
  "shadeMultiplyTexture",
  "shadingShiftTexture",
  "matcapTexture",
  "rimMultiplyTexture",
  "outlineWidthMultiplyTexture",
  "uvAnimationMaskTexture",
] as const;

/** Bones of each arm, shoulder joint to fingertips. */
const RIGHT_ARM = /^(upper_arm|forearm|hand|palm|f_|thumb)\w*R$/;
const LEFT_ARM = /^(upper_arm|forearm|hand|palm|f_|thumb)\w*L$/;

/**
 * The part of a mesh that follows the matching bones (an arm, say), as a new
 * geometry that shares the mesh's vertex data (and so its GPU buffers).
 */
function armOnly(mesh: SkinnedMesh, bones: RegExp) {
  const geometry = mesh.geometry,
    index = geometry.index;
  const arm = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes))
    arm.setAttribute(name, attribute);
  arm.morphAttributes = geometry.morphAttributes;
  arm.morphTargetsRelative = geometry.morphTargetsRelative;
  if (!index) return arm;
  const follows = new Map<number, boolean>();
  const onArm = (v: number) => {
    let yes = follows.get(v);
    if (yes === undefined) follows.set(v, (yes = bones.test(boneOf(mesh, v))));
    return yes;
  };
  const kept: number[] = [];
  const groups = Array.isArray(mesh.material)
    ? geometry.groups
    : [{ start: 0, count: index.count, materialIndex: 0 }];
  for (const group of groups) {
    const start = kept.length;
    for (let t = group.start; t < group.start + group.count; t += 3) {
      const corners = [0, 1, 2].map((k) => index.getX(t + k));
      if (corners.filter(onArm).length >= 2) kept.push(...corners);
    }
    if (Array.isArray(mesh.material))
      arm.addGroup(start, kept.length - start, group.materialIndex);
  }
  arm.setIndex(kept);
  return arm;
}

/** The bone a vertex follows most. */
function boneOf(mesh: SkinnedMesh, i: number) {
  const index = mesh.geometry.attributes.skinIndex,
    weight = mesh.geometry.attributes.skinWeight;
  let best = 0,
    most = -1;
  for (let k = 0; k < 4; k++) {
    const w = weight.getComponent(i, k);
    if (w > most) {
      most = w;
      best = index.getComponent(i, k);
    }
  }
  return mesh.skeleton.bones[best]?.name ?? "";
}

/**
 * Seed-san wears black fingerless gloves, which read as a dark blob at table
 * distance. Draw the gloved part of the hands in her skin colour instead: the
 * suit's triangles that follow the hand, finger-root and thumb bones get a
 * plain copy of the skin material, coloured from her own fingertips.
 */
function bareHands(vrm: VRM) {
  let suit: SkinnedMesh | undefined, skin: SkinnedMesh | undefined;
  vrm.scene.traverse((o) => {
    const m = o as SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const name = [m.material].flat()[0].name;
    if (name === "body_nm") suit = m;
    else if (name === "body_bake" && !m.name.startsWith("head")) skin = m;
  });
  if (!suit || !skin || !suit.geometry.index) return;
  const skinMaterial = [skin.material].flat()[0] as MToonMaterial;
  // The right fingertips' own colour, read from her skin texture.
  const tone = new Color(0xf6dfd3);
  const image = skinMaterial.map?.image as CanvasImageSource | undefined;
  const uv = skin.geometry.attributes.uv;
  if (image && uv) {
    try {
      const { width, height } = image as { width: number; height: number };
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < uv.count; i++) {
        // The left fingertips are part of her blue armgear.
        if (boneOf(skin, i) !== "f_middle03R") continue;
        const [pr, pg, pb] = ctx.getImageData(
          Math.min(width - 1, Math.floor(uv.getX(i) * width)),
          Math.min(height - 1, Math.floor(uv.getY(i) * height)),
          1,
          1,
        ).data;
        r += pr;
        g += pg;
        b += pb;
        n++;
      }
      if (n) tone.setRGB(r / n / 255, g / n / 255, b / n / 255, SRGBColorSpace);
    } catch {}
  }
  const bare = skinMaterial.clone();
  for (const slot of TEXTURES)
    if (slot in bare) (bare as unknown as Record<string, unknown>)[slot] = null;
  bare.color.copy(tone);
  bare.needsUpdate = true;
  // The glove, and the bit of forearm just above the wrist that shows in the
  // cuff's opening (the rest of the forearm can show past a bent elbow).
  const wrist = (name: string) => {
    const i = suit!.skeleton.bones.findIndex((b) => b.name === name);
    return new Vector3().setFromMatrixPosition(
      suit!.skeleton.boneInverses[i].clone().invert(),
    );
  };
  const wrists = { L: wrist("handL"), R: wrist("handR") };
  const position = suit.geometry.attributes.position;
  const at = new Vector3();
  const glove = (v: number) => GLOVE.test(boneOf(suit!, v));
  const cuff = (v: number) => {
    const side = /^forearmtwist([LR])$/.exec(boneOf(suit!, v))?.[1];
    if (side !== "L" && side !== "R") return false;
    at.fromBufferAttribute(position, v).applyMatrix4(suit!.bindMatrix);
    return wrists[side].distanceTo(at) < CUFF[side];
  };
  // Whole triangles only above the wrist, so the sleeve ends in a straight
  // line rather than a saw edge.
  splitOff(
    suit,
    (corners) =>
      mostly(glove)(corners) || corners.every((v) => glove(v) || cuff(v)),
    bare,
  );
  // The left fingertips are blue armgear in her skin texture.
  splitOff(
    skin,
    mostly((v) => LEFT_HAND.test(boneOf(skin!, v))),
    bare,
  );
}

/** Bones above a seated figure's lap: not the legs and feet. */
const ABOVE_TABLE = /^(?!thigh|shin|heel|foot|toe)/;

/** The left hand's bones (its bare skin is painted as blue armgear). */
const LEFT_HAND = /^(hand|palm0\d|f_\w+|thumb0\d)L$/;

/** Whether most of a triangle's corners pass `test`. */
const mostly = (test: (vertex: number) => boolean) => (corners: number[]) =>
  corners.filter(test).length >= 2;

/**
 * Draw the triangles of `mesh` that pass `test` (given their three corners)
 * with `material` instead: they go last in the index, as a third group; the
 * outline pass (the mesh's second material) still covers every triangle.
 */
function splitOff(
  mesh: SkinnedMesh,
  test: (corners: number[]) => boolean,
  material: MToonMaterial,
) {
  const geometry = mesh.geometry,
    index = geometry.index;
  if (!index) return;
  const keep: number[] = [],
    moved: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const corners = [0, 1, 2].map((k) => index.getX(t + k));
    (test(corners) ? moved : keep).push(...corners);
  }
  if (!moved.length) return;
  const Indices = index.array.constructor as Uint32ArrayConstructor;
  geometry.setIndex(new BufferAttribute(new Indices([...keep, ...moved]), 1));
  geometry.clearGroups();
  geometry.addGroup(0, keep.length, 0);
  geometry.addGroup(keep.length, moved.length, 2);
  geometry.addGroup(0, index.count, 1);
  const materials = [mesh.material].flat();
  mesh.material = [materials[0], materials[1], material];
}
