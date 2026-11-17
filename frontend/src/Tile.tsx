import type {
  CSSProperties,
  MouseEventHandler,
  PointerEventHandler,
} from "react";
import { kind, isRed, tileName } from "../../shared/types";
import { backArt, tileArt, type Ink, type Shape } from "./tile-glyphs";
const INK: Record<Ink, string> = {
  red: "var(--tile-red)",
  green: "var(--tile-green)",
  blue: "var(--tile-blue)",
  ink: "var(--tile-ink)",
  face: "var(--tile-face)",
  back: "var(--tile-back)",
  backEdge: "var(--tile-back-edge)",
  backInk: "var(--tile-back-ink)",
};
function shapes(list: Shape[]) {
  return list.map((sh, i) =>
    sh.t === "circle" ? (
      <circle key={i} cx={sh.cx} cy={sh.cy} r={sh.r} fill={INK[sh.fill]} />
    ) : sh.t === "path" ? (
      <path
        key={i}
        d={sh.d}
        fill={sh.fill ? INK[sh.fill] : "none"}
        stroke={sh.stroke ? INK[sh.stroke] : undefined}
        strokeWidth={sh.width}
        strokeLinecap={sh.round ? "round" : undefined}
        strokeLinejoin="round"
      />
    ) : (
      <text
        key={i}
        x={sh.x}
        y={sh.y}
        className="tile-glyph"
        fontSize={sh.size}
        fontWeight={sh.weight}
        fill={INK[sh.fill]}
      >
        {sh.text}
      </text>
    ),
  );
}
export function Tile({
  tile,
  back = false,
  small = false,
  selected = false,
  disabled = false,
  onClick,
  onPointerDown,
  mark = false,
  style,
}: {
  tile?: number;
  back?: boolean;
  small?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  mark?: boolean;
  /** Placement over the 3D table, for the transparent hand buttons. */
  style?: CSSProperties;
}) {
  const k = tile === undefined ? 0 : kind(tile),
    red = tile !== undefined && isRed(tile);
  const body = back ? (
    <svg className="tile-back-art" viewBox="0 0 40 58" aria-hidden="true">
      {shapes(backArt())}
    </svg>
  ) : (
    <>
      <svg viewBox="0 0 40 58" aria-hidden="true">
        {shapes(tileArt(k, red))}
      </svg>
      {red && <span className="aka-mark">赤</span>}
      {mark && <span className="draw-mark" />}
    </>
  );
  const cls = `tile ${back ? "back" : ""} ${small ? "small" : ""} ${selected ? "selected" : ""} ${mark ? "drawn" : ""}`;
  return onClick ? (
    <button
      className={cls}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      data-hand-tile={onPointerDown ? tile : undefined}
      aria-label={tileName(tile!)}
      aria-pressed={selected}
      style={style}
    >
      {body}
    </button>
  ) : (
    <span
      className={cls}
      role="img"
      aria-label={back ? "牌背" : tileName(tile!)}
    >
      {body}
    </span>
  );
}
