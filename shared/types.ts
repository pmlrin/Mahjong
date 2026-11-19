import type { RatingChange } from "./rating.ts";
export type { RatingChange } from "./rating.ts";
export type MatchFormat = "EAST_ONLY" | "HANCHAN";
export type BotLevel = "BASIC" | "STANDARD" | "ADVANCED" | "MASTER";
/** Weakest to strongest. The identifiers are stored in saved matches, so BASIC／STANDARD keep their names. */
export const BOT_LEVELS: BotLevel[] = ["BASIC", "STANDARD", "ADVANCED", "MASTER"];
export const BOT_LEVEL_LABELS: Record<BotLevel, string> = {
  BASIC: "一尾",
  STANDARD: "三尾",
  ADVANCED: "六尾",
  MASTER: "九尾",
};
/** A human seat handed to the AI (托管 or disconnected) always plays at this level. */
export const AUTOPILOT_BOT_LEVEL: BotLevel = "STANDARD";
export const botLevelLabel = (level: BotLevel | null | undefined) =>
  BOT_LEVEL_LABELS[level ?? AUTOPILOT_BOT_LEVEL];
export type MatchMode = "AI_PRACTICE" | "FRIENDS";
export const BOT_POLICY_VERSION = "v3.1.0" as const;
export const APP_VERSION = "0.5.1" as const;
export type Seat = 0 | 1 | 2 | 3;
export type Quad<T> = [T, T, T, T];
export const SEATS: Seat[] = [0, 1, 2, 3];
export const WINDS = ["EAST", "SOUTH", "WEST", "NORTH"] as const;
export const RULESET = "riichi-4p-v1.0" as const;
export const PROTOCOL = "2.0" as const;
export type ActionType =
  | "DISCARD"
  | "RIICHI_DISCARD"
  | "TSUMO"
  | "ABORT_KYUUSHU"
  | "ANKAN"
  | "KAKAN"
  | "PASS"
  | "RON"
  | "CHI"
  | "PON"
  | "DAIMINKAN";
