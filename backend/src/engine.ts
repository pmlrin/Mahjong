import { randomInt, randomUUID } from "node:crypto";
import {
  SEATS,
  WINDS,
  RULESET,
  kind,
  type Seat,
  type Quad,
  type Member,
  type Option,
  type Meld,
  type Discard,
  type Decision,
  type PendingKan,
  type PublicWindow,
  type MatchView,
  type Result,
  type MatchResult,
  type Win,
  type Transfer,
  type NextHand,
  type MatchFormat,
  type MatchMode,
  PROTOCOL,
  BOT_POLICY_VERSION,
} from "../../shared/types.ts";
import { closed, waits, score, terminal, strictRiichiKan } from "./rules.ts";
export const uid = () => randomUUID();
export const quad = <T>(f: (s: Seat) => T): Quad<T> => SEATS.map(f) as Quad<T>;
export interface PlayerState extends Member {
  seat: Seat;
  points: number;
  desiredControl: "HUMAN" | "AI";
  tiles: number[];
  drawn: number | null;
  drawSource: string | null;
  melds: Meld[];
  discards: Discard[];
  riichi: "NONE" | "DECLARED" | "ESTABLISHED";
  riichiKind: "SINGLE" | "DOUBLE" | null;
  ippatsu: boolean;
  temporary: boolean;
  afterRiichiPass: boolean;
  restricted: number[];
  draws: number;
  pao: Record<string, Seat>;
}
export interface InternalDecision extends Decision {
  choice: Option | null;
  blocked: boolean;
}
export interface GameState {
  matchId: string;
  roomId: string;
  format: MatchFormat;
  mode: MatchMode;
  protocolVersion: string;
  status: "RUNNING" | "FINISHED" | "ABORTED";
  serverEpoch: number;
  handId: string;
  handIndex: number;
  round: number;
  roundNumber: number;
  dealer: Seat;
  honba: number;
  kyotaku: number;
  players: Quad<PlayerState>;
  phase: string;
  activeSeat: Seat;
  wall: number[];
  dead: number[];
  replacements: number[];
  shuffled: number[];
  kanCount: number;
  interrupted: boolean;
  fourKans: boolean;
  pendingKan: PendingKan | null;
  window: PublicWindow | null;
  decisions: Quad<InternalDecision | null>;
  lastResult: Result | null;
  matchResult: MatchResult | null;
  resultDisplayUntil: number | null;
  events: GameEvent[];
  streamIds: Quad<string>;
  viewSeq: Quad<number>;
  viewHashes: Quad<string>;
  createdAt: number;
  finishedAt: number | null;
  rngState: number | null;
}
export interface GameEvent {
  eventId: string;
  type: string;
  handId: string;
  at: number;
  data: unknown;
}
export function log(g: GameState, type: string, data: unknown) {
  g.events.push({
    eventId: uid(),
    type,
    handId: g.handId,
    at: Date.now(),
    data,
  });
}
export function shuffled(random: (n: number) => number = randomInt): number[] {
  const a = Array.from({ length: 136 }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function createGame(
  roomId: string,
  members: Quad<Member>,
  wall?: number[],
  now = Date.now(),
  seed: number | null = null,
  format: MatchFormat = "EAST_ONLY",
): GameState {
  const g: GameState = {
    matchId: uid(),
    roomId,
    format,
    mode:
      members.filter((m) => m.participantKind === "HUMAN").length === 1
        ? "AI_PRACTICE"
        : "FRIENDS",
    protocolVersion: PROTOCOL,
    status: "RUNNING",
    serverEpoch: 1,
    handId: "",
    handIndex: 0,
    round: 0,
    roundNumber: 1,
    dealer: 0,
    honba: 0,
    kyotaku: 0,
    players: quad((s) => ({
      ...members[s],
      botPolicyVersion:
        members[s].participantKind === "BOT"
          ? (members[s].botPolicyVersion ?? BOT_POLICY_VERSION)
          : null,
      seat: s,
      points: 25000,
      desiredControl: members[s].participantKind === "BOT" ? "AI" : "HUMAN",
      tiles: [],
      drawn: null,
      drawSource: null,
      melds: [],
      discards: [],
      riichi: "NONE",
      riichiKind: null,
      ippatsu: false,
      temporary: false,
      afterRiichiPass: false,
      restricted: [],
      draws: 0,
      pao: {},
    })),
    phase: "DEALING",
    activeSeat: 0,
    wall: [],
    dead: [],
    replacements: [],
    shuffled: [],
    kanCount: 0,
    interrupted: false,
    fourKans: false,
    pendingKan: null,
    window: null,
    decisions: quad(() => null),
    lastResult: null,
    matchResult: null,
    resultDisplayUntil: null,
    events: [],
    streamIds: quad(() => uid()),
    viewSeq: quad(() => 0),
    viewHashes: quad(() => ""),
    createdAt: now,
    finishedAt: null,
    rngState: seed,
  };
  deal(g, wall, now);
  return g;
}
export function deal(g: GameState, preset?: number[], now = Date.now()) {
  g.handId = uid();
  g.handIndex++;
  g.phase = "DEALING";
  g.shuffled = preset
    ? [...preset]
    : shuffled(
        g.rngState === null
          ? randomInt
          : (n: number) => {
              let x = g.rngState!;
              x ^= x << 13;
              x ^= x >>> 17;
              x ^= x << 5;
              g.rngState = x;
              return (x >>> 0) % n;
            },
      );
  g.wall = g.shuffled.slice(0, 122);
  g.dead = g.shuffled.slice(122);
  g.replacements = [];
  g.kanCount = 0;
  g.interrupted = false;
  g.fourKans = false;
  g.pendingKan = null;
  g.resultDisplayUntil = null;
  for (const p of g.players) {
    Object.assign(p, {
      tiles: [],
      drawn: null,
      drawSource: null,
      melds: [],
      discards: [],
      riichi: "NONE",
      riichiKind: null,
      ippatsu: false,
      temporary: false,
      afterRiichiPass: false,
      restricted: [],
      draws: 0,
      pao: {},
    });
  }
  for (let n = 0; n < 13; n++)
    for (let offset = 0; offset < 4; offset++)
      g.players[(g.dealer + offset) % 4].tiles.push(g.wall.shift()!);
  log(g, "DEAL", {
    shuffled: g.shuffled,
    dealer: g.dealer,
    round: g.round,
    roundNumber: g.roundNumber,
    honba: g.honba,
    kyotaku: g.kyotaku,
    points: g.players.map((p) => p.points),
  });
  draw(g, g.dealer, "INITIAL", now);
}
export function indicators(g: GameState, ura = false) {
  return Array.from(
    { length: g.kanCount + 1 },
    (_, i) => g.dead[4 + 2 * i + (ura ? 1 : 0)],
  );
}
function all(p: PlayerState) {
  return [...p.tiles, ...(p.drawn === null ? [] : [p.drawn])];
}
function newOption(type: Option["type"], rest: Partial<Option> = {}): Option {
  return { optionId: uid(), type, ...rest };
}
export function furiten(g: GameState, s: Seat) {
  const p = g.players[s],
    w = waits(p.tiles, p.melds, s);
  return {
    discard: w.some((k) => p.discards.some((d) => kind(d.tile) === k)),
    temporary: p.temporary,
    afterRiichiPass: p.afterRiichiPass,
  };
}
export function winFor(
  g: GameState,
  s: Seat,
  tile: number,
  source: Seat | null,
  chankan = false,
): Win | null {
  const p = g.players[s];
  if (source !== null && Object.values(furiten(g, s)).some(Boolean))
    return null;
  const w = score({
    seat: s,
    dealer: g.dealer,
    round: g.round,
    tiles: p.tiles,
    drawn: p.drawn,
    melds: p.melds,
    winningTile: tile,
    source,
    riichi:
      p.riichi === "ESTABLISHED" ? (p.riichiKind === "DOUBLE" ? 2 : 1) : 0,
    ippatsu: p.ippatsu && p.riichi === "ESTABLISHED",
    haitei:
      g.wall.length === 0 &&
      !chankan &&
      (source !== null || p.drawSource !== "RINSHAN"),
    rinshan: source === null && p.drawSource === "RINSHAN",
    chankan,
    first:
      source === null &&
      !g.interrupted &&
      p.discards.length === 0 &&
      p.draws === 1,
    indicators: indicators(g),
    ura: indicators(g, true),
  });
  if (w)
    w.pao = Object.entries(p.pao)
      .filter(([y]) => w.yaku.some((x) => x.yakuId === y))
      .map(([yakumanId, responsibleSeat]) => ({ yakumanId, responsibleSeat }));
  return w;
}
export function canKan(g: GameState) {
  return g.wall.length > 0 && g.kanCount < 4;
}
function makeDecision(
  g: GameState,
  s: Seat,
  options: Option[],
  now: number,
): InternalDecision {
  const p = g.players[s],
    owner =
      p.participantKind === "BOT" || !p.connected || p.desiredControl === "AI"
        ? "AI"
        : "HUMAN";
  return {
    decisionId: uid(),
    windowId: g.window!.windowId,
    owner,
    deadlineAt: g.window!.deadlineAt,
    canSubmit: owner === "HUMAN",
    disabledReason: owner === "AI" ? "AI_OWNED" : null,
    submittedRequestId: null,
    options,
    choice: null,
    blocked: false,
  };
}
/**
 * An explicit 托管 hands the seat's open, unanswered decision to the AI at once,
 * instead of leaving it human-owned until the window times out.
 */
export function handOverToAi(g: GameState, s: Seat) {
  const d = g.decisions[s];
  if (!d || d.owner === "AI" || d.choice) return;
  d.owner = "AI";
  d.canSubmit = false;
  d.disabledReason = "AI_OWNED";
  d.blocked = false;
}
function selfWindow(g: GameState, s: Seat, afterCall: boolean, now: number) {
  g.phase = "SELF_ACTION";
  g.activeSeat = s;
  g.pendingKan = null;
  g.window = {
    windowId: uid(),
    kind: "SELF_ACTION",
    actorSeat: s,
    selfActionMode: afterCall ? "AFTER_CALL" : "AFTER_DRAW",
    sourceDiscardId: null,
    deadlineAt: now + 15000,
  };
  g.decisions = quad(() => null);
  g.decisions[s] = makeDecision(g, s, selfOptions(g, s, afterCall), now);
}
export function selfOptions(
  g: GameState,
  s: Seat,
  afterCall = false,
): Option[] {
  const p = g.players[s],
    tiles = all(p),
    options: Option[] = [];
  const discards =
    p.riichi === "ESTABLISHED"
      ? [p.drawn!]
      : tiles.filter((t) => !p.restricted.includes(kind(t)));
  for (const tile of discards) options.push(newOption("DISCARD", { tile }));
  if (afterCall) return options;
  if (p.drawn !== null && winFor(g, s, p.drawn, null))
    options.push(newOption("TSUMO"));
  if (
    p.riichi === "NONE" &&
    closed(p.melds) &&
    p.points >= 1000 &&
    g.wall.length >= 4
  )
    for (const tile of discards) {
      const rest = tiles.filter((t) => t !== tile);
      if (waits(rest, p.melds, s).length)
        options.push(newOption("RIICHI_DISCARD", { tile }));
    }
  if (
    !g.interrupted &&
    p.discards.length === 0 &&
    new Set(tiles.map(kind).filter(terminal)).size >= 9
  )
    options.push(newOption("ABORT_KYUUSHU"));
  if (canKan(g)) {
    for (let k = 0; k < 34; k++) {
      const same = tiles.filter((t) => kind(t) === k);
      if (
        same.length === 4 &&
        (p.riichi !== "ESTABLISHED" ||
          strictRiichiKan(p.tiles, p.drawn!, k, p.melds, s))
      )
        options.push(newOption("ANKAN", { tiles: same }));
    }
    if (p.riichi === "NONE")
      for (const m of p.melds.filter((m) => m.type === "PON"))
        for (const tile of tiles.filter((t) => kind(t) === kind(m.tiles[0])))
          options.push(newOption("KAKAN", { meldId: m.meldId, tile }));
  }
  return options;
}
export function draw(
  g: GameState,
  s: Seat,
  source = "LIVE_WALL",
  now = Date.now(),
) {
  const p = g.players[s];
  p.temporary = false;
  p.restricted = [];
  p.drawn = source === "RINSHAN" ? g.dead[g.kanCount - 1] : g.wall.shift()!;
  p.drawSource = source;
  p.draws++;
  log(g, "DRAW", { seat: s, tile: p.drawn, source });
  selfWindow(g, s, false, now);
}
function choosePairs(tiles: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++) out.push([tiles[i], tiles[j]]);
  return out;
}
function kuikae(type: string, consumed: number[], tile: number): number[] {
  const k = kind(tile),
    ban = [k];
  if (type === "CHI") {
    const ns = consumed.map(kind).sort((a, b) => a - b);
    if (ns[1] - ns[0] === 1) {
      const base = Math.floor(k / 9) * 9;
      for (const x of [ns[0] - 1, ns[1] + 1])
        if (x >= base && x < base + 9) ban.push(x);
    }
  }
  return [...new Set(ban)];
}
export function responseOptions(
  g: GameState,
  s: Seat,
  tile: number,
  from: Seat,
  kan = false,
): Option[] {
  const p = g.players[s],
    options = [newOption("PASS")];
  const win = winFor(g, s, tile, from, kan);
  if (
    win &&
    (!kan ||
      g.pendingKan?.type !== "ANKAN" ||
      win.yaku.some((y) => y.yakuId === "KOKUSHI"))
  )
    options.push(newOption("RON"));
  if (kan || p.riichi !== "NONE" || g.wall.length === 0 || g.fourKans)
    return options;
  const k = kind(tile),
    same = p.tiles.filter((t) => kind(t) === k);
  for (const consumedTiles of choosePairs(same)) {
    const ban = kuikae("PON", consumedTiles, tile);
    if (
      p.tiles.some((t) => !consumedTiles.includes(t) && !ban.includes(kind(t)))
    )
      options.push(newOption("PON", { consumedTiles }));
  }
  if (same.length === 3 && canKan(g))
    options.push(newOption("DAIMINKAN", { consumedTiles: same }));
  if (s === (from + 1) % 4 && k < 27)
    for (let start = k - 2; start <= k; start++) {
      if (
        start < 0 ||
        Math.floor(start / 9) !== Math.floor(k / 9) ||
        Math.floor((start + 2) / 9) !== Math.floor(k / 9)
      )
        continue;
      const ks = [start, start + 1, start + 2].filter((x) => x !== k);
      for (const a of p.tiles.filter((t) => kind(t) === ks[0]))
        for (const b of p.tiles.filter((t) => kind(t) === ks[1])) {
          const consumedTiles = [a, b],
            ban = kuikae("CHI", consumedTiles, tile);
          if (
            p.tiles.some(
              (t) => !consumedTiles.includes(t) && !ban.includes(kind(t)),
            )
          )
            options.push(newOption("CHI", { consumedTiles }));
        }
    }
  return options;
}
function responseWindow(
  g: GameState,
  from: Seat,
  tile: number,
  kan: boolean,
  now: number,
) {
  g.phase = kan ? "KAN_RESPONSE" : "CALL_RESPONSE";
  g.window = {
    windowId: uid(),
    kind: kan ? "KAN_RESPONSE" : "CALL_RESPONSE",
    actorSeat: from,
    selfActionMode: null,
    sourceDiscardId: kan ? null : g.players[from].discards.at(-1)!.discardId,
    deadlineAt: now + 8000,
  };
  g.decisions = quad(() => null);
  for (const s of SEATS.filter((s) => s !== from)) {
    const opts = responseOptions(g, s, tile, from, kan);
    if (opts.length > 1) g.decisions[s] = makeDecision(g, s, opts, now);
  }
  if (!g.decisions.some(Boolean)) resolve(g, now);
}
function consume(p: PlayerState, tiles: number[]) {
  const rest = all(p).filter((t) => !tiles.includes(t));
  if (rest.length !== all(p).length - tiles.length)
    throw Error("TILE_NOT_OWNED");
  p.tiles = rest;
  p.drawn = null;
  p.drawSource = null;
}
export function apply(
  g: GameState,
  s: Seat,
  optionId: string,
  requestId: string = uid(),
  now = Date.now(),
): "ACTION_APPLIED" | "RESPONSE_RECORDED" {
  const d = g.decisions[s];
  if (!d || d.choice) throw Error("DECISION_ALREADY_SUBMITTED");
  const o = d.options.find((o) => o.optionId === optionId);
  if (!o) throw Error("OPTION_NOT_AVAILABLE");
  d.choice = o;
  d.submittedRequestId = requestId;
  if (g.phase !== "SELF_ACTION") {
    if (d.options.some((x) => x.type === "RON") && o.type !== "RON") {
      const p = g.players[s];
      if (p.riichi === "ESTABLISHED") p.afterRiichiPass = true;
      else p.temporary = true;
    }
    log(g, "RESPONSE_RECORDED", { seat: s, option: o, requestId });
    if (g.decisions.every((d) => !d || d.choice)) resolve(g, now);
    return "RESPONSE_RECORDED";
  }
  const p = g.players[s];
  if (o.type === "TSUMO") {
    const w = winFor(g, s, p.drawn!, null);
    if (!w) throw Error("INVALID_WIN");
    settle(g, "TSUMO", [w], now);
  } else if (o.type === "ABORT_KYUUSHU") settle(g, "ABORT_KYUUSHU", [], now);
  else if (o.type === "ANKAN" || o.type === "KAKAN") {
    const tiles =
      o.type === "ANKAN"
        ? o.tiles!
        : [...p.melds.find((m) => m.meldId === o.meldId)!.tiles, o.tile!];
    const robbableTile =
      o.type === "KAKAN"
        ? o.tile!
        : tiles.includes(p.drawn!)
          ? p.drawn!
          : Math.min(...tiles);
    g.pendingKan = {
      seat: s,
      type: o.type,
      tiles,
      baseMeldId: o.meldId ?? null,
      robbableTile,
    };
    log(g, "KAN_PROPOSED", g.pendingKan);
    responseWindow(g, s, robbableTile, true, now);
  } else {
    const tile = o.tile!,
      tsumogiri = p.drawn === tile;
    if (p.riichi === "ESTABLISHED") p.ippatsu = false;
    consume(p, [tile]);
    p.restricted = [];
    const disc: Discard = {
      discardId: uid(),
      tile,
      tsumogiri,
      riichiDeclaration: o.type === "RIICHI_DISCARD",
      claimedByMeldId: null,
    };
    p.discards.push(disc);
    if (o.type === "RIICHI_DISCARD") {
      p.riichi = "DECLARED";
      p.riichiKind =
        p.discards.length === 1 && !g.interrupted ? "DOUBLE" : "SINGLE";
      log(g, "RIICHI_DECLARED", { seat: s });
    }
    log(g, "DISCARD", { seat: s, ...disc });
    responseWindow(g, s, tile, false, now);
  }
  return "ACTION_APPLIED";
}
function establishRiichi(g: GameState, s: Seat) {
  const p = g.players[s];
  if (p.riichi === "DECLARED") {
    p.riichi = "ESTABLISHED";
    p.points -= 1000;
    g.kyotaku += 1000;
    p.ippatsu = true;
    log(g, "RIICHI_ESTABLISHED", { seat: s });
  }
}
function interrupt(g: GameState) {
  g.interrupted = true;
  for (const p of g.players) p.ippatsu = false;
}
function notePao(g: GameState, s: Seat, m: Meld) {
  const p = g.players[s],
    open = p.melds.filter((x) => x.type !== "ANKAN" && x.type !== "CHI"),
    k = kind(m.tiles[0]);
  if (k >= 31 && open.filter((x) => kind(x.tiles[0]) >= 31).length === 3)
    p.pao.DAISANGEN = m.sourceSeat!;
  if (
    k >= 27 &&
    k <= 30 &&
    open.filter((x) => kind(x.tiles[0]) >= 27 && kind(x.tiles[0]) <= 30)
      .length === 4
  )
    p.pao.DAISUUSHII = m.sourceSeat!;
}
function finishKan(g: GameState, now: number) {
  const k = g.pendingKan!,
    p = g.players[k.seat];
  if (k.type === "ANKAN") {
    consume(p, k.tiles);
    p.melds.push({
      meldId: uid(),
      type: "ANKAN",
      tiles: k.tiles,
      sourceSeat: null,
      sourceDiscardId: null,
      calledTile: null,
      addedTile: null,
    });
  } else {
    const m = p.melds.find((m) => m.meldId === k.baseMeldId)!;
    const added = k.tiles.find((t) => !m.tiles.includes(t))!;
    consume(p, [added]);
    m.tiles.push(added);
    m.type = "KAKAN";
    m.addedTile = added;
  }
  commitKan(g, k.seat, now);
}
function commitKan(g: GameState, s: Seat, now: number) {
  g.kanCount++;
  g.replacements.push(g.wall.pop()!);
  interrupt(g);
  g.fourKans =
    g.kanCount === 4 &&
    g.players.filter((p) =>
      p.melds.some((m) => ["ANKAN", "DAIMINKAN", "KAKAN"].includes(m.type)),
    ).length > 1;
  const meld = g.pendingKan?.baseMeldId
    ? g.players[s].melds.find((m) => m.meldId === g.pendingKan!.baseMeldId)
    : g.players[s].melds.at(-1);
  log(g, "KAN_COMMITTED", { seat: s, meld: structuredClone(meld) });
  log(g, "DORA_REVEALED", { tile: indicators(g).at(-1) });
  draw(g, s, "RINSHAN", now);
}
export function resolve(g: GameState, now = Date.now()) {
  const from = g.window!.actorSeat,
    kan = g.phase === "KAN_RESPONSE",
    tile = kan
      ? g.pendingKan!.robbableTile
      : g.players[from].discards.at(-1)!.tile;
  const claims = SEATS.filter((s) => g.decisions[s]?.choice).map((s) => ({
    seat: s,
    option: g.decisions[s]!.choice!,
  }));
  const ron = claims
    .filter((c) => c.option.type === "RON")
    .sort((a, b) => ((a.seat - from + 4) % 4) - ((b.seat - from + 4) % 4));
  if (ron.length === 3) {
    settle(g, "ABORT_TRIPLE_RON", [], now);
    return;
  }
  if (ron.length) {
    const wins = ron.map((c) => winFor(g, c.seat, tile, from, kan)!);
    if (wins.some((w) => !w)) throw Error("INVALID_WIN");
    settle(g, "RON", wins, now);
    return;
  }
  if (kan) {
    finishKan(g, now);
    return;
  }
  establishRiichi(g, from);
  if (g.players.every((p) => p.riichi === "ESTABLISHED")) {
    settle(g, "ABORT_FOUR_RIICHI", [], now);
    return;
  }
  if (g.fourKans) {
    settle(g, "ABORT_FOUR_KANS", [], now);
    return;
  }
  if (
    !g.interrupted &&
    g.players.every((p) => p.discards.length === 1) &&
    g.players.every((p) => kind(p.discards[0].tile) === kind(tile)) &&
    kind(tile) >= 27 &&
    kind(tile) <= 30
  ) {
    settle(g, "ABORT_FOUR_WINDS", [], now);
    return;
  }
  const calls = claims
    .filter((c) => ["PON", "CHI", "DAIMINKAN"].includes(c.option.type))
    .sort(
      (a, b) =>
        (a.option.type === "CHI" ? 1 : 0) - (b.option.type === "CHI" ? 1 : 0) ||
        ((a.seat - from + 4) % 4) - ((b.seat - from + 4) % 4),
    );
  if (calls.length) {
    const { seat, option: o } = calls[0],
      p = g.players[seat],
      discard = g.players[from].discards.at(-1)!;
    const m: Meld = {
      meldId: uid(),
      type: o.type as Meld["type"],
      tiles: [...o.consumedTiles!, tile],
      sourceSeat: from,
      sourceDiscardId: discard.discardId,
      calledTile: tile,
      addedTile: null,
    };
    consume(p, o.consumedTiles!);
    p.melds.push(m);
    discard.claimedByMeldId = m.meldId;
    notePao(g, seat, m);
    interrupt(g);
    log(g, "CALL_RESOLVED", { seat, meld: m });
    if (o.type === "DAIMINKAN") commitKan(g, seat, now);
    else {
      p.restricted = kuikae(o.type, o.consumedTiles!, tile);
      selfWindow(g, seat, true, now);
    }
    return;
  }
  if (!g.wall.length) {
    exhaustive(g, now);
    return;
  }
  draw(g, ((from + 1) % 4) as Seat, "LIVE_WALL", now);
}
function exhaustive(g: GameState, now: number) {
  const nagashi = SEATS.filter((s) => {
    const p = g.players[s];
    return (
      !p.melds.length &&
      p.discards.length > 0 &&
      p.discards.every((d) => terminal(kind(d.tile)) && !d.claimedByMeldId)
    );
  }).sort((a, b) => ((a - g.dealer + 4) % 4) - ((b - g.dealer + 4) % 4));
  if (nagashi.length) {
    const wins: Win[] = nagashi.map((winnerSeat) => ({
      winnerSeat,
      sourceSeat: null,
      winningTile: null,
      method: "NAGASHI_MANGAN",
      yaku: [],
      fu: null,
      han: null,
      yakumanMultiplier: 0,
      limit: "MANGAN",
      dora: { omote: 0, ura: 0, aka: 0 },
      basePoints: 2000,
      fuDetails: [],
      decomposition: null,
      pao: [],
    }));
    settle(g, "NAGASHI_MANGAN", wins, now);
  } else settle(g, "EXHAUSTIVE_DRAW", [], now);
}
const ceil100 = (n: number) => Math.ceil(n / 100) * 100;
export function paymentLedger(
  win: Win,
  dealer: Seat,
  honba: number,
): Transfer[] {
  const out: Transfer[] = [];
  const to = win.winnerSeat;
  const add = (
    from: Seat,
    amount: number,
    reason = "HAND_VALUE",
    yakumanId: string | null = null,
  ) => {
    if (amount > 0 && from !== to)
      out.push({
        transferId: uid(),
        from,
        to,
        amount,
        reason,
        winnerSeat: to,
        yakumanId,
      });
  };
  const normal = (base: number, yakumanId: string | null = null) => {
    if (win.sourceSeat !== null)
      add(
        win.sourceSeat,
        ceil100(base * (to === dealer ? 6 : 4)),
        "HAND_VALUE",
        yakumanId,
      );
    else
      for (const s of SEATS.filter((s) => s !== to))
        add(
          s,
          ceil100(base * (s === dealer || to === dealer ? 2 : 1)),
          "HAND_VALUE",
          yakumanId,
        );
  };
  if (win.yakumanMultiplier) {
    for (const y of win.yaku.filter((y) => y.yakumanMultiplier)) {
      const pao = win.pao.find((p) => p.yakumanId === y.yakuId),
        base = y.yakumanMultiplier * 8000,
        total = base * (to === dealer ? 6 : 4);
      if (!pao) normal(base, y.yakuId);
      else if (
        win.sourceSeat === null ||
        win.sourceSeat === pao.responsibleSeat
      )
        add(pao.responsibleSeat, total, "HAND_VALUE", y.yakuId);
      else {
        add(pao.responsibleSeat, total / 2, "HAND_VALUE", y.yakuId);
        add(win.sourceSeat, total / 2, "HAND_VALUE", y.yakuId);
      }
    }
  } else normal(win.basePoints);
  if (honba) {
    if (win.sourceSeat !== null) add(win.sourceSeat, honba * 300, "HONBA");
    else if (win.pao.length)
      add(win.pao[0].responsibleSeat, honba * 300, "HONBA");
    else
      for (const s of SEATS.filter((s) => s !== to))
        add(s, honba * 100, "HONBA");
  }
  return out;
}
export function ending(
  g: GameState,
  reason: string,
  winners: Seat[],
  tenpai: Seat[],
): { end: string | null; repeat: boolean } {
  const abort = reason.startsWith("ABORT"),
    repeat =
      abort ||
      (reason === "EXHAUSTIVE_DRAW"
        ? tenpai.includes(g.dealer)
        : winners.includes(g.dealer));
  if (g.players.some((p) => p.points < 0)) return { end: "BANKRUPTCY", repeat };
  const target = g.players.some((p) => p.points >= 30000);
  const plannedLastRound = g.format === "HANCHAN" ? 1 : 0;
  if (g.round > plannedLastRound) {
    if (target) return { end: "EXTENSION_TARGET_REACHED", repeat };
    if (g.roundNumber === 4) return { end: "EXTENSION_HARD_LIMIT", repeat };
  }
  if (g.round === plannedLastRound && g.roundNumber === 4 && !abort) {
    const first = SEATS.slice().sort(
      (a, b) => g.players[b].points - g.players[a].points || a - b,
    )[0];
    if (repeat && first === g.dealer && g.players[g.dealer].points >= 30000)
      return {
        end:
          reason === "EXHAUSTIVE_DRAW"
            ? "DEALER_TENPAI_YAME"
            : "DEALER_AGARI_YAME",
        repeat,
      };
    if (!repeat && target) return { end: "SCHEDULE_COMPLETE", repeat };
  }
  return { end: null, repeat };
}
export function settle(
  g: GameState,
  reason: string,
  wins: Win[],
  now = Date.now(),
) {
  if (g.phase === "HAND_RESULT" || g.phase === "MATCH_RESULT")
    throw Error("ALREADY_SETTLED");
  const before = quad((s) => g.players[s].points),
    transfers: Transfer[] = [];
  let kyotakuBefore = g.kyotaku;
  const tenpai =
    reason === "EXHAUSTIVE_DRAW"
      ? SEATS.filter(
          (s) => waits(g.players[s].tiles, g.players[s].melds, s).length > 0,
        )
      : [];
  if (wins.length) {
    for (const win of wins)
      transfers.push(...paymentLedger(win, g.dealer, g.honba));
    if (g.kyotaku)
      transfers.push({
        transferId: uid(),
        from: "KYOTAKU",
        to: wins[0].winnerSeat,
        amount: g.kyotaku,
        reason: "KYOTAKU_AWARD",
        winnerSeat: wins[0].winnerSeat,
        yakumanId: null,
      });
  } else if (tenpai.length && tenpai.length < 4) {
    const debt = SEATS.filter((s) => !tenpai.includes(s)).map((seat) => ({
        seat,
        left: 3000 / (4 - tenpai.length),
      })),
      credit = tenpai.map((seat) => ({ seat, left: 3000 / tenpai.length }));
    for (const a of debt)
      for (const b of credit) {
        const amount = Math.min(a.left, b.left);
        if (amount) {
          transfers.push({
            transferId: uid(),
            from: a.seat,
            to: b.seat,
            amount,
            reason: "NOTEN",
            winnerSeat: null,
            yakumanId: null,
          });
          a.left -= amount;
          b.left -= amount;
        }
      }
  }
  function transfer(t: Transfer) {
    if (t.from === "KYOTAKU") g.kyotaku -= t.amount;
    else g.players[t.from].points -= t.amount;
    if (t.to === "KYOTAKU") g.kyotaku += t.amount;
    else g.players[t.to].points += t.amount;
  }
  transfers.forEach(transfer);
  if (reason === "ABORT_FOUR_RIICHI") {
    const from = g.window!.actorSeat;
    before[from] += 1000;
    kyotakuBefore -= 1000;
    transfers.unshift({
      transferId: uid(),
      from,
      to: "KYOTAKU",
      amount: 1000,
      reason: "RIICHI_DEPOSIT",
      winnerSeat: null,
      yakumanId: null,
    });
  }
  const { end, repeat } = ending(
    g,
    reason,
    wins.map((w) => w.winnerSeat),
    tenpai,
  );
  let next: NextHand | null = null;
  if (end) {
    if (g.kyotaku) {
      const to = SEATS.slice().sort(
        (a, b) => g.players[b].points - g.players[a].points || a - b,
      )[0];
      const t: Transfer = {
        transferId: uid(),
        from: "KYOTAKU",
        to,
        amount: g.kyotaku,
        reason: "FINAL_KYOTAKU",
        winnerSeat: null,
        yakumanId: null,
      };
      transfers.push(t);
      transfer(t);
    }
    const ranking = SEATS.slice().sort(
      (a, b) => g.players[b].points - g.players[a].points || a - b,
    );
    g.status = "FINISHED";
    g.finishedAt = now;
    g.matchResult = {
      matchId: g.matchId,
      reason: end,
      finalPoints: quad((s) => g.players[s].points),
      ranks: quad((s) => ranking.indexOf(s) + 1),
      netPoints: quad((s) => g.players[s].points - 25000),
      replayAvailable: true,
    };
  } else {
    let round = g.round,
      roundNumber = g.roundNumber,
      dealer = g.dealer;
    if (!repeat) {
      dealer = ((dealer + 1) % 4) as Seat;
      roundNumber++;
      if (roundNumber === 5) {
        round++;
        roundNumber = 1;
      }
    }
    next = {
      roundWind: WINDS[round],
      roundNumber,
      dealerSeat: dealer,
      honba: repeat || !wins.length ? g.honba + 1 : 0,
      kyotakuPoints: g.kyotaku,
      isExtension: round > (g.format === "HANCHAN" ? 1 : 0),
    };
  }
  const reveal = wins.length ? wins.map((w) => w.winnerSeat) : tenpai;
  g.lastResult = {
    settlementId: uid(),
    handId: g.handId,
    reason,
    wins,
    tenpaiSeats: reason === "EXHAUSTIVE_DRAW" ? tenpai : null,
    revealedHands: reveal.map((seat) => ({
      seat,
      concealedTiles: [...g.players[seat].tiles],
      drawnTile: g.players[seat].drawn,
      winningTile: wins.find((w) => w.winnerSeat === seat)?.winningTile ?? null,
    })),
    revealedUraIndicators: wins.some(
      (w) => g.players[w.winnerSeat].riichi === "ESTABLISHED",
    )
      ? indicators(g, true)
      : [],
    pointsBefore: before,
    kyotakuBefore,
    transfers,
    delta: quad((s) => g.players[s].points - before[s]),
    pointsAfter: quad((s) => g.players[s].points),
    kyotakuAfter: g.kyotaku,
    nextHand: next,
    matchEndReason: end,
  };
  g.phase = "HAND_RESULT";
  g.resultDisplayUntil =
    now +
    (process.env.NODE_ENV === "test" && process.env.FAST_TEST === "1"
      ? 30
      : 8000);
  g.window = null;
  g.decisions = quad(() => null);
  log(g, "HAND_SETTLED", g.lastResult);
  if (end) log(g, "MATCH_FINISHED", g.matchResult);
}
export function advanceResult(g: GameState, now = Date.now()) {
  if (g.phase !== "HAND_RESULT") return;
  if (g.matchResult) {
    g.phase = "MATCH_RESULT";
    g.resultDisplayUntil = null;
    return;
  }
  const next = g.lastResult!.nextHand!;
  g.round = WINDS.indexOf(next.roundWind as (typeof WINDS)[number]);
  g.roundNumber = next.roundNumber;
  g.dealer = next.dealerSeat;
  g.honba = next.honba;
  deal(g, undefined, now);
}
export function timeout(g: GameState, s: Seat, now = Date.now()) {
  const d = g.decisions[s];
  if (!d || d.choice) return;
  const p = g.players[s];
  const options = d.options;
  const o =
    g.phase === "SELF_ACTION"
      ? (options.find((o) => o.type === "DISCARD" && o.tile === p.drawn) ??
        options
          .filter((o) => o.type === "DISCARD")
          .sort((a, b) => a.tile! - b.tile!)[0])
      : options.find((o) => o.type === "PASS");
  if (!o) throw Error("NO_TIMEOUT_OPTION");
  apply(g, s, o.optionId, `timeout:${d.decisionId}`, now);
}
export function project(g: GameState, s: Seat): MatchView {
  const p = g.players[s],
    d = g.decisions[s];
  // The event identifies order; the public river entry supplies the current claimed status.
  const event = g.events.findLast(
    (e) => e.handId === g.handId && e.type === "DISCARD",
  );
  const last = event?.data as { seat: Seat; discardId: string } | undefined;
  const discard = last
    ? g.players[last.seat].discards.find((d) => d.discardId === last.discardId)
    : undefined;
  return {
    matchId: g.matchId,
    rulesetId: RULESET,
    format: g.format ?? "EAST_ONLY",
    mode:
      g.mode ??
      (g.players.filter((p) => p.participantKind === "HUMAN").length === 1
        ? "AI_PRACTICE"
        : "FRIENDS"),
    timePresetId: "standard-v1",
    status: g.status,
    viewerSeat: s,
    players: quad((t) => {
      const x = g.players[t];
      return {
        seat: t,
        displayName: x.displayName,
        ...(x.avatarId ? { avatarId: x.avatarId } : {}),
        participantKind: x.participantKind,
        connected: x.connected,
        effectiveControl:
          g.decisions[t]?.owner ??
          (x.desiredControl === "AI" ||
          !x.connected ||
          x.participantKind === "BOT"
            ? "AI"
            : "HUMAN"),
        points: x.points,
        botLevel: x.botLevel,
        botPolicyVersion:
          x.participantKind === "BOT"
            ? (x.botPolicyVersion ?? "legacy-v1")
            : null,
      };
    }),
    hand: {
      handId: g.handId,
      handIndex: g.handIndex,
      roundWind: WINDS[g.round],
      roundNumber: g.roundNumber,
      isExtension: g.round > (g.format === "HANCHAN" ? 1 : 0),
      dealerSeat: g.dealer,
      honba: g.honba,
      kyotakuPoints: g.kyotaku,
      phase: g.phase,
      activeSeat: g.activeSeat,
      liveWallRemaining: g.wall.length,
      rinshanRemaining: 4 - g.kanCount,
      successfulKanCount: g.kanCount,
      doraIndicators: indicators(g),
      lastDiscard:
        discard && last
          ? { seat: last.seat, ...structuredClone(discard) }
          : null,
      seats: quad((t) => {
        const x = g.players[t];
        return {
          seat: t,
          seatWind: WINDS[(t - g.dealer + 4) % 4],
          concealedCount: all(x).length,
          riichi: x.riichi,
          riichiKind: x.riichiKind,
          riichiDiscardId:
            x.discards.find((d) => d.riichiDeclaration)?.discardId ?? null,
          melds: structuredClone(x.melds),
          discards: structuredClone(x.discards),
        };
      }),
      window: g.window ? { ...g.window } : null,
      pendingKan: g.pendingKan ? structuredClone(g.pendingKan) : null,
      resultDisplayUntil: g.resultDisplayUntil,
    },
    self: {
      concealedTiles: [...p.tiles].sort((a, b) => a - b),
      drawnTile: p.drawn,
      drawSource: p.drawSource,
      furiten: furiten(g, s),
      decision: d
        ? {
            decisionId: d.decisionId,
            windowId: d.windowId,
            owner: d.owner,
            deadlineAt: d.deadlineAt,
            canSubmit: d.owner === "HUMAN" && !d.blocked && !d.choice,
            disabledReason: d.choice
              ? "ALREADY_SUBMITTED"
              : d.blocked
                ? "CONTROL_PENDING"
                : d.owner === "AI"
                  ? "AI_OWNED"
                  : null,
            submittedRequestId: d.submittedRequestId,
            options: structuredClone(d.options),
          }
        : null,
      desiredControl: p.desiredControl,
    },
    lastHandResult: g.lastResult ? structuredClone(g.lastResult) : null,
    matchResult: g.matchResult ? structuredClone(g.matchResult) : null,
    abortReason: g.status === "ABORTED" ? "TECHNICAL_FAILURE" : null,
  };
}
export function assertInvariants(g: GameState) {
  if (g.players.reduce((n, p) => n + p.points, 0) + g.kyotaku !== 100000)
    throw Error("POINT_CONSERVATION");
  const tiles = [
    ...g.wall,
    ...g.dead.slice(g.kanCount, 4),
    ...g.dead.slice(4),
    ...g.replacements,
    ...g.players.flatMap((p) => [
      ...all(p),
      ...p.melds.flatMap((m) => m.tiles),
      ...p.discards.filter((d) => !d.claimedByMeldId).map((d) => d.tile),
    ]),
  ];
  if (
    tiles.length !== 136 ||
    new Set(tiles).size !== 136 ||
    tiles.some((t) => !Number.isInteger(t) || t < 0 || t > 135)
  )
    throw Error(`TILE_CONSERVATION ${tiles.length}/${new Set(tiles).size}`);
  for (const p of g.players) {
    const eq = all(p).length + p.melds.length * 3;
    const target =
      g.phase === "SELF_ACTION" && g.activeSeat === p.seat
        ? 14
        : g.phase === "KAN_RESPONSE" && g.pendingKan?.seat === p.seat
          ? 14
          : 13;
    if (!["HAND_RESULT", "MATCH_RESULT"].includes(g.phase) && eq !== target)
      throw Error(`HAND_SIZE seat ${p.seat}: ${eq}/${target}`);
  }
}
