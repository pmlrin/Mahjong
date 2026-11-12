import type {
  CSSProperties,
  MouseEventHandler,
  PointerEventHandler,
} from "react";
import { kind, isRed, tileName } from "../../shared/types";
import { NUMERALS, PIP_POSITIONS } from "./tile-glyphs";
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
    n = (k % 9) + 1,
    suit = Math.floor(k / 9),
    red = tile !== undefined && isRed(tile);
  const number = NUMERALS[n - 1];
  const positions = PIP_POSITIONS;
  const body = back ? (
    <span className="tile-back-mark">竹</span>
  ) : (
    <>
      <svg viewBox="0 0 40 58" aria-hidden="true">
        {suit === 0 ? (
          <>
            <text
              x="20"
              y="27"
              className="tile-number"
              fill={red ? "var(--tile-red)" : "var(--tile-ink)"}
            >
              {number}
            </text>
            <text x="20" y="49" className="tile-suit" fill="var(--tile-red)">
              萬
            </text>
          </>
        ) : suit === 1 ? (
          positions[n].map(([x, y], i) => (
            <g key={i}>
              <circle
                cx={x}
                cy={y}
                r={n === 1 ? 11 : 4.6}
                fill="none"
                stroke={
                  red
                    ? "var(--tile-red)"
                    : i % 3 === 0
                      ? "var(--tile-red)"
                      : i % 3 === 1
                        ? "var(--tile-green)"
                        : "var(--tile-blue)"
                }
                strokeWidth={n === 1 ? 2.8 : 1.8}
              />
              <circle
                cx={x}
                cy={y}
                r={n === 1 ? 5 : 1.3}
                fill={
                  red
                    ? "var(--tile-red)"
                    : i % 3 === 0
                      ? "var(--tile-red)"
                      : i % 3 === 1
                        ? "var(--tile-green)"
                        : "var(--tile-blue)"
                }
              />
            </g>
          ))
        ) : suit === 2 ? (
          positions[n].map(([x, y], i) => (
            <g
              key={i}
              stroke={red ? "var(--tile-red)" : "var(--tile-green)"}
              strokeWidth="2.6"
              strokeLinecap="round"
            >
              <path
                d={`M${x},${y - 4} l0,8 M${x - 2},${y - 3} l4,0 M${x - 2},${y + 3} l4,0`}
              />
            </g>
          ))
        ) : (
          <text
            x="20"
            y="39"
            className="tile-honor"
            fill={k === 32 ? "var(--tile-green)" : k === 33 ? "var(--tile-red)" : "var(--tile-ink)"}
          >
            {["東", "南", "西", "北", "白", "發", "中"][k - 27]}
          </text>
        )}
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