export interface Option {
  optionId: string;
  type: ActionType;
  tile?: number;
  tiles?: number[];
  consumedTiles?: number[];
  meldId?: string;
}
export interface Meld {
  meldId: string;
  type: "CHI" | "PON" | "ANKAN" | "KAKAN" | "DAIMINKAN";
  tiles: number[];
  sourceSeat: Seat | null;
  sourceDiscardId: string | null;
  calledTile: number | null;
  addedTile: number | null;
}
export interface Discard {
  discardId: string;
  tile: number;
  tsumogiri: boolean;
  riichiDeclaration: boolean;
  claimedByMeldId: string | null;
}
export interface Decision {
  decisionId: string;
  windowId: string;
  owner: "HUMAN" | "AI";
  deadlineAt: number;
  canSubmit: boolean;
  disabledReason: string | null;
  submittedRequestId: string | null;
  options: Option[];
}
export interface Member {
  memberId: string;
  userId: string | null;
  displayName: string;
  avatarId?: string;
  participantKind: "HUMAN" | "BOT";
  ready: boolean;
  connected: boolean;
  botLevel: BotLevel | null;
  botPolicyVersion?: string | null;
  /** 当前等级分：人类为本人的分，假想妖为固定分。 */
  rating?: number | null;
}
export type RoomVisibility = "PRIVATE" | "PUBLIC";
export interface PublicRoomSeat {
  displayName: string;
  avatarId?: string;
  participantKind: "HUMAN" | "BOT";
  botLevel: BotLevel | null;
  host: boolean;
}
export interface PublicRoomSummary {
  roomId: string;
  format: MatchFormat;
  seats: Quad<PublicRoomSeat | null>;
  /** Empty seats plus seats a bot will give up to a newcomer. */
  openSeats: number;
}
export interface PublicLobby {
  rooms: PublicRoomSummary[];
  online: number;
}
export interface MatchQueueStatus {
  queued: boolean;
  format: MatchFormat | null;
  since: number | null;
  /** Players (including you) waiting for the same format. */
  waiting: number;
  /** When bots will fill the table if at least two people are waiting. */
  botFillAt: number | null;
}
export interface MatchFound {
  roomId: string;
  matchId: string;
}
export interface Room {
  roomId: string;
  inviteCode: string;
  /** PUBLIC rooms are listed in the lobby for every online player to join. */
  visibility: RoomVisibility;
  status: "WAITING" | "PLAYING" | "FINISHED" | "ABORTED" | "CLOSED";
  lobbyGeneration: number;
  previousMatchIds: string[];
  isRematchLobby: boolean;
  memberJoinOrder: string[];
  offlineSince: Record<string, number>;
  roomVersion: number;
  presenceVersion: number;
  roomViewSeq: number;
  hostUserId: string;
  config: {
    rulesetId: typeof RULESET;
    format: MatchFormat;
    timePresetId: "standard-v1";
  };
  slots: Quad<Member | null>;
  matchId: string | null;
}
export interface PublicPlayer {
  seat: Seat;
  displayName: string;
  avatarId?: string;
  participantKind: "HUMAN" | "BOT";
  connected: boolean;
  effectiveControl: "HUMAN" | "AI";
  points: number;
  botLevel: BotLevel | null;
  botPolicyVersion: string | null;
  /** 开局时的等级分。旧对局没有。 */
  rating?: number | null;
}
export interface HandSeat {
  seat: Seat;
  seatWind: string;
  concealedCount: number;
  riichi: "NONE" | "DECLARED" | "ESTABLISHED";
  riichiKind: "SINGLE" | "DOUBLE" | null;
  riichiDiscardId: string | null;
  melds: Meld[];
  discards: Discard[];
}
export interface LastDiscard extends Discard {
  seat: Seat;
}
export interface PublicWindow {
  windowId: string;
  kind: "SELF_ACTION" | "CALL_RESPONSE" | "KAN_RESPONSE";
  actorSeat: Seat;
  selfActionMode: "AFTER_DRAW" | "AFTER_CALL" | null;
  sourceDiscardId: string | null;
  deadlineAt: number;
}
export interface PendingKan {
  seat: Seat;
  type: "ANKAN" | "KAKAN";
  tiles: number[];
  baseMeldId: string | null;
  robbableTile: number;
}
export interface HandPublic {
  handId: string;
  handIndex: number;
  roundWind: string;
  roundNumber: number;
  isExtension: boolean;
  dealerSeat: Seat;
  honba: number;
  kyotakuPoints: number;
  phase: string;
  activeSeat: Seat | null;
  liveWallRemaining: number;
  rinshanRemaining: number;
  successfulKanCount: number;
  doraIndicators: number[];
  lastDiscard: LastDiscard | null;
  seats: Quad<HandSeat>;
  window: PublicWindow | null;
  pendingKan: PendingKan | null;
  resultDisplayUntil: number | null;
}
export interface SelfView {
  concealedTiles: number[];
  drawnTile: number | null;
  drawSource: string | null;
  furiten: { discard: boolean; temporary: boolean; afterRiichiPass: boolean };
  decision: Decision | null;
  desiredControl: "HUMAN" | "AI";
}
export interface Yaku {
  yakuId: string;
  name: string;
  han: number;
  yakumanMultiplier: number;
}
export interface Win {
  winnerSeat: Seat;
  sourceSeat: Seat | null;
  winningTile: number | null;
  method: "TSUMO" | "RON" | "NAGASHI_MANGAN";
  yaku: Yaku[];
  fu: number | null;
  han: number | null;
  yakumanMultiplier: number;
  limit: string;
  dora: { omote: number; ura: number; aka: number };
  basePoints: number;
  fuDetails: { code: string; value: number; meldId: string | null }[];
  decomposition: { kind: string; groups: number[][] } | null;
  pao: { yakumanId: string; responsibleSeat: Seat }[];
}
export interface Transfer {
  transferId: string;
  from: Seat | "KYOTAKU";
  to: Seat | "KYOTAKU";
  amount: number;
  reason: string;
  winnerSeat: Seat | null;
  yakumanId: string | null;
}
export interface NextHand {
  roundWind: string;
  roundNumber: number;
  dealerSeat: Seat;
  honba: number;
  kyotakuPoints: number;
  isExtension: boolean;
}
export interface Result {
  settlementId: string;
  handId: string;
  reason: string;
  wins: Win[];
  tenpaiSeats: Seat[] | null;
  revealedHands: {
    seat: Seat;
    concealedTiles: number[];
    drawnTile: number | null;
    winningTile: number | null;
  }[];
  revealedUraIndicators: number[];
  pointsBefore: Quad<number>;
  kyotakuBefore: number;
  transfers: Transfer[];
  delta: Quad<number>;
  pointsAfter: Quad<number>;
  kyotakuAfter: number;
  nextHand: NextHand | null;
  matchEndReason: string | null;
}
export interface MatchResult {
  matchId: string;
  reason: string;
  finalPoints: Quad<number>;
  ranks: Quad<number>;
  netPoints: Quad<number>;
  replayAvailable: boolean;
  /** 本场等级分加减；正常结束时由服务端结算。 */
  ratingChanges?: Quad<RatingChange> | null;
}
export interface MatchView {
  matchId: string;
  rulesetId: typeof RULESET;
  format: MatchFormat;
  mode: MatchMode;
  timePresetId: "standard-v1";
  status: string;
  viewerSeat: Seat;
  players: Quad<PublicPlayer>;
  hand: HandPublic;
  self: SelfView;
  lastHandResult: Result | null;
  matchResult: MatchResult | null;
  abortReason: string | null;
}
export interface Frame {
  protocolVersion: typeof PROTOCOL;
  serverTime: number;
  matchId: string;
  serverEpoch: number;
  streamId: string;
  viewSeq: number;
  syncId: string | null;
  state: MatchView;
}
export interface Action {
  matchId: string;
  handId: string;
  serverEpoch: number;
  bindingId: string;
  windowId: string;
  decisionId: string;
  optionId: string;
  lastSeenViewSeq: number;
}
export interface Envelope<T> {
  protocolVersion: typeof PROTOCOL;
  requestId: string;
  payload: T;
}
export interface Receipt {
  protocolVersion: typeof PROTOCOL;
  serverTime: number;
  requestId: string;
  matchId: string;
  receiptId: string;
  status: "ACCEPTED" | "REJECTED";
  acceptance?: "ACTION_APPLIED" | "RESPONSE_RECORDED";
  decisionId?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    shouldSync: boolean;
  };
}
export const kind = (tile: number) => Math.floor(tile / 4);
export const isRed = (tile: number) => [16, 52, 88].includes(tile);
export const tileName = (tile: number) => {
  const k = kind(tile);
  return k < 27
    ? `${isRed(tile) ? "赤" : ""}${["一", "二", "三", "四", "五", "六", "七", "八", "九"][k % 9]}${["万", "筒", "索"][Math.floor(k / 9)]}`
    : ["东", "南", "西", "北", "白", "发", "中"][k - 27];
};

