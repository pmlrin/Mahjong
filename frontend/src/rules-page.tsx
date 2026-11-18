import React, { useState } from "react";
import {
  YAKU_CATALOG,
  exampleHand,
  type YakuExample,
} from "../../shared/yaku-catalog";
import { tileName } from "../../shared/types";
import { Tile } from "./Tile";
export function YakuHand({
  example,
}: {
  example: Pick<YakuExample, "groups" | "winning" | "open">;
}) {
  const hand = exampleHand(example);
  return (
    <div
      className="yaku-example"
      aria-label={"示例牌：" + hand.groups.flat().map(tileName).join("、")}
    >
      <div className="yaku-example-row">
        {hand.groups.map((group, index) => (
          <div
            key={index}
            className={
              "yaku-tile-group " +
              (example.open?.includes(index) ? "exposed" : "")
            }
          >
            <div>
              {group.map((t) => (
                <Tile key={t} tile={t} small mark={t === hand.winning} />
              ))}
            </div>
            {(example.open?.includes(index) || group.length === 4) && (
              <small>
                {example.open?.includes(index)
                  ? "副露"
                  : group.length === 4
                    ? "暗杠"
                    : ""}
              </small>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
export function RulesPage({ onBack }: { onBack: () => void }) {
  const [showYaku, setShowYaku] = useState(false),
    [search, setSearch] = useState("");
  const visible = YAKU_CATALOG.filter((y) =>
    (y.name + y.id + y.description)
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <main className="rules-page">
      <button className="text-button" onClick={onBack}>
        返回
      </button>
      <h1>几分钟，认识这一桌</h1>
      <p className="page-sub">落座之前</p>
      <p className="rules-lead">
        四人立直麻将：把手牌凑成和牌形，且至少有一个役，就能和牌。
      </p>
      <section className="rule-intro" aria-label="简明玩法说明">
        <article>
          <h2>摸一张，打一张</h2>
          <p>
            每人 13 张，轮到自己摸 1 张、打 1 张。通常把手牌组成四组面子和一对雀头：面子是同花色连续三张，或三张相同牌。
          </p>
        </article>
        <article>
          <h2>拿别人的牌来组面子</h2>
          <p>
            只能吃上家打出的牌；任意一家打出的牌都可能碰、杠。吃碰后直接打牌，杠后补摸岭上牌。鸣牌会影响可成立的役。
          </p>
        </article>
        <article>
          <h2>牌形完整，还要有役</h2>
          <p>
            自己摸到叫自摸，别人打出叫荣和。除四面子一雀头，也有七对子、国士无双。只有宝牌、没有役，不能和牌。
          </p>
        </article>
        <article>
          <h2>门清听牌后可以立直</h2>
          <p>
            没有吃碰明杠、只差一张就能和时，可付 1,000 点立直。立直后通常摸切，不能再随意换牌；立直本身是一役。
          </p>
        </article>
        <article>
          <h2>自己的弃牌也要看</h2>
          <p>
            自己打过当前任一种和牌牌，就不能荣和，但仍可自摸。放过合法荣和会有同巡振听；立直后见逃持续本局。
          </p>
        </article>
        <article>
          <h2>从 25,000 点开始</h2>
          <p>
            可选东风战或半庄战，以 30,000 点为目标。庄家和牌或荒牌听牌会连庄；不足目标时可能延长。点数跌破 0 即终局，恰好 0 点不算。
          </p>
        </article>
      </section>
      <section className="basic-hand">
        <h2>最常见的和牌形</h2>
        <YakuHand
          example={{
            groups: ["m234", "p345", "s456", "p678", "s22"],
            winning: "m4",
          }}
        />
        <p>四组面子加一对雀头。黄色标记的是和牌的那张；这副牌还满足断幺九、平和。</p>
      </section>
      <button
        className="yaku-toggle primary"
        aria-expanded={showYaku}
        aria-controls="all-yaku"
        onClick={() => setShowYaku((v) => !v)}
      >
        {showYaku
          ? "收起役种图鉴"
          : "全部 " + YAKU_CATALOG.length + " 种役，各配一副示例牌"}
        <span>{showYaku ? "−" : "＋"}</span>
      </button>
      {showYaku && (
        <section
          id="all-yaku"
          className="yaku-catalog"
          aria-label="全部役种图鉴"
        >
          <div className="yaku-catalog-heading">
            <div>
              <h2>全部役种，一副牌看懂</h2>
              <p>
                示例牌可能同时成立别的役，标出的番数只算这一役。黄底的一组是副露；杠虽四张，仍算一组面子。
              </p>
            </div>
            <label>
              找一找
              <input
                type="search"
                placeholder="役名或条件，如：立直、门清"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <p className="yaku-result-count" aria-live="polite">
            共 {visible.length} 种
            {search && (
              <button className="text-button" onClick={() => setSearch("")}>
                显示全部
              </button>
            )}
          </p>
          <div className="yaku-card-grid">
            {visible.map((y) => (
              <article className="yaku-card" id={"yaku-" + y.id} key={y.id}>
                <header>
                  <h3>{y.name}</h3>
                  <span>{y.yakuman ? "一倍役满" : y.closedHan + "番"}</span>
                </header>
                <div className="yaku-conditions">
                  <span>
                    {y.openHan === null
                      ? "门清限定"
                      : y.yakuman
                        ? "允许副露"
                        : y.openHan === y.closedHan
                          ? "门清／副露均" + y.closedHan + "番"
                          : "门清" +
                            y.closedHan +
                            "番，副露" +
                            y.openHan +
                            "番"}
                  </span>
                  <span>
                    示例：{y.open?.length ? "副露" : "门清"}，{" "}
                    {y.context?.tsumo ? "自摸" : "荣和"}
                  </span>
                </div>
                <p>{y.description}</p>
                <YakuHand example={y} />
              </article>
            ))}
          </div>
          {!visible.length && (
            <p>没找到。换个说法，或清空再看。</p>
          )}
          <article className="yaku-special">
            <h3>特殊结算：流局满贯</h3>
            <p>
              不是固定和牌牌形。荒牌时，本人全部弃牌都是幺九牌，且没有被吃碰杠取走，才可能成立；本桌允许本人副露。下面是符合牌种条件的示例牌河，还须满足整局条件。
            </p>
            <div className="yaku-example">
              <div className="yaku-example-row">
                {exampleHand({ groups: ["m19", "p19", "s19", "z1234567"] })
                  .groups.flat()
                  .map((t) => (
                    <Tile key={t} tile={t} small />
                  ))}
              </div>
            </div>
          </article>
          <div className="yaku-footnote">
            <h3>宝牌不是役</h3>
            <p>
              表宝牌、里宝牌、赤宝牌只加番，不能让无役的牌和牌。里宝牌只给立直和牌者；天然役满不再加普通役和宝牌。累计13番是计分上限，并非另一个独立役。
            </p>
            <p>
              本桌不采用人和或地方役。国士十三面、四暗刻单骑、大四喜、纯正九莲均按一倍役满；不同天然役满可以复合。
            </p>
          </div>
        </section>
      )}
      <div className="rules-note">
        <p>
          出牌限时 15 秒，吃碰杠与荣和的应答 8 秒。掉线不会让牌局停下，期间由中级 AI 托管，重连后即可接着打。AI 牌友分初级、中级、高级、大师级四档，开桌时由房主选定。
        </p>
        <p>一场打完，同桌的人都能看完整牌谱，保存 30 天。</p>
      </div>
    </main>
  );
}
