// Shared tile artwork geometry (SVG viewBox 0 0 40 58), used by the DOM
// <Tile> and the 3D face atlas so both draw the same tile.
export const TILE_VIEWBOX = { width: 40, height: 58 } as const;
export const NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
export const HONORS = ["東", "南", "西", "北", "白", "發", "中"];
export const PIP_POSITIONS: Record<number, [number, number][]> = {
  1: [[20, 29]],
  2: [
    [20, 18],
    [20, 40],
  ],
  3: [
    [12, 15],
    [20, 29],
    [28, 43],
  ],
  4: [
    [12, 18],
    [28, 18],
    [12, 40],
    [28, 40],
  ],
  5: [
    [12, 15],
    [28, 15],
    [20, 29],
    [12, 43],
    [28, 43],
  ],
  6: [
    [12, 14],
    [28, 14],
    [12, 29],
    [28, 29],
    [12, 44],
    [28, 44],
  ],
  7: [
    [12, 13],
    [20, 13],
    [28, 13],
    [12, 29],
    [28, 29],
    [12, 44],
    [28, 44],
  ],
  8: [
    [12, 11],
    [28, 11],
    [12, 23],
    [28, 23],
    [12, 35],
    [28, 35],
    [12, 47],
    [28, 47],
  ],
  9: [
    [10, 12],
    [20, 12],
    [30, 12],
    [10, 29],
    [20, 29],
    [30, 29],
    [10, 46],
    [20, 46],
    [30, 46],
  ],
};
/** Which ink a circle pip uses: red, green, blue in turn; all red on aka tiles. */
export function pipInk(index: number, red: boolean): "red" | "green" | "blue" {
  if (red) return "red";
  return (["red", "green", "blue"] as const)[index % 3];
}
export function bambooPath(x: number, y: number) {
  return `M${x},${y - 4} l0,8 M${x - 2},${y - 3} l4,0 M${x - 2},${y + 3} l4,0`;
}
export function honorInk(kind: number): "green" | "red" | "ink" {
  return kind === 32 ? "green" : kind === 33 ? "red" : "ink";
}
