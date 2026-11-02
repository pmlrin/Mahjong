import type { MouseEventHandler, PointerEventHandler } from "react";
import { kind, isRed, tileName } from "../../shared/types";
export function Tile({
  tile,
  back = false,
  small = false,
  selected = false,
  disabled = false,
  onClick,
  onPointerDown,
  mark = false,
}: {
  tile?: number;
  back?: boolean;
  small?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  mark?: boolean;
}) {
  const k = tile === undefined ? 0 : kind(tile),
    n = (k % 9) + 1,
    suit = Math.floor(k / 9),
    red = tile !== undefined && isRed(tile);
  const number = ["一", "二", "三", "四", "五", "六", "七", "八", "九"][n - 1];
  const positions: Record<number, [number, number][]> = {
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
              fill={red ? "#b4493e" : "#243831"}
            >
              {number}
            </text>
            <text x="20" y="49" className="tile-suit" fill="#b4493e">
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
                    ? "#bc5140"
                    : i % 3 === 0
                      ? "#b54f44"
                      : i % 3 === 1
                        ? "#1b6355"
                        : "#33475f"
                }
                strokeWidth={n === 1 ? 2.8 : 1.8}
              />
              <circle
                cx={x}
                cy={y}
                r={n === 1 ? 5 : 1.3}
                fill={
                  red
                    ? "#bc5140"
                    : i % 3 === 0
                      ? "#b54f44"
                      : i % 3 === 1
                        ? "#1b6355"
                        : "#33475f"
                }
              />
            </g>
          ))
        ) : suit === 2 ? (
          positions[n].map(([x, y], i) => (
            <g
              key={i}
              stroke={red ? "#b4493e" : "#226c55"}
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
            fill={k === 32 ? "#226c55" : k === 33 ? "#b4493e" : "#2d413a"}
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