export interface HistoryMember {
  seat: Seat;
  userId: string | null;
  displayName: string;
  avatarId?: string;
  participantKind: "HUMAN" | "BOT";
  botLevel: BotLevel | null;
  botPolicyVersion: string | null;
  points: number;
  rank: number | null;
  netPoints: number;
  rating?: RatingChange | null;
}
export interface HistorySummary {
  matchId: string;
  roomId: string;
  format: MatchFormat;
  mode: MatchMode;
  status: "FINISHED" | "ABORTED";
  createdAt: number;
  finishedAt: number;
  rulesetId: string;
  protocolVersion: string;
  replayVersion: string;
  replayAvailable: boolean;
  source: "NATIVE_V2" | "LEGACY_V1";
  members: HistoryMember[];
  reason: string;
  hands: {
    handId: string;
    handIndex: number;
    reason: string;
    roundWind: string;
    roundNumber: number;
    honba: number;
    delta: Quad<number>;
    pointsAfter: Quad<number>;
  }[];
}
export interface HistoryPage {
  items: HistorySummary[];
  nextCursor: string | null;
}
export interface MatchStats {
  count: number;
  firstPlaceRate: number | null;
  averageRank: number | null;
  averageNetPoints: number | null;
  distribution: { rank: number; count: number; rate: number | null }[];
  from: number;
  to: number;
  format: MatchFormat | null;
  mode: MatchMode | null;
}
export interface ReplayPosition {
  handId: string;
  eventIndex: number;
  viewerSeat: Seat;
  updatedAt: number;
}
export interface Diagnostic {
  diagnosticId: string;
  appVersion: string;
  protocolVersion: string;
  rulesetId: string;
  roomId: string | null;
  matchId: string | null;
  handId: string | null;
  phase: string | null;
  viewSeq: number | null;
  serverEpoch: number | null;
  serverTime: number;
}

export interface AuthCapabilities {
  enabled: boolean;
  passwordLogin: boolean;
  registration: boolean;
  passwordReset: boolean;
  mailAvailable: boolean;
  previewRestricted: boolean;
  environment: "preview" | "production";
}
export interface CurrentUser {
  userId: string;
  displayName: string;
  avatarId?: string;
  roomId: string | null;
  matchId: string | null;
  identityKind: "GUEST" | "ACCOUNT";
  maskedEmail: string | null;
  rating?: number;
  ratedMatches?: number;
}
