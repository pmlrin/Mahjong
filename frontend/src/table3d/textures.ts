// Canvas-drawn textures: the tile face atlas and the centre plate.
// Colours come from tokens.css so the 3D table matches the flat one.
import { CanvasTexture, Color, SRGBColorSpace } from "three";
import { kind, isRed, type MatchView } from "../../../shared/types";
import { TILE_VIEWBOX, backArt, paintArt, tileArt } from "../tile-glyphs";

const TOKENS = [
  "--color-felt",
  "--color-felt-deep",
  "--color-felt-raised",
  "--color-felt-rule",
  "--color-felt-ink",
  "--color-felt-ink-2",
  "--color-signal",
  "--color-riichi",
  "--tile-face",
  "--tile-edge",
  "--tile-side",
  "--tile-back",
  "--tile-back-edge",
  "--tile-ink",
  "--tile-red",
  "--tile-green",
  "--tile-blue",
  "--tile-back-ink",
  "--table-rail",
  "--table-rail-deep",
  "--table-rail-light",
  "--table-trim",
] as const;
export type Token = (typeof TOKENS)[number];
export type Palette = Record<Token, string> & {
  displayFont: string;
  bodyFont: string;
};

/** Resolve tokens (oklch) to sRGB hex by painting one pixel per colour. */
export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const out = {} as Palette;
  for (const token of TOKENS) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = style.getPropertyValue(token).trim() || "#888";
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    out[token] =
      "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  }
  out.displayFont = style.getPropertyValue("--font-display").trim() || "serif";
  out.bodyFont = style.getPropertyValue("--font-body").trim() || "sans-serif";
  return out;
}
export const srgb = (hex: string) => new Color().setStyle(hex, SRGBColorSpace);

export const ATLAS = { columns: 8, rows: 5, cellWidth: 240, cellHeight: 348 };
/** A plain bone-face cell (no glyph), the patterned back, and a white cell for vertex-coloured parts. */
export const FACE_CELL = 37;
export const BACK_CELL = 38;
export const WHITE_CELL = 39;
/** Atlas cell: kinds 0–33, then red 5m / 5p / 5s at 34–36. */
export function atlasCell(tile: number) {
  if (isRed(tile)) return 34 + Math.floor(kind(tile) / 9);
  return kind(tile);
}
const representative = (cell: number) =>
  cell < 34
    ? cell * 4 + (cell % 9 === 4 && cell < 27 ? 1 : 0)
    : [16, 52, 88][cell - 34];

