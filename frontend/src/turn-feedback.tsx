import { Tile } from "./Tile";
import { tileName, type MatchView, type Option } from "../../shared/types";
import {
  sourceFor,
  responseTarget,
  callTiles,
  type TileSource,
} from "../../shared/game-feedback";
const names: Record<string, string> = {
  CHI: "吃",
  PON: "碰",
  DAIMINKAN: "明杠",
};
export function LatestDiscard({ view }: { view: MatchView }) {
  const last = view.hand.lastDiscard;
  const kan = responseTarget(view);
  const source =
    kan?.source === "KAN"
      ? kan
      : last
        ? sourceFor(view, last.seat, last.tile, "DISCARD", last.discardId)
        : null;
  if (!source) return null;
  const called = source.source === "DISCARD" && last?.claimedByMeldId;
  return (
    <aside
      className="latest-discard-display"
      aria-live="polite"
      aria-atomic="true"
      data-discard-id={source.discardId ?? undefined}
    >
      <Tile tile={source.tile} />
      <div>
        <small>{source.source === "KAN" ? "正在声明杠" : "最新出牌"}</small>
        <strong>
          {source.displayName}
          <span>（{source.relation}）</span>
        </strong>
        <p>
          {source.source === "KAN" ? "声明杠：" : "打出："}
          <b>{tileName(source.tile)}</b>
          {called && <em> · 已被鸣走</em>}
        </p>
      </div>
    </aside>
  );
}
export function ResponseSource({
  source,
  prompt,
}: {
  source: TileSource;
  prompt: string;
}) {
  return (
    <div className="response-source">
      <Tile tile={source.tile} small />
      <span>
        <strong>
          {source.displayName}（{source.relation}）
          {source.source === "KAN" ? "声明杠" : "打出"}了{" "}
          {tileName(source.tile)}
        </strong>
        <small>{prompt}</small>
      </span>
    </div>
  );
}
export function CallChoices({
  type,
  target,
  options,
  disabled,
  onConfirm,
}: {
  type: string;
  target: TileSource;
  options: Option[];
  disabled: boolean;
  onConfirm: (option: Option) => void;
}) {
  return (
    <>
      <div className="call-target">
        <Tile tile={target.tile} />
        <p>
          <strong>
            {target.displayName}（{target.relation}）打出{" "}
            {tileName(target.tile)}
          </strong>
          <span>选择你要用的手牌，确认后等待服务器裁决。</span>
        </p>
      </div>
      <div className="call-options explained-call-options">
        {options.map((o) => (
          <button
            className="secondary call-choice"
            key={o.optionId}
            disabled={disabled}
            onClick={() => onConfirm(o)}
            aria-label={`用${o.consumedTiles!.map(tileName).join("、")}${names[type]}${target.displayName}的${tileName(target.tile)}`}
          >
            <div className="call-ingredients">
              <span className="ingredient">
                <small>你的手牌</small>
                <span>
                  {o.consumedTiles!.map((t) => (
                    <Tile key={t} tile={t} small />
                  ))}
                </span>
              </span>
              <span className="call-plus">＋</span>
              <span className="ingredient from-discard">
                <small>{target.displayName}打出</small>
                <Tile tile={target.tile} small />
              </span>
              <span className="call-arrow">→</span>
              <span className="ingredient completed-call">
                <small>
                  组成
                  {type === "CHI" ? "顺子" : type === "PON" ? "刻子" : "杠子"}
                </small>
                <span>
                  {callTiles(o, target.tile).map((t) => (
                    <span
                      className={t === target.tile ? "target-tile" : ""}
                      key={t}
                    >
                      <Tile tile={t} small />
                    </span>
                  ))}
                </span>
              </span>
            </div>
            <span className="confirm-call">确认{names[type]} →</span>
          </button>
        ))}
      </div>
    </>
  );
}
