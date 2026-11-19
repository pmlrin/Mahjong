// Shared tile artwork (SVG viewBox 0 0 40 58). Each tile is described as a
// short list of primitive shapes; the DOM <Tile> renders them as SVG and the
// 3D face atlas paints them on a canvas, so both draw the same tile.
export const TILE_VIEWBOX = { width: 40, height: 58 } as const;
export const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
export const HONORS = ["東", "南", "西", "北", "白", "發", "中"];

/**
 * Inks resolve to the --tile-* tokens: "face" is the face background, and
 * "back" / "backEdge" / "backInk" are the back's ground, rules and emblem.
 */
export type Ink =
  | "red"
  | "green"
  | "blue"
  | "ink"
  | "face"
  | "back"
  | "backEdge"
  | "backInk";
export type Shape =
  | { t: "circle"; cx: number; cy: number; r: number; fill: Ink }
  | {
      t: "path";
      d: string;
      fill?: Ink;
      stroke?: Ink;
      width?: number;
      round?: boolean;
    }
  | {
      t: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      weight: number;
      fill: Ink;
    };

type Pt = [number, number];

// ---------- Dots (筒) ----------
// [x, y, radius, ink] per pip, in the traditional colourings.
const DOTS: Record<number, [number, number, number, Ink][]> = {
  2: [
    [20, 17, 8, "green"],
    [20, 41, 8, "blue"],
  ],
  3: [
    [11, 12, 6.4, "blue"],
    [20, 29, 6.4, "red"],
    [29, 46, 6.4, "green"],
  ],
  4: [
    [12, 17, 6.6, "blue"],
    [28, 17, 6.6, "green"],
    [12, 41, 6.6, "green"],
    [28, 41, 6.6, "blue"],
  ],
  5: [
    [11, 13, 5.9, "blue"],
    [29, 13, 5.9, "green"],
    [20, 29, 5.9, "red"],
    [11, 45, 5.9, "green"],
    [29, 45, 5.9, "blue"],
  ],
  6: [
    [12, 11, 5.6, "green"],
    [28, 11, 5.6, "green"],
    [12, 31, 5.6, "red"],
    [28, 31, 5.6, "red"],
    [12, 46, 5.6, "red"],
    [28, 46, 5.6, "red"],
  ],
  7: [
    [10, 8.5, 4.4, "green"],
    [20, 15, 4.4, "green"],
    [30, 21.5, 4.4, "green"],
    [13, 35, 5.3, "red"],
    [27, 35, 5.3, "red"],
    [13, 48, 5.3, "red"],
    [27, 48, 5.3, "red"],
  ],
  8: [
    [12.5, 9, 5, "blue"],
    [27.5, 9, 5, "blue"],
    [12.5, 22.3, 5, "blue"],
    [27.5, 22.3, 5, "blue"],
    [12.5, 35.7, 5, "blue"],
    [27.5, 35.7, 5, "blue"],
    [12.5, 49, 5, "blue"],
    [27.5, 49, 5, "blue"],
  ],
  9: [
    [9.6, 12, 4.6, "blue"],
    [20, 12, 4.6, "blue"],
    [30.4, 12, 4.6, "blue"],
    [9.6, 29, 4.6, "red"],
    [20, 29, 4.6, "red"],
    [30.4, 29, 4.6, "red"],
    [9.6, 46, 4.6, "green"],
    [20, 46, 4.6, "green"],
    [30.4, 46, 4.6, "green"],
  ],
};

/** A coin pip: solid rim, face gap, solid core, a pinhole of face. */
function pip(cx: number, cy: number, r: number, ink: Ink): Shape[] {
  return [
    { t: "circle", cx, cy, r, fill: ink },
    { t: "circle", cx, cy, r: r * 0.8, fill: "face" },
    { t: "circle", cx, cy, r: r * 0.6, fill: ink },
    { t: "circle", cx, cy, r: r * 0.2, fill: "face" },
  ];
}

