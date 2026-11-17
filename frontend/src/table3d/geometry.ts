import { BufferGeometry, Color, Float32BufferAttribute } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TILE } from "./layout";
import { ATLAS, BACK_CELL, FACE_CELL } from "./textures";

/** Share of the thickness taken by the coloured back layer. */
const BACK_SHARE = 0.38;
/** The glyph area on the face, matching the atlas cell's 40:58 artwork. */
const GLYPH_WIDTH = 0.84,
  GLYPH_HEIGHT = GLYPH_WIDTH * (58 / 40);

function paint(geometry: BufferGeometry, color: Color) {
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    colors.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

function cellRect(cell: number) {
  const { columns, rows } = ATLAS;
  const u0 = (cell % columns) / columns;
  const v0 = 1 - (Math.floor(cell / columns) + 1) / rows;
  return { u0, v0, du: 1 / columns, dv: 1 / rows };
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Point every vertex at an atlas texel: the flat top face at `art` when
 * there is one, everything else at the centre of the `plain` cell. With
 * `plain` null, every vertex maps into `art`: off the face the coordinates
 * clamp to the cell's margin, so bevels and sides take its ground colour.
 */
function mapUv(
  geometry: BufferGeometry,
  plain: number | null,
  art: number | null,
  faceY: number,
) {
  const pos = geometry.getAttribute("position"),
    normal = geometry.getAttribute("normal"),
    uv = geometry.getAttribute("uv");
  const flat = plain === null ? null : cellRect(plain),
    cell = art === null ? null : cellRect(art);
  for (let i = 0; i < pos.count; i++) {
    const onFace =
      !!cell &&
      (!flat ||
        (normal.getY(i) > 0.999 && Math.abs(pos.getY(i) - faceY) < 1e-4));
    if (onFace) {
      // Linear in x and z, so the art is exact across the flat face; the
      // bevel beyond it clamps to the cell's margin. Art top is −z.
      const u = clamp01((pos.getX(i) + GLYPH_WIDTH / 2) / GLYPH_WIDTH);
      const v = clamp01((GLYPH_HEIGHT / 2 - pos.getZ(i)) / GLYPH_HEIGHT);
      uv.setXY(i, cell.u0 + u * cell.du, cell.v0 + v * cell.dv);
    } else if (flat) {
      uv.setXY(i, flat.u0 + flat.du / 2, flat.v0 + flat.dv / 2);
    }
  }
  uv.needsUpdate = true;
}

/**
 * One tile as a single mesh: bone face layer (with its glyph, if any) over an
 * apricot back layer whose outer face shows the patterned back. Drawn with
 * the atlas as map and vertex colours, so a tile costs one draw call instead
 * of a body plus a decal.
 */
export function createTile(glyph: number | null) {
  const { width, height, thickness, radius } = TILE;
  const faceDepth = thickness * (1 - BACK_SHARE),
    backDepth = thickness * BACK_SHARE;
  const top = new RoundedBoxGeometry(width, faceDepth, height, 2, radius);
  top.translate(0, thickness / 2 - faceDepth / 2, 0);
  const bottom = new RoundedBoxGeometry(width, backDepth, height, 2, radius);
  bottom.translate(0, -thickness / 2 + backDepth / 2, 0);
  // Both layers take their colour from the atlas (white vertex colour): the
  // face from its glyph cell, the back from the patterned back cell, whose
  // ground colour also covers the back layer's sides.
  mapUv(top, FACE_CELL, glyph, thickness / 2);
  mapUv(bottom, null, BACK_CELL, 0);
  const merged = mergeGeometries([
    paint(top, new Color(1, 1, 1)),
    paint(bottom, new Color(1, 1, 1)),
  ])!;
  top.dispose();
  bottom.dispose();
  return merged;
}