export function createFaceAtlas(palette: Palette) {
  const { columns, rows, cellWidth, cellHeight } = ATLAS;
  const canvas = document.createElement("canvas");
  canvas.width = columns * cellWidth;
  canvas.height = rows * cellHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = palette["--tile-face"];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const inks = {
    red: palette["--tile-red"],
    green: palette["--tile-green"],
    blue: palette["--tile-blue"],
    ink: palette["--tile-ink"],
    face: palette["--tile-face"],
    back: palette["--tile-back"],
    backEdge: palette["--tile-back-edge"],
    backInk: palette["--tile-back-ink"],
  };
  for (let cell = 0; cell < 37; cell++) {
    const tile = representative(cell);
    const red = isRed(tile);
    ctx.save();
    ctx.translate(
      (cell % columns) * cellWidth,
      Math.floor(cell / columns) * cellHeight,
    );
    ctx.scale(cellWidth / TILE_VIEWBOX.width, cellHeight / TILE_VIEWBOX.height);
    paintArt(ctx, tileArt(kind(tile), red), inks, palette.displayFont);
    if (red) {
      ctx.fillStyle = inks.red;
      ctx.beginPath();
      ctx.arc(36, 4, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.save();
  ctx.translate(
    (BACK_CELL % columns) * cellWidth,
    Math.floor(BACK_CELL / columns) * cellHeight,
  );
  ctx.fillStyle = inks.back;
  ctx.fillRect(0, 0, cellWidth, cellHeight);
  ctx.scale(cellWidth / TILE_VIEWBOX.width, cellHeight / TILE_VIEWBOX.height);
  paintArt(ctx, backArt(), inks, palette.displayFont);
  ctx.restore();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(
    (WHITE_CELL % columns) * cellWidth,
    Math.floor(WHITE_CELL / columns) * cellHeight,
    cellWidth,
    cellHeight,
  );
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const WIND: Record<string, string> = {
  EAST: "东",
  SOUTH: "南",
  WEST: "西",
  NORTH: "北",
};
export function centerInfo(view: MatchView) {
  const h = view.hand;
  return {
    round: `${WIND[h.roundWind] ?? h.roundWind}${["一", "二", "三", "四"][h.roundNumber - 1] ?? h.roundNumber}局`,
    honba: h.honba,
    kyotaku: h.kyotakuPoints,
    remaining: h.liveWallRemaining,
    winds: [0, 1, 2, 3].map(
      (rel) => WIND[h.seats[(view.viewerSeat + rel) % 4].seatWind] ?? "",
    ),
    active:
      h.activeSeat === null ? null : (h.activeSeat - view.viewerSeat + 4) % 4,
  };
}
export type CenterInfo = ReturnType<typeof centerInfo>;

export function drawCenterPlate(
  canvas: HTMLCanvasElement,
  info: CenterInfo,
  palette: Palette,
) {
  const s = 512;
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = palette["--color-felt-deep"];
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = palette["--table-trim"];
  ctx.lineWidth = 4;
  ctx.strokeRect(14, 14, s - 28, s - 28);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(24, 24, s - 48, s - 48);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = palette["--color-felt-ink"];
  ctx.font = `600 78px ${palette.displayFont}`;
  ctx.fillText(info.round, s / 2, s / 2 - 46);
  ctx.fillStyle = palette["--color-felt-ink-2"];
  ctx.font = `30px ${palette.bodyFont}`;
  ctx.fillText(`${info.honba} 本场　供托 ${info.kyotaku}`, s / 2, s / 2 + 22);
  ctx.font = `30px ${palette.bodyFont}`;
  ctx.fillText(`余 ${info.remaining} 张`, s / 2, s / 2 + 66);
  info.winds.forEach((wind, rel) => {
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.rotate([0, -Math.PI / 2, Math.PI, Math.PI / 2][rel]);
    const active = info.active === rel;
    if (active) {
      ctx.fillStyle = palette["--color-signal"];
      ctx.fillRect(-46, s / 2 - 84, 92, 6);
    }
    ctx.fillStyle = active
      ? palette["--color-signal"]
      : palette["--color-felt-ink"];
    ctx.font = `600 54px ${palette.displayFont}`;
    ctx.fillText(wind, 0, s / 2 - 46);
    ctx.restore();
  });
}

/** A small deterministic PRNG, so the felt and grain look the same every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/**
 * The felt top: lit brighter in the middle, a fine nap of light and dark
 * flecks, and a double brass line a little in from the rail.
 */
export function createFeltTexture(palette: Palette) {
  const s = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  const glow = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.72);
  glow.addColorStop(0, palette["--color-felt-raised"]);
  glow.addColorStop(0.55, palette["--color-felt"]);
  glow.addColorStop(1, palette["--color-felt-deep"]);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, s, s);
  const image = ctx.getImageData(0, 0, s, s);
  const random = rng(7);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * 14;
    image.data[i] += n;
    image.data[i + 1] += n;
    image.data[i + 2] += n;
  }
  ctx.putImageData(image, 0, 0);
  ctx.strokeStyle = palette["--table-trim"];
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 4;
  ctx.strokeRect(s * 0.025, s * 0.025, s * 0.95, s * 0.95);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(s * 0.036, s * 0.036, s * 0.928, s * 0.928);
  ctx.globalAlpha = 1;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Walnut for the rail: long grain running along the texture's v axis. */
export function createWoodTexture(palette: Palette) {
  const w = 256,
    h = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = palette["--table-rail"];
  ctx.fillRect(0, 0, w, h);
  const random = rng(11);
  for (let i = 0; i < 90; i++) {
    const x = random() * w,
      wave = 2 + random() * 6,
      period = 120 + random() * 260,
      phase = random() * Math.PI * 2;
    ctx.strokeStyle =
      random() < 0.6 ? palette["--table-rail-deep"] : palette["--table-rail-light"];
    ctx.globalAlpha = 0.12 + random() * 0.28;
    ctx.lineWidth = 0.6 + random() * 2.2;
    ctx.beginPath();
    for (let y = 0; y <= h; y += 8) {
      const xx = x + Math.sin(y / period + phase) * wave;
      if (y === 0) ctx.moveTo(xx, y);
      else ctx.lineTo(xx, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