function onePin(red: boolean): Shape[] {
  const cx = 20,
    cy = 29;
  const outer: Ink = red ? "red" : "green";
  const band: Ink = "red";
  const shapes: Shape[] = [
    { t: "circle", cx, cy, r: 15, fill: outer },
    { t: "circle", cx, cy, r: 13.6, fill: "face" },
    { t: "circle", cx, cy, r: 12.4, fill: band },
    { t: "circle", cx, cy, r: 9, fill: "face" },
  ];
  // A ring of beads on the red band.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    shapes.push({
      t: "circle",
      cx: cx + Math.cos(a) * 10.7,
      cy: cy + Math.sin(a) * 10.7,
      r: 0.75,
      fill: "face",
    });
  }
  // Eight petals around the core.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    shapes.push({
      t: "circle",
      cx: cx + Math.cos(a) * 5.6,
      cy: cy + Math.sin(a) * 5.6,
      r: 1.6,
      fill: red ? "red" : "blue",
    });
  }
  shapes.push(
    { t: "circle", cx, cy, r: 3.4, fill: outer },
    { t: "circle", cx, cy, r: 1.3, fill: "face" },
  );
  return shapes;
}

// ---------- Bamboo (索) ----------
const f = (n: number) => +n.toFixed(2);
const line = (a: Pt, b: Pt) => `M${f(a[0])},${f(a[1])}L${f(b[0])},${f(b[1])}`;

/** One bamboo stalk centred on (x, y), `len` long, tilted `deg` from upright. */
function stick(
  x: number,
  y: number,
  len: number,
  ink: Ink,
  deg = 0,
  w = 4,
  ground: Ink = "face",
): Shape[] {
  const a = (deg * Math.PI) / 180;
  const ux = Math.sin(a),
    uy = -Math.cos(a); // along the stalk
  const px = -uy,
    py = ux; // across it
  const at = (t: number, s = 0): Pt => [
    x + ux * t + px * s,
    y + uy * t + py * s,
  ];
  const half = len / 2 - w / 2;
  const node = (t: number, span: number, width: number, inkN: Ink): Shape => ({
    t: "path",
    d: line(at(t, -span), at(t, span)),
    stroke: inkN,
    width,
    round: true,
  });
  return [
    { t: "path", d: line(at(-half), at(half)), stroke: ink, width: w, round: true },
    // highlight down the stalk
    {
      t: "path",
      d: line(at(-half + 0.6, -w * 0.16), at(half - 0.6, -w * 0.16)),
      stroke: ground,
      width: 0.55,
      round: true,
    },
    node(0, w / 2 + 0.55, 1.5, ink),
    node(0, w / 2 - 0.2, 0.45, ground),
    node(-half - w / 2 + 0.7, w / 2 + 0.35, 1.3, ink),
    node(half + w / 2 - 0.7, w / 2 + 0.35, 1.3, ink),
  ];
}

const BAMBOO: Record<number, [number, number, number, Ink, number?][]> = {
  2: [
    [20, 16.5, 17, "green"],
    [20, 41.5, 17, "blue"],
  ],
  3: [
    [20, 16.5, 17, "blue"],
    [12, 41.5, 17, "green"],
    [28, 41.5, 17, "green"],
  ],
  4: [
    [12, 16.5, 17, "green"],
    [28, 16.5, 17, "blue"],
    [12, 41.5, 17, "blue"],
    [28, 41.5, 17, "green"],
  ],
  5: [
    [10, 16.5, 17, "green"],
    [30, 16.5, 17, "blue"],
    [20, 29, 17, "red"],
    [10, 41.5, 17, "blue"],
    [30, 41.5, 17, "green"],
  ],
  6: [
    [10, 16.5, 17, "green"],
    [20, 16.5, 17, "green"],
    [30, 16.5, 17, "green"],
    [10, 41.5, 17, "blue"],
    [20, 41.5, 17, "blue"],
    [30, 41.5, 17, "blue"],
  ],
  7: [
    [20, 10.5, 13, "red"],
    [10, 29, 13, "green"],
    [20, 29, 13, "green"],
    [30, 29, 13, "green"],
    [10, 47.5, 13, "blue"],
    [20, 47.5, 13, "blue"],
    [30, 47.5, 13, "blue"],
  ],
  8: [
    [6.5, 16.5, 17, "green"],
    [15.4, 16.5, 16.5, "green", 19],
    [24.6, 16.5, 16.5, "green", -19],
    [33.5, 16.5, 17, "green"],
    [6.5, 41.5, 17, "blue"],
    [15.4, 41.5, 16.5, "blue", -19],
    [24.6, 41.5, 16.5, "blue", 19],
    [33.5, 41.5, 17, "blue"],
  ],
  9: [
    [10, 10.5, 13, "green"],
    [20, 10.5, 13, "red"],
    [30, 10.5, 13, "blue"],
    [10, 29, 13, "green"],
    [20, 29, 13, "red"],
    [30, 29, 13, "blue"],
    [10, 47.5, 13, "green"],
    [20, 47.5, 13, "red"],
    [30, 47.5, 13, "blue"],
  ],
};

