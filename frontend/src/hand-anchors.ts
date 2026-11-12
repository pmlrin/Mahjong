// Screen rectangles of the 3D own-hand tiles, published by the 3D table and
// read by the transparent hand buttons laid over it. Coordinates are CSS
// pixels relative to the top-left of the 3D table.
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Anchors = ReadonlyMap<number, Anchor>;
export interface AnchorStore {
  get(): Anchors;
  set(next: Anchors): void;
  subscribe(listener: () => void): () => void;
}

const EMPTY: Anchors = new Map();
const same = (a: Anchors, b: Anchors) =>
  a.size === b.size &&
  [...a].every(([tile, r]) => {
    const o = b.get(tile);
    return (
      !!o &&
      Math.abs(o.x - r.x) < 0.5 &&
      Math.abs(o.y - r.y) < 0.5 &&
      Math.abs(o.width - r.width) < 0.5 &&
      Math.abs(o.height - r.height) < 0.5
    );
  });

export function createAnchorStore(): AnchorStore {
  let current = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next) {
      if (same(current, next)) return;
      current = next.size ? next : EMPTY;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Top edge of the hand, for placing the action row just above it. */
export function handTop(anchors: Anchors) {
  let top = Infinity;
  anchors.forEach((a) => (top = Math.min(top, a.y)));
  return Number.isFinite(top) ? top : null;
}
