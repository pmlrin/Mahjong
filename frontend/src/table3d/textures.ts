// Canvas-drawn textures: the tile face atlas and the centre plate.
// Colours come from tokens.css so the 3D table matches the flat one.
import { CanvasTexture, Color, SRGBColorSpace } from "three";
import { kind, isRed, type MatchView } from "../../../shared/types";
import {
  HONORS,
  NUMERALS,
  PIP_POSITIONS,
  TILE_VIEWBOX,
  bambooPath,
  honorInk,
  pipInk,
} from "../tile-glyphs";

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
/** A plain bone-face cell (no glyph) and a white cell for vertex-coloured parts. */
export const FACE_CELL = 37;
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
  const ink = {
    red: palette["--tile-red"],
    green: palette["--tile-green"],
    blue: palette["--tile-blue"],
    ink: palette["--tile-ink"],
  };
  for (let cell = 0; cell < 37; cell++) {
    const tile = representative(cell);
    const k = kind(tile),
      n = (k % 9) + 1,
      suit = Math.floor(k / 9),
      red = isRed(tile);
    ctx.save();
    ctx.translate(
      (cell % columns) * cellWidth,
      Math.floor(cell / columns) * cellHeight,
    );
    ctx.scale(cellWidth / TILE_VIEWBOX.width, cellHeight / TILE_VIEWBOX.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (suit === 0) {
      ctx.fillStyle = red ? ink.red : ink.ink;
      ctx.font = `700 24px ${palette.displayFont}`;
      ctx.fillText(NUMERALS[n - 1], 20, 27);
      ctx.fillStyle = ink.red;
      ctx.font = `18px ${palette.displayFont}`;
      ctx.fillText("萬", 20, 49);
    } else if (suit === 1) {
      PIP_POSITIONS[n].forEach(([x, y], i) => {
        const c = ink[pipInk(i, red)];
        ctx.strokeStyle = c;
        ctx.fillStyle = c;
        ctx.lineWidth = n === 1 ? 2.8 : 1.8;
        ctx.beginPath();
        ctx.arc(x, y, n === 1 ? 11 : 4.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, n === 1 ? 5 : 1.3, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (suit === 2) {
      ctx.strokeStyle = red ? ink.red : ink.green;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      for (const [x, y] of PIP_POSITIONS[n])
        ctx.stroke(new Path2D(bambooPath(x, y)));
    } else {
      ctx.fillStyle = ink[honorInk(k)];
      ctx.font = `700 29px ${palette.displayFont}`;
      ctx.fillText(HONORS[k - 27], 20, 39);
    }
    if (red) {
      ctx.fillStyle = ink.red;
      ctx.beginPath();
      ctx.arc(35, 5, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
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
  ctx.strokeStyle = palette["--color-felt-rule"];
  ctx.lineWidth = 3;
  ctx.strokeRect(14, 14, s - 28, s - 28);
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