/** 1s: a single tall stalk with a pair of leaves either side. */
function oneSou(red: boolean): Shape[] {
  const stalk: Ink = red ? "red" : "green";
  const leaf: Ink = red ? "red" : "green";
  const leaves = (y: number, flip: number): Shape => ({
    t: "path",
    d: `M20,${y} Q${20 + flip * 9},${y - 9} ${20 + flip * 15},${y - 7} Q${20 + flip * 9},${y - 1.5} 20,${y} Z`,
    fill: leaf,
  });
  return [
    leaves(24, 1),
    leaves(24, -1),
    leaves(40, 1),
    leaves(40, -1),
    ...stick(20, 29, 46, stalk, 0, 5.2),
    { t: "circle", cx: 20, cy: 6.4, r: 2.4, fill: "red" },
    { t: "circle", cx: 20, cy: 6.4, r: 0.9, fill: "face" },
  ];
}

// ---------- Characters & honours ----------
function man(n: number, red: boolean): Shape[] {
  return [
    {
      t: "text",
      x: 20,
      y: 24.5,
      text: NUMERALS[n - 1],
      size: n === 1 ? 26 : 22,
      weight: 700,
      fill: red ? "red" : "ink",
    },
    { t: "text", x: 20, y: 51.5, text: "萬", size: 23, weight: 700, fill: "red" },
  ];
}

function rect(x: number, y: number, w: number, h: number, r: number) {
  return `M${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}V${y + r}Q${x},${y} ${x + r},${y}Z`;
}

function honor(k: number): Shape[] {
  if (k === 31)
    // 白: the classic blue double frame.
    return [
      { t: "path", d: rect(8.5, 11, 23, 36, 2.2), stroke: "blue", width: 2.2 },
      { t: "path", d: rect(12, 14.5, 16, 29, 1), stroke: "blue", width: 0.9 },
    ];
  const fill: Ink = k === 32 ? "green" : k === 33 ? "red" : "ink";
  return [
    { t: "text", x: 20, y: 40, text: HONORS[k - 27], size: 30, weight: 700, fill },
  ];
}

/** Shapes for one tile face. `k` is the tile kind 0–33. */
export function tileArt(k: number, red: boolean): Shape[] {
  const n = (k % 9) + 1,
    suit = Math.floor(k / 9);
  if (suit === 0) return man(n, red);
  if (suit === 1) {
    if (n === 1) return onePin(red);
    return DOTS[n].flatMap(([x, y, r, ink]) => pip(x, y, r, red ? "red" : ink));
  }
  if (suit === 2) {
    if (n === 1) return oneSou(red);
    return BAMBOO[n].flatMap(([x, y, len, ink, deg]) =>
      stick(x, y, len, red ? "red" : ink, deg),
    );
  }
  return honor(k);
}

/** Paint shapes on a canvas already scaled to the 40×58 viewBox. */
export function paintArt(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  inks: Record<Ink, string>,
  font: string,
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const s of shapes) {
    if (s.t === "circle") {
      ctx.fillStyle = inks[s.fill];
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.t === "path") {
      const p = new Path2D(s.d);
      if (s.fill) {
        ctx.fillStyle = inks[s.fill];
        ctx.fill(p);
      }
      if (s.stroke) {
        ctx.strokeStyle = inks[s.stroke];
        ctx.lineWidth = s.width ?? 1;
        ctx.lineCap = s.round ? "round" : "butt";
        ctx.lineJoin = "round";
        ctx.stroke(p);
      }
    } else {
      ctx.fillStyle = inks[s.fill];
      ctx.font = `${s.weight} ${s.size}px ${font}`;
      ctx.fillText(s.text, s.x, s.y);
    }
  }
}

// ---------- Back ----------
/** A small six-armed snowflake centred on (x, y), arms of length `r`. */
function snowflake(x: number, y: number, r: number): Shape {
  const arms = [0, 60, 120].map((deg) => {
    const a = (deg * Math.PI) / 180,
      dx = Math.cos(a) * r,
      dy = Math.sin(a) * r;
    return line([x - dx, y - dy], [x + dx, y + dy]);
  });
  return { t: "path", d: arms.join(""), stroke: "backEdge", width: 0.45, round: true };
}

/**
 * The tile back, after the house name 明烛: a lit candle in a ringed medallion
 * on a night field of scattered snow, inside a double frame. Drawn over the
 * --tile-back ground.
 */
export function backArt(): Shape[] {
  const snow: [number, number, number][] = [
    [12, 12, 1.7],
    [27.5, 10.5, 1.2],
    [20, 15.5, 0.9],
    [9.2, 22, 1.2],
    [31, 20.5, 1.6],
    [9.6, 36.5, 1.6],
    [30.6, 37.5, 1.2],
    [20, 43.2, 0.9],
    [12.8, 46.5, 1.2],
    [27.4, 47, 1.7],
  ];
  return [
    { t: "path", d: rect(3.2, 3.2, 33.6, 51.6, 3), stroke: "backEdge", width: 1.1 },
    { t: "path", d: rect(5.6, 5.6, 28.8, 46.8, 1.6), stroke: "backEdge", width: 0.45 },
    ...snow.map(([x, y, r]) => snowflake(x, y, r)),
    // medallion: a thin candle-gold ring and a cool inner rule
    { t: "circle", cx: 20, cy: 29, r: 10.4, fill: "backInk" },
    { t: "circle", cx: 20, cy: 29, r: 9.7, fill: "back" },
    { t: "circle", cx: 20, cy: 29, r: 8.8, fill: "backEdge" },
    { t: "circle", cx: 20, cy: 29, r: 8.45, fill: "back" },
    // the candle: holder, bone-white body, gold flame with a pale core
    { t: "path", d: rect(15.4, 36.2, 9.2, 1.5, 0.75), fill: "backInk" },
    { t: "path", d: rect(17.7, 29.6, 4.6, 6.8, 0.7), fill: "face" },
    {
      t: "path",
      d: "M20,19.6C23.3,23.2 23.9,26 22.5,27.8Q20,29.8 17.5,27.8C16.1,26 16.7,23.2 20,19.6Z",
      fill: "backInk",
    },
    {
      t: "path",
      d: "M20,23.4C21.4,25.1 21.6,26.6 20.9,27.5Q20,28.3 19.1,27.5C18.4,26.6 18.6,25.1 20,23.4Z",
      fill: "face",
    },
    // corner diamonds
    ...([
      [8.6, 8.6],
      [31.4, 8.6],
      [8.6, 49.4],
      [31.4, 49.4],
    ] as Pt[]).map(
      ([x, y]): Shape => ({
        t: "path",
        d: `M${x},${y - 1.6}L${x + 1.6},${y}L${x},${y + 1.6}L${x - 1.6},${y}Z`,
        fill: "backInk",
      }),
    ),
  ];
}
