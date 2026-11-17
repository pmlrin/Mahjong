import { SocialService } from "./social/service.ts";
import { mountSocialRoutes } from "./social/http.ts";
import { DEFAULT_AVATAR } from "../../shared/social.ts";
import express, { type Request, type Response } from "express";
import { createServer } from "node:http";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { summarize, publicSummary, decodeCursor } from "./history.ts";
import { backfill, normalizeRoom, normalizeGame } from "./migration.ts";
import {
  checkGeneration,
  removeMember,
  openRematch,
  expireOffline,
} from "./lobby.ts";
import { measure, flushMetrics } from "./metrics.ts";
import { botReadyAt } from "./bot-timing.ts";
import { recoverable, technicalAbort } from "./recovery.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { AuthService } from "./auth/service.ts";
import { AuthError, type Identity } from "./auth/types.ts";
import { authConfig } from "./auth/config.ts";
import { MailQueue } from "./auth/mail.ts";
import { digest } from "./auth/crypto.ts";
import { mountAuthRoutes } from "./auth/http.ts";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { Store, type Write } from "./store.ts";
import { BotPool } from "./bot-pool.ts";
import { botLevelOf } from "./bot.ts";
import {
  uid,
  quad,
  createGame,
  project,
  apply,
  timeout,
  advanceResult,
  assertInvariants,
  log,
  type GameState,
} from "./engine.ts";
import {
  PROTOCOL,
  APP_VERSION,
  BOT_POLICY_VERSION,
  BOT_LEVELS,
  AUTOPILOT_BOT_LEVEL,
  type BotLevel,
  type MatchFormat,
  type MatchMode,
  RULESET,
  SEATS,
  type Seat,
  type Room,
  type Member,
  type Frame,
  type Receipt,
  type Action,
  type Envelope,
} from "../../shared/types.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = existsSync(resolve(root, "release.json"))
  ? JSON.parse(readFileSync(resolve(root, "release.json"), "utf8"))
  : { sourceSha256: "development" };
console.log(
  JSON.stringify({
    event: "SERVER_BUILD",
    version: APP_VERSION,
    protocol: PROTOCOL,
    sourceSha256: release.sourceSha256,
  }),
);
const store = new Store();
await store.open();
console.log(
  JSON.stringify({ event: "HISTORY_BACKFILL", ...(await backfill(store)) }),
);
type Session = Identity;
interface SavedReceipt {
  hash: string;
  userId: string;
  receipt: Receipt;
}
interface HttpReceipt {
  hash: string;
  status: number;
  data: unknown;
}
const rooms = new Map(
  (await store.list<Room>("room")).map((x) => [x.id, normalizeRoom(x.data)]),
);
const games = new Map(
  (await store.activeGames<GameState>()).map((x) => [
    x.id,
    normalizeGame(x.data),
  ]),
);
const receipts = new Map<string, SavedReceipt>();
const httpReceipts = new Map<string, HttpReceipt>();
const bindings = new Map<
  string,
  { socketId: string; bindingId: string; sessionHash: string }
>();
const subscriptions = new Map<string, string>();
const clocks = new Map<string, number>();
const bots = new BotPool();
const BOT_LEVEL_METRICS: Record<BotLevel, string> = {
  BASIC: "botBasicMs",
  STANDARD: "botStandardMs",
  ADVANCED: "botAdvancedMs",
  MASTER: "botMasterMs",
};
const botPending = new Set<string>();
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = tail.then(fn);
  tail = p.catch((e) =>
    console.error(
      JSON.stringify({ event: "TRANSACTION_FAILURE", message: e.message }),
    ),
  );
  return p;
}
class BusinessError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string, status = 409): never => {
  throw new BusinessError(code, message, status);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((v as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
const errors: Record<string, string> = {
  CONTROL_REVOKED: "此页面的控制权已失效，请重新接管",
  CONTROL_IN_USE: "另一页面正在控制牌桌，可选择接管",
  EPOCH_STALE: "服务已恢复，请同步最新牌桌",
  HAND_MISMATCH: "该局已结束，请等待当前牌局",
  WINDOW_EXPIRED: "本次操作时间已结束",
  DECISION_NOT_OWNED: "当前不是你的操作时机",
  DECISION_ALREADY_SUBMITTED: "本次选择已经提交",
  OPTION_NOT_AVAILABLE: "该操作已不可用，请同步牌桌",
  REQUEST_ID_CONFLICT: "这项操作已经提交过了",
  CONTROL_PENDING: "将在下个操作窗口恢复人工",
  MATCH_NOT_RUNNING: "比赛已经结束",
};
function errorData(e: unknown) {
  if (e instanceof z.ZodError)
    return {
      code: "INVALID_PAYLOAD",
      message: "请求格式不正确",
      retryable: false,
      shouldSync: false,
    };
  if (e instanceof AuthError)
    return {
      code: e.code,
      message: e.message,
      retryable: false,
      shouldSync: e.status === 401,
    };
  if (e instanceof BusinessError)
    return {
      code: e.code,
      message: e.message,
      retryable: false,
      shouldSync: true,
    };
  return {
    code: "TEMPORARY_UNAVAILABLE",
    message: "服务暂时不可用，请稍后重试",
    retryable: true,
    shouldSync: true,
  };
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
const id = z.string().min(1).max(128),
  uuid = z.uuid();
const base = z
  .object({
    protocolVersion: z.literal(PROTOCOL),
    requestId: uuid,
    payload: z.unknown(),
  })
  .strict();
const actionSchema = z
  .object({
    matchId: id,
    handId: id,
    serverEpoch: z.number().int().positive(),
    bindingId: id,
    windowId: id,
    decisionId: id,
    optionId: id,
    lastSeenViewSeq: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "16kb" }));
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
  });
  next();
});
const rate = new Map<string, { n: number; at: number }>();
function limited(key: string, max: number) {
  const now = Date.now(),
    old = rate.get(key);
  if (!old || now - old.at > 60000) {
    rate.set(key, { n: 1, at: now });
    return;
  }
  if (++old.n > max) fail("RATE_LIMITED", "操作太频繁，请稍候", 429);
}
function originOK(origin: string | undefined, host: string | undefined) {
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const expected = process.env.PUBLIC_ORIGIN;
    return expected ? o.origin === expected : o.host === host;
  } catch {
    return false;
  }
}
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    limited(`http:${req.ip}`, 600);
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !originOK(req.headers.origin, req.headers.host)
    )
      fail("FORBIDDEN", "请从本站页面打开", 403);
    next();
  } catch (e) {
    res
      .status(e instanceof BusinessError ? e.status : 400)
      .json({ error: errorData(e) });
  }
});
const cookieName = process.env.SESSION_COOKIE_NAME ?? "mj_session";
function sessionFrom(cookie: string | undefined): Session | null {
  const token = cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (!token) return null;
  return auth.resolveToken(token);
}
function user(req: Request): Session {
  return (
    sessionFrom(req.headers.cookie) ??
    fail("UNAUTHENTICATED", "登录已失效，请重新登录，或以游客入座", 401)
  );
}
async function avatarFor(userId: string) {
  return (
    (
      await store.transaction((tx) =>
        tx.one("SELECT avatar_id FROM social_profiles WHERE user_id=?", [
          userId,
        ]),
      )
    )?.avatar_id ?? DEFAULT_AVATAR
  );
}
function current(userId: string) {
  return (
    [...rooms.values()].find(
      (r) =>
        ["WAITING", "PLAYING"].includes(r.status) &&
        r.slots.some((m) => m?.userId === userId),
    ) ?? null
  );
}
function roomFor(roomId: string, userId: string): Room {
  const r = rooms.get(roomId) ?? fail("NOT_FOUND", "房间不存在", 404);
  if (!r.slots.some((m) => m?.userId === userId))
    fail("FORBIDDEN", "你不是这个房间的成员", 403);
  return structuredClone(r);
}
async function gameFor(
  matchId: string,
  userId: string,
): Promise<{ g: GameState; s: Seat }> {
  let g = games.get(matchId);
  if (!g) {
    const summary = await store.summary(matchId, userId);
    if (!summary) fail("FORBIDDEN", "你不是这场比赛的参与者", 403);
    g = (await store.get<GameState>("match", matchId)) ?? undefined;
  }
  if (!g) return fail("NOT_FOUND", "比赛不存在", 404);
  g = normalizeGame(g);
  const s = g.players.findIndex((p) => p.userId === userId);
  if (s < 0) fail("FORBIDDEN", "你不是这场比赛的参与者", 403);
  return { g: structuredClone(g), s: s as Seat };
}
function roomChanged(r: Room) {
  r.roomVersion++;
  r.roomViewSeq++;
}
function clearReady(r: Room) {
  for (const m of r.slots) if (m?.participantKind === "HUMAN") m.ready = false;
}
function frames(g: GameState): Frame[] {
  return SEATS.map((s) => {
    const state = project(g, s),
      hash = sha(canonical({ state, epoch: g.serverEpoch }));
    if (g.viewHashes[s] !== hash) {
      g.viewHashes[s] = hash;
      g.viewSeq[s]++;
    }
    return {
      protocolVersion: PROTOCOL,
      serverTime: Date.now(),
      matchId: g.matchId,
      serverEpoch: g.serverEpoch,
      streamId: g.streamIds[s],
      viewSeq: g.viewSeq[s],
      syncId: null,
      state,
    };
  });
}
function clock(g: GameState) {
  if (g.window && !clocks.has(g.window.windowId))
    clocks.set(
      g.window.windowId,
      performance.now() + Math.max(0, g.window.deadlineAt - Date.now()),
    );
}
const http = createServer(app);
const io = new Server(http, {
  maxHttpBufferSize: 16384,
  allowRequest: (req, cb) =>
    cb(
      null,
      originOK(req.headers.origin, req.headers.host) ||
        (!req.headers.origin &&
          req.headers["sec-fetch-site"] === "same-origin"),
    ),
  serveClient: false,
});
const ns = io.of("/game");
let staged: { writes: Write[]; effects: (() => void)[] } | null = null;
async function save(g: GameState | null, r: Room | null, extra: Write[] = []) {
  const writes = [...extra];
  let fs: Frame[] = [];
  if (g) {
    if (g.status !== "ABORTED") assertInvariants(g);
    const summary = summarize(g);
    if (summary) writes.push({ kind: "history", id: g.matchId, data: summary });
    fs = frames(g);
    writes.push(
      { kind: "match", id: g.matchId, data: g },
      ...fs.map((f) => ({
        kind: "outbox",
        id: `${g.matchId}:${f.state.viewerSeat}`,
        data: f,
      })),
    );
    if (!r) {
      const old = rooms.get(g.roomId);
      if (
        old &&
        old.matchId === g.matchId &&
        g.status !== "RUNNING" &&
        old.status === "PLAYING"
      ) {
        r = structuredClone(old);
        r.status = g.status === "FINISHED" ? "FINISHED" : "ABORTED";
        roomChanged(r);
      }
    }
  }
  if (r) writes.push({ kind: "room", id: r.roomId, data: r });
  const effect = () => {
    if (r) {
      rooms.set(r.roomId, r);
      if (typeof social !== "undefined") social.roomPresenceChanged(r);
      for (const connection of ns.sockets.values())
        if (
          connection.rooms.has(`room:${r.roomId}`) &&
          auth.resolveHash(connection.data.sessionHash)
        )
          connection.emit("room:view", r);
    }
    if (g) {
      games.set(g.matchId, g);
      clock(g);
      if (
        g.status === "ABORTED" ||
        (g.status === "FINISHED" && g.phase === "MATCH_RESULT")
      )
        games.delete(g.matchId);
      for (const f of fs) {
        const p = g.players[f.state.viewerSeat];
        if (!p.userId) continue;
        const b = bindings.get(p.userId);
        if (
          b &&
          auth.resolveHash(b.sessionHash) &&
          subscriptions.get(b.socketId) === g.matchId
        )
          ns.sockets.get(b.socketId)?.emit("game:view", f);
      }
    }
  };
  if (staged) {
    staged.writes.push(...writes);
    staged.effects.push(effect);
    return;
  }
  await store.commit(writes);
  effect();
}
const authSettings = authConfig();
if (!authSettings.requestSecret) {
  if (process.env.NODE_ENV === "production")
    throw Error("Production requires SESSION_SECRET");
  const secretFile = resolve(
    dirname(process.env.SQLITE_PATH ?? resolve(root, "data/mahjong.sqlite")),
    "auth-local-secret",
  );
  mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 });
  if (!existsSync(secretFile))
    writeFileSync(secretFile, randomBytes(32).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  chmodSync(secretFile, 0o600);
  authSettings.requestSecret = readFileSync(secretFile, "utf8");
}
const auth = new AuthService(store, authSettings, {
  serialize: enqueue,
  assertReleased(session) {
    const b = bindings.get(session.userId);
    if (b?.sessionHash === session.tokenHash && current(session.userId))
      throw new AuthError(
        "CONTROL_RELEASE_REQUIRED",
        "请先明确托管并退出牌桌控制，或离开准备厅",
        409,
      );
  },
  invalidate: async (hashes) => {
    for (const hash of hashes) await releaseAuthContext(hash, true);
    if (typeof social !== "undefined") social.revoked();
  },
});
console.log(
  JSON.stringify({ event: "AUTH_MIGRATION", ...(await auth.initialize()) }),
);
const social = new SocialService(store, auth, {
  serialize: enqueue,
  connected: (id) => bindings.has(id),
  roomChanged: (r) => {
    rooms.set(r.roomId, r);
    for (const socket of ns.sockets.values())
      if (
        socket.rooms.has(`room:${r.roomId}`) &&
        auth.resolveHash(socket.data.sessionHash)
      )
        socket.emit("room:view", r);
  },
  reloadRooms: async () => {
    rooms.clear();
    for (const row of await store.list<Room>("room"))
      rooms.set(row.id, normalizeRoom(row.data));
  },
  notify: (id, data) => {
    if (
      process.env.SOCIAL_PUSH_ENABLED === "false" ||
      process.env.SOCIAL_PUSH_ENABLED === "0"
    )
      return;
    for (const socket of ns.sockets.values()) {
      const identity = auth.resolveHash(socket.data.sessionHash);
      if (identity?.kind === "ACCOUNT" && identity.userId === id)
        socket.emit("social:changed", data);
    }
  },
});
store.roomWriteHook = (tx, r) => social.reconcileRoom(tx, r);
app.use((req, _res, next) => {
  const hash = rawSessionHash(req);
  if (hash) void social.touch(hash).catch(() => {});
  next();
});
mountSocialRoutes(app, social, rawSessionHash, errorData);

const socialTimer = setInterval(() => {
  void social.presenceTick().catch(() => {});
}, 3000);
socialTimer.unref();
const socialCleanup = setInterval(() => {
  void social.cleanup(Number(process.env.SOCIAL_CLEANUP_BATCH??100)).catch(() => {});
}, 3600000);
socialCleanup.unref();
const mailQueue = new MailQueue(auth);
mailQueue.start();
function rawSessionHash(req: Request) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  return raw ? digest(raw) : null;
}
function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: process.env.SESSION_COOKIE_PATH ?? "/",
    maxAge: 30 * 86400000,
  };
}
async function releaseAuthContext(hash: string, forced: boolean) {
  const identity = auth.sessions.get(hash);
  if (!identity) return;
  const b = bindings.get(identity.userId);
  const owns = b?.sessionHash === hash;
  if (owns) {
    // Revoked sessions are already rejected by every action. Keep the binding
    // until the AI/presence update commits so expiry recovery can retry on failure.
    const forgetBinding = () => {
      if (bindings.get(identity.userId)?.bindingId === b.bindingId)
        bindings.delete(identity.userId);
      subscriptions.delete(b.socketId);
    };
    const r = current(identity.userId);
    if (r) {
      const changed = structuredClone(r),
        m = changed.slots.find((m) => m?.userId === identity.userId);
      if (m) m.connected = false;
      changed.presenceVersion++;
      changed.roomViewSeq++;
      if (r.matchId) {
        const { g, s } = await gameFor(r.matchId, identity.userId);
        if (g.status === "RUNNING") {
          g.players[s].desiredControl = "AI";
          g.players[s].connected = false;
          const d = g.decisions[s];
          if (d?.owner === "HUMAN" && !d.choice) d.blocked = true;
          log(g, "CONTROL_CHANGED", {
            seat: s,
            mode: "AI",
            reason: forced ? "SESSION_REVOKED" : "IDENTITY_RELEASE",
          });
          await save(g, changed);
        }
      } else if (!forced) {
        removeMember(changed, identity.userId);
        roomChanged(changed);
        await save(null, changed);
      } else {
        if (changed.isRematchLobby)
          changed.offlineSince[identity.userId] = Date.now();
        await save(null, changed);
      }
    }
    if (staged && !forced) staged.effects.push(forgetBinding);
    else forgetBinding();
  }
  const notify = () => {
    for (const connection of ns.sockets.values())
      if (connection.data.sessionHash === hash) {
        subscriptions.delete(connection.id);
        connection.emit("server:notice", {
          code: forced ? "SESSION_REVOKED" : "AUTH_CONTEXT_RELEASED",
          message: forced
            ? "登录状态已失效，请重新登录"
            : "已退出牌桌控制，可继续身份操作",
        });
        if (forced) connection.disconnect(true);
        else
          for (const room of [...connection.rooms])
            if (room !== connection.id) void connection.leave(room);
      }
  };
  if (staged && !forced) staged.effects.push(notify);
  else notify();
}
mountAuthRoutes({
  app,
  auth,
  user,
  rawSessionHash,
  cookieName,
  cookieOptions,
  release: async (req, res) =>
    mutation(req, res, async (session) => {
      await releaseAuthContext(session.tokenHash, false);
      return { released: true };
    }),
  errorData,
});
for (const r of rooms.values()) {
  for (const m of r.slots)
    if (m?.participantKind === "HUMAN") {
      m.connected = false;
      if (r.isRematchLobby && r.status === "WAITING")
        r.offlineSince[m.userId!] ??= Date.now();
    }
  await store.commit([{ kind: "room", id: r.roomId, data: r }]);
}
for (const source of games.values()) {
  if (source.status !== "RUNNING") continue;
  try {
    normalizeGame(source);
    recoverable(source);
  } catch (e) {
    const reason = (e as Error).message;
    await store.commit([
      { kind: "quarantine", id: source.matchId, data: source },
    ]);
    if (
      !Array.isArray(source.players) ||
      source.players.length !== 4 ||
      !["EAST_ONLY", "HANCHAN"].includes(source.format) ||
      !["1.0", "2.0"].includes(source.protocolVersion)
    ) {
      const r = rooms.get(source.roomId);
      if (r) {
        r.status = "ABORTED";
        roomChanged(r);
      }
      await store.migrationIssue(source.matchId, reason);
      await store.commit([
        {
          kind: "match",
          id: source.matchId,
          data: { ...source, status: "ABORTED", phase: "MATCH_ABORTED" },
        },
        ...(r ? [{ kind: "room", id: r.roomId, data: r }] : []),
      ]);
      games.delete(source.matchId);
    } else await save(technicalAbort(source), null);
    console.error(
      JSON.stringify({
        event: "MATCH_ABORTED",
        matchId: source.matchId,
        reason,
      }),
    );
    continue;
  }
  const g = structuredClone(source);
  g.serverEpoch++;
  g.rngState ??= null;
  for (const p of g.players)
    if (p.participantKind === "HUMAN") p.connected = false;
  if (g.window) {
    g.window.windowId = uid();
    g.window.deadlineAt =
      Date.now() + (g.phase === "SELF_ACTION" ? 15000 : 8000);
    for (const s of SEATS) {
      const d = g.decisions[s];
      if (!d || d.choice) continue;
      d.windowId = g.window.windowId;
      d.decisionId = uid();
      d.deadlineAt = g.window.deadlineAt;
      d.options.forEach((o) => (o.optionId = uid()));
      d.blocked = d.owner === "HUMAN";
    }
  }
  if (g.phase === "HAND_RESULT") g.resultDisplayUntil = Date.now() + 8000;
  log(g, "RECOVERED", { serverEpoch: g.serverEpoch });
  await save(g, null);
}
function route(
  method: "get" | "post" | "put" | "delete",
  path: string,
  fn: (req: Request, res: Response) => Promise<unknown>,
) {
  app[method]("/api/v2" + path, (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      if (
        !(e instanceof BusinessError) &&
        !(e instanceof AuthError) &&
        !(e instanceof z.ZodError)
      )
        console.error(
          JSON.stringify({ event: "HTTP_ERROR", message: e.message }),
        );
      res
        .status(
          e instanceof BusinessError || e instanceof AuthError
            ? e.status
            : e instanceof z.ZodError
              ? 400
              : 503,
        )
        .json({ error: errorData(e) });
    });
  });
}
async function mutation(
  req: Request,
  res: Response,
  fn: (u: Session) => Promise<unknown>,
) {
  const u = user(req),
    key = parse(uuid, req.headers["idempotency-key"]),
    dedup = `${u.userId}:${key}`,
    hash = sha(
      canonical({
        method: req.method,
        path: req.path,
        body: req.body ?? null,
        version: req.headers["expectedroomversion"] ?? null,
        generation: req.headers["lobby-generation"] ?? null,
      }),
    );
  return enqueue(async () => {
    const currentUser = user(req);
    const prior =
      httpReceipts.get(dedup) ?? (await store.get<HttpReceipt>("http", dedup));
    if (prior) {
      if (prior.hash !== hash)
        fail("REQUEST_ID_CONFLICT", "这项操作已经提交过了");
      return res.status(prior.status).json({ data: prior.data });
    }
    staged = { writes: [], effects: [] };
    try {
      const result = await fn(currentUser);
      const record: HttpReceipt = { hash, status: 200, data: result };
      const tx = staged;
      staged = null;
      await store.commit([
        ...tx.writes,
        { kind: "http", id: dedup, data: record },
      ]);
      tx.effects.forEach((f) => f());
      httpReceipts.set(dedup, record);
      res.json({ data: result });
    } finally {
      staged = null;
    }
  });
}
route("post", "/sessions/guest", async (req, res) => {
  const existing = sessionFrom(req.headers.cookie);
  if (existing) {
    res.json({
      data: {
        userId: existing.userId,
        displayName: existing.displayName,
        identityKind: existing.kind,
        maskedEmail: existing.maskedEmail,
      },
    });
    return;
  }
  const { displayName } = parse(
    z.object({ displayName: z.string().trim().min(1).max(16) }).strict(),
    req.body,
  );
  limited(`guest:${req.ip}`, 60);
  const result = await auth.createGuest(
    displayName,
    parse(uuid, req.headers["idempotency-key"]),
  );
  res.cookie(cookieName, result.token, cookieOptions());
  res.json({
    data: {
      userId: result.identity.userId,
      displayName: result.identity.displayName,
      identityKind: result.identity.kind,
      maskedEmail: null,
    },
  });
});
route("get", "/me", async (req, res) => {
  const u = user(req),
    r = current(u.userId);
  res.json({
    data: {
      userId: u.userId,
      displayName: u.displayName,
      identityKind: u.kind,
      avatarId: await avatarFor(u.userId),
      maskedEmail: u.maskedEmail,
      roomId: r?.roomId ?? null,
      matchId: r?.matchId ?? null,
    },
  });
});
route("post", "/rooms", async (req, res) =>
  mutation(req, res, async (u) => {
    parse(
      z
        .object({
          format: z.enum(["EAST_ONLY", "HANCHAN"]),
          rulesetId: z.literal(RULESET),
          timePresetId: z.literal("standard-v1"),
        })
        .strict(),
      req.body,
    );
    const active = current(u.userId);
    if (active) return active;
    let inviteCode: string;
    do {
      inviteCode = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    } while ([...rooms.values()].some((r) => r.inviteCode === inviteCode));
    const member: Member = {
      memberId: uid(),
      userId: u.userId,
      displayName: u.displayName,
      avatarId: await avatarFor(u.userId),
      participantKind: "HUMAN",
      ready: false,
      connected: bindings.has(u.userId),
      botLevel: null,
    };
    const r: Room = {
      roomId: uid(),
      lobbyGeneration: 1,
      previousMatchIds: [],
      isRematchLobby: false,
      memberJoinOrder: [member.memberId],
      offlineSince: {},
      inviteCode,
      status: "WAITING",
      roomVersion: 1,
      presenceVersion: 1,
      roomViewSeq: 1,
      hostUserId: u.userId,
      config: req.body,
      slots: [member, null, null, null],
      matchId: null,
    };
    await save(null, r);
    return r;
  }),
);
route("post", "/rooms/join", async (req, res) =>
  mutation(req, res, async (u) => {
    const { inviteCode } = parse(
      z
        .object({
          inviteCode: z
            .string()
            .trim()
            .length(6)
            .transform((x) => x.toUpperCase()),
        })
        .strict(),
      req.body,
    );
    const old =
      [...rooms.values()].find((r) => r.inviteCode === inviteCode) ??
      fail("NOT_FOUND", "邀请码无效", 404);
    const active = current(u.userId);
    if (active) {
      if (active.roomId === old.roomId) return active;
      fail("ALREADY_IN_ROOM", "你还在另一张牌桌上，请先回去或离开");
    }
    if (old.status !== "WAITING") fail("ROOM_STARTED", "这一桌已经开局或散了");
    const r = structuredClone(old);
    const slot = r.slots.indexOf(null);
    if (slot < 0) fail("ROOM_FULL", "房间已满");
    r.slots[slot] = {
      memberId: uid(),
      userId: u.userId,
      displayName: u.displayName,
      avatarId: await avatarFor(u.userId),
      participantKind: "HUMAN",
      ready: false,
      connected: bindings.has(u.userId),
      botLevel: null,
    };
    r.memberJoinOrder.push(r.slots[slot]!.memberId);
    if (r.isRematchLobby && !r.slots[slot]!.connected)
      r.offlineSince[u.userId] = Date.now();
    clearReady(r);
    roomChanged(r);
    await save(null, r);
    return r;
  }),
);
route("get", "/rooms/:roomId", async (req, res) => {
  res.json({ data: roomFor(String(req.params.roomId), user(req).userId) });
});
function generation(r: Room, value: unknown) {
  try {
    checkGeneration(r, value);
  } catch {
    fail("LOBBY_GENERATION_CONFLICT", "牌桌有变，请重新查看");
  }
}
function waiting(req: Request, u: Session, host = false) {
  const r = roomFor(String(req.params.roomId), u.userId);
  if (r.status !== "WAITING") fail("ROOM_STARTED", "这一桌已经开局或散了");
  if (host && r.hostUserId !== u.userId)
    fail("FORBIDDEN", "只有房主可以操作", 403);
  generation(
    r,
    req.method === "DELETE"
      ? Number(req.headers["lobby-generation"])
      : req.body?.lobbyGeneration,
  );
  const version =
    req.method === "DELETE"
      ? Number(req.headers.expectedroomversion)
      : req.body?.expectedRoomVersion;
  if (!Number.isInteger(version) || version !== r.roomVersion)
    fail("ROOM_VERSION_CONFLICT", "房间已更新，请重试");
  return r;
}
route("put", "/rooms/:roomId/ready", async (req, res) =>
  mutation(req, res, async (u) => {
    const { ready } = parse(
      z
        .object({
          ready: z.boolean(),
          expectedRoomVersion: z.number().int(),
          lobbyGeneration: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    const r = waiting(req, u);
    r.slots.find((m) => m?.userId === u.userId)!.ready = ready;
    roomChanged(r);
    await save(null, r);
    return r;
  }),
);
route("put", "/rooms/:roomId/slots/:slotId/bot", async (req, res) =>
  mutation(req, res, async (u) => {
    parse(
      z
        .object({
          botLevel: z.enum(BOT_LEVELS as [BotLevel, ...BotLevel[]]),
          expectedRoomVersion: z.number().int(),
          lobbyGeneration: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    const r = waiting(req, u, true);
    const slot = parse(
      z.coerce.number().int().min(0).max(3),
      req.params.slotId,
    );
    if (r.slots[slot]?.participantKind === "HUMAN")
      fail("SLOT_OCCUPIED", "这个座位已有人");
    r.slots[slot] = {
      memberId: uid(),
      userId: null,
      displayName: ["松风", "竹影", "白露", "秋山"][slot],
      participantKind: "BOT",
      ready: true,
      connected: true,
      botLevel: req.body.botLevel,
      botPolicyVersion: BOT_POLICY_VERSION,
    };
    clearReady(r);
    roomChanged(r);
    await save(null, r);
    return r;
  }),
);
route("delete", "/rooms/:roomId/slots/:slotId/bot", async (req, res) =>
  mutation(req, res, async (u) => {
    const r = waiting(req, u, true),
      slot = parse(z.coerce.number().int().min(0).max(3), req.params.slotId);
    if (r.slots[slot]?.participantKind !== "BOT")
      fail("FORBIDDEN", "只能请离 AI", 403);
    r.slots[slot] = null;
    clearReady(r);
    roomChanged(r);
    await save(null, r);
    return r;
  }),
);
route("post", "/rooms/:roomId/start", async (req, res) =>
  mutation(req, res, async (u) => {
    parse(
      z
        .object({
          expectedRoomVersion: z.number().int(),
          lobbyGeneration: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    const r = roomFor(String(req.params.roomId), u.userId);
    if (r.hostUserId !== u.userId) fail("FORBIDDEN", "只有房主可以开始", 403);
    generation(r, req.body.lobbyGeneration);
    if (maintenance()) fail("MAINTENANCE", "维护中，暂不开新桌", 503);
    if (r.matchId) return { matchId: r.matchId };
    if (r.roomVersion !== req.body.expectedRoomVersion)
      fail("ROOM_VERSION_CONFLICT", "房间已更新");
    if (r.status !== "WAITING" || r.slots.some((m) => !m || !m.ready))
      fail("ROOM_NOT_READY", "四个座位坐满、众人准备后才能开局");
    const members = structuredClone(r.slots) as [
      Member,
      Member,
      Member,
      Member,
    ];
    for (let i = 3; i > 0; i--) {
      const j = randomInt(i + 1);
      [members[i], members[j]] = [members[j], members[i]];
    }
    const g = createGame(
      r.roomId,
      members,
      undefined,
      Date.now(),
      null,
      r.config.format,
    );
    r.matchId = g.matchId;
    r.status = "PLAYING";
    roomChanged(r);
    await save(g, r);
    return { matchId: g.matchId };
  }),
);
route("post", "/rooms/:roomId/leave", async (req, res) =>
  mutation(req, res, async (u) => {
    const r = roomFor(String(req.params.roomId), u.userId);
    generation(r, req.body?.lobbyGeneration);
    if (r.status === "PLAYING") {
      const { g, s } = await gameFor(r.matchId!, u.userId);
      g.players[s].desiredControl = "AI";
      log(g, "CONTROL_CHANGED", { seat: s, mode: "AI" });
      await save(g, null);
      return { left: true };
    }
    if (r.status === "WAITING") {
      removeMember(r, u.userId);
      roomChanged(r);
      // End the departing member's subscription in the same commit's effects.
      staged!.effects.push(() => {
        for (const connection of ns.sockets.values()) {
          if (connection.data.user?.userId === u.userId)
            void connection.leave(`room:${r.roomId}`);
        }
      });
      await save(null, r);
    }
    return { left: true };
  }),
);
route("get", "/matches/:matchId/requests/:requestId", async (req, res) => {
  const u = user(req);
  await gameFor(String(req.params.matchId), u.userId);
  const receiptKey = `${req.params.matchId}:${u.userId}:${req.params.requestId}`;
  const x =
    receipts.get(receiptKey) ??
    (await store.get<SavedReceipt>("receipt", receiptKey));
  if (!x) fail("NOT_FOUND", "还没找到这一手的记录", 404);
  res.json({ data: x!.receipt });
});
route("get", "/matches/:matchId/replay", async (req, res) => {
  const { g } = await gameFor(String(req.params.matchId), user(req).userId);
  if (g.status !== "FINISHED")
    fail("REPLAY_NOT_AVAILABLE", "打完一整场后才能看牌谱", 403);
  res.json({
    data: {
      replayVersion: g.protocolVersion === "1.0" ? "1.0" : "2.0",
      protocolVersion: g.protocolVersion,
      rulesetId: RULESET,
      format: g.format,
      mode: g.mode,
      timePresetId: "standard-v1",
      matchId: g.matchId,
      players: g.players.map((p) => ({
        seat: p.seat,
        displayName: p.displayName,
        avatarId: p.avatarId,
        participantKind: p.participantKind,
        botLevel: p.botLevel,
        botPolicyVersion: p.botPolicyVersion ?? null,
      })),
      events: g.events,
      result: g.matchResult,
    },
  });
});
function maintenance() {
  return (
    process.env.MAINTENANCE === "1" ||
    (!!process.env.MAINTENANCE_FILE && existsSync(process.env.MAINTENANCE_FILE))
  );
}
route("get", "/capabilities", async (_req, res) => {
  res.json({
    data: {
      appVersion: APP_VERSION,
      buildId: release.sourceSha256,
      protocolVersion: PROTOCOL,
      formats: ["EAST_ONLY", "HANCHAN"],
      botLevels: BOT_LEVELS,
      autopilotBotLevel: AUTOPILOT_BOT_LEVEL,
      timePresetId: "standard-v1",
      maintenance: maintenance(),
      retentionDays: 30,
      auth: auth.capabilities(),
      ...social.capabilities(),
    },
  });
});
route("put", "/rooms/:roomId/config", async (req, res) =>
  mutation(req, res, async (u) => {
    const body = parse(
      z
        .object({
          format: z.enum(["EAST_ONLY", "HANCHAN"]),
          expectedRoomVersion: z.number().int(),
          lobbyGeneration: z.number().int(),
        })
        .strict(),
      req.body,
    );
    const r = waiting(req, u, true);
    r.config.format = body.format;
    clearReady(r);
    roomChanged(r);
    await save(null, r);
    return r;
  }),
);
route("post", "/rooms/:roomId/rematch", async (req, res) =>
  mutation(req, res, async (u) => {
    parse(
      z
        .object({
          expectedRoomVersion: z.number().int(),
          lobbyGeneration: z.number().int(),
        })
        .strict(),
      req.body,
    );
    const r = roomFor(String(req.params.roomId), u.userId);
    generation(r, req.body.lobbyGeneration);
    if (r.hostUserId !== u.userId) fail("FORBIDDEN", "只有房主可以再开一场", 403);
    if (r.roomVersion !== req.body.expectedRoomVersion)
      fail("ROOM_VERSION_CONFLICT", "房间已更新");
    if (
      !r.matchId ||
      (await gameFor(r.matchId, u.userId)).g.phase !== "MATCH_RESULT"
    )
      fail("REMATCH_NOT_AVAILABLE", "请稍候，结算还在展示");
    for (const m of r.slots)
      if (m?.userId) {
        const active = current(m.userId);
        if (active && active.roomId !== r.roomId)
          fail(
            "ALREADY_IN_ROOM",
            "同桌成员已有其他未结束的房间，请先结束或离开",
          );
      }
    for (const m of r.slots)
      if (m?.userId) {
        m.connected = bindings.has(m.userId);
        m.displayName =
          auth.profiles.get(m.userId)?.displayName ?? m.displayName;
        m.avatarId = await avatarFor(m.userId);
      }
    try {
      openRematch(r);
    } catch {
      fail("REMATCH_NOT_AVAILABLE", "只有正常打完的牌桌才能再来一场");
    }
    roomChanged(r);
    staged!.effects.push(() => {
      for (const m of r.slots)
        if (m?.userId) {
          const binding = bindings.get(m.userId);
          if (binding) subscriptions.delete(binding.socketId);
        }
    });
    await save(null, r);
    return r;
  }),
);
const historyFilter = z
  .object({
    format: z.enum(["EAST_ONLY", "HANCHAN"]).optional(),
    mode: z.enum(["AI_PRACTICE", "FRIENDS"]).optional(),
    cursor: z.string().max(1024).optional(),
  })
  .strict();
route("get", "/history", async (req, res) => {
  const u = user(req),
    filter = parse(historyFilter, req.query);
  let cursor;
  try {
    cursor = decodeCursor(filter.cursor);
  } catch {
    fail("INVALID_PAYLOAD", "历史页码无效", 400);
  }
  const page = await store.history(u.userId, { ...filter, cursor });
  res.json({
    data: { ...page, items: page.items.map((s) => publicSummary(s, u.userId)) },
  });
});
route("get", "/stats", async (req, res) => {
  const u = user(req),
    f = parse(
      z
        .object({
          format: z.enum(["EAST_ONLY", "HANCHAN"]).optional(),
          mode: z.enum(["AI_PRACTICE", "FRIENDS"]).optional(),
          days: z.coerce.number().int().min(1).max(30).default(30),
        })
        .strict(),
      req.query,
    );
  const to = Date.now();
  res.json({
    data: await store.stats(u.userId, {
      ...f,
      from: to - f.days * 86400000,
      to,
    }),
  });
});
route("get", "/matches/:matchId", async (req, res) => {
  const u = user(req);
  const summary = await store.summary(String(req.params.matchId), u.userId);
  if (!summary) fail("FORBIDDEN", "无法查看这场比赛", 403);
  res.json({ data: publicSummary(summary!, u.userId) });
});
route("get", "/matches/:matchId/replay-position", async (req, res) => {
  const u = user(req);
  const summary = await store.summary(String(req.params.matchId), u.userId);
  if (!summary || !summary.replayAvailable)
    fail("REPLAY_NOT_AVAILABLE", "牌谱不可用", 403);
  res.json({ data: await store.position(u.userId, summary!.matchId) });
});
route("put", "/matches/:matchId/replay-position", async (req, res) =>
  mutation(req, res, async (u) => {
    const p = parse(
      z
        .object({
          handId: id,
          eventIndex: z.number().int().nonnegative(),
          viewerSeat: z.number().int().min(0).max(3),
        })
        .strict(),
      req.body,
    );
    const { g } = await gameFor(String(req.params.matchId), u.userId);
    if (g.status !== "FINISHED" || g.events[p.eventIndex]?.handId !== p.handId)
      fail("REPLAY_POSITION_INVALID", "上次看到的地方找不到了，请从局首看起", 400);
    const data = { ...p, updatedAt: Date.now() };
    staged!.writes.push({
      kind: "replay_position",
      id: u.userId + ":" + g.matchId,
      data: { userId: u.userId, matchId: g.matchId, position: data },
    });
    return data;
  }),
);
route("post", "/diagnostics", async (req, res) => {
  const u = user(req);
  const p = parse(
    z
      .object({
        roomId: id.nullable().optional(),
        matchId: id.nullable().optional(),
      })
      .strict(),
    req.body,
  );
  let g: GameState | undefined, seat: Seat | undefined;
  if (p.roomId) roomFor(p.roomId, u.userId);
  if (p.matchId) {
    const found = await gameFor(p.matchId, u.userId);
    g = found.g;
    seat = found.s;
  }
  const diagnostic = {
    diagnosticId: uid(),
    appVersion: APP_VERSION,
    protocolVersion: PROTOCOL,
    rulesetId: RULESET,
    roomId: g?.roomId ?? p.roomId ?? null,
    matchId: g?.matchId ?? null,
    handId: g?.handId ?? null,
    phase: g?.phase ?? null,
    viewSeq: g && seat !== undefined ? g.viewSeq[seat] : null,
    serverEpoch: g?.serverEpoch ?? null,
    serverTime: Date.now(),
  };
  console.log(JSON.stringify({ event: "DIAGNOSTIC", ...diagnostic }));
  await store.commit([
    { kind: "diagnostic", id: diagnostic.diagnosticId, data: diagnostic },
  ]);
  res.json({ data: diagnostic });
});
app.use("/api/v1", (_req, res) =>
  res.status(426).json({
    error: {
      code: "PROTOCOL_UNSUPPORTED",
      message: "游戏已升级，请刷新页面",
      retryable: false,
    },
  }),
);
route("get", "/rules", async (_req, res) => {
  res.json({
    data: readFileSync(resolve(root, "docs/玩家说明.md"), "utf8"),
  });
});
app.get("/healthz", async (_req, res) => {
  try {
    await store.list("health");
    res.json({
      ok: true,
      version: APP_VERSION,
      buildId: release.sourceSha256,
      activeTables: [...games.values()].filter((g) => g.status === "RUNNING")
        .length,
    });
  } catch {
    res.status(503).json({ ok: false });
  }
});
function socketUser(socket: Socket): Session {
  return (
    auth.resolveHash(socket.data.sessionHash) ??
    fail("UNAUTHENTICATED", "登录状态已失效，请重新登录", 401)
  );
}
function ensureBinding(socket: Socket, bindingId?: string) {
  const b = bindings.get(socketUser(socket).userId);
  if (
    !b ||
    b.socketId !== socket.id ||
    (bindingId !== undefined && b.bindingId !== bindingId)
  )
    fail("CONTROL_REVOKED", errors.CONTROL_REVOKED);
  return b;
}
ns.use((socket, next) => {
  try {
    if (socket.handshake.auth.protocolVersion !== PROTOCOL)
      fail("PROTOCOL_UNSUPPORTED", "请刷新页面更新客户端");
    const u = sessionFrom(socket.handshake.headers.cookie);
    if (!u)
      return next(
        Object.assign(new Error("登录状态已失效，请重新登录"), {
          data: { code: "UNAUTHENTICATED" },
        }),
      );
    socket.data.user = u;
    socket.data.sessionHash = u.tokenHash;
    next();
  } catch (e) {
    const er = new Error(errorData(e).message);
    Object.assign(er, { data: errorData(e) });
    next(er);
  }
});
function on<T>(
  socket: Socket,
  event: string,
  schema: z.ZodType<T>,
  handler: (p: T, requestId: string, received: number) => Promise<unknown>,
) {
  socket.on(event, (message, ack) => {
    const received = performance.now();
    Promise.resolve()
      .then(() => {
        limited(`socket:${socketUser(socket).userId}`, 600);
        const b = parse(base, message);
        return handler(parse(schema, b.payload), b.requestId, received);
      })
      .then((data) => {
        if (typeof ack === "function")
          ack({ ok: true, requestId: message?.requestId, data });
      })
      .catch((e) => {
        if (typeof ack === "function")
          ack({
            ok: false,
            requestId: message?.requestId,
            error: errorData(e),
          });
        else socket.emit("server:notice", errorData(e));
      });
  });
}
const scheduleGame = enqueue;
ns.on("connection", (socket) => {
  const enqueue = <T>(fn: () => Promise<T>) =>
    scheduleGame(async () => {
      socketUser(socket);
      return fn();
    });
  const u = socketUser(socket);
  social.connect(socket.id, u);
  socket.emit("server:hello", {
    protocolVersion: PROTOCOL,
    connectionId: socket.id,
    serverTime: Date.now(),
    authenticatedUserId: u.userId,
    supportedRulesetIds: [RULESET],
  });
  on(
    socket,
    "session:claim",
    z.object({ takeover: z.boolean() }).strict(),
    async (p) =>
      enqueue(async () => {
        const old = bindings.get(u.userId);
        if (old?.socketId === socket.id) return { bindingId: old.bindingId };
        if (old && !p.takeover) fail("CONTROL_IN_USE", errors.CONTROL_IN_USE);
        const binding = {
          socketId: socket.id,
          bindingId: uid(),
          sessionHash: u.tokenHash,
        };
        const r = current(u.userId);
        if (r) {
          const updated = structuredClone(r);
          updated.slots.find((m) => m?.userId === u.userId)!.connected = true;
          delete updated.offlineSince[u.userId];
          updated.presenceVersion++;
          updated.roomViewSeq++;
          if (r.matchId) {
            const { g, s } = await gameFor(r.matchId, u.userId);
            g.players[s].connected = true;
            await save(g, updated);
          } else await save(null, updated);
        }
        if (old) {
          subscriptions.delete(old.socketId);
          ns.sockets.get(old.socketId)?.emit("server:notice", {
            code: "CONTROL_REVOKED",
            message: errors.CONTROL_REVOKED,
          });
        }
        bindings.set(u.userId, binding);
        return { bindingId: binding.bindingId };
      }),
  );
  on(socket, "room:watch", z.object({ roomId: id }).strict(), async (p) =>
    enqueue(async () => {
      const r = roomFor(p.roomId, u.userId);
      await socket.join(`room:${r.roomId}`);
      socket.emit("room:view", r);
      return r;
    }),
  );
  on(
    socket,
    "game:attach",
    z
      .object({
        matchId: id,
        bindingId: id,
        lastStreamId: id.nullable(),
        lastViewSeq: z.number().nullable(),
      })
      .strict(),
    async (p, requestId) =>
      enqueue(async () => {
        ensureBinding(socket, p.bindingId);
        const { g, s } = await gameFor(p.matchId, u.userId);
        subscriptions.set(socket.id, g.matchId);
        const frame = frames(g)[s];
        frame.syncId = requestId;
        socket.emit("game:view", frame);
        return { attached: true };
      }),
  );
  on(
    socket,
    "game:sync",
    z.object({ matchId: id, syncId: id }).strict(),
    async (p) =>
      enqueue(async () => {
        ensureBinding(socket);
        const { g, s } = await gameFor(p.matchId, u.userId);
        if (subscriptions.get(socket.id) !== p.matchId)
          fail("FORBIDDEN", "请先连上牌桌", 403);
        const f = frames(g)[s];
        f.syncId = p.syncId;
        socket.emit("game:view", f);
        return { synced: true };
      }),
  );
  on(socket, "game:action", actionSchema, async (p, requestId, received) =>
    enqueue(async () => {
      ensureBinding(socket, p.bindingId);
      const { g, s } = await gameFor(p.matchId, u.userId);
      const receipt = await actionTransaction(
        g,
        s,
        u.userId,
        requestId,
        p,
        received,
        false,
      );
      socket.emit("game:receipt", receipt);
      return receipt;
    }),
  );
  on(
    socket,
    "game:control",
    z
      .object({ matchId: id, bindingId: id, mode: z.enum(["HUMAN", "AI"]) })
      .strict(),
    async (p, requestId) =>
      enqueue(async () => {
        ensureBinding(socket, p.bindingId);
        const { g, s } = await gameFor(p.matchId, u.userId);
        const key = `control:${p.matchId}:${u.userId}:${requestId}`,
          hash = sha(canonical({ matchId: p.matchId, mode: p.mode }));
        const prior =
          httpReceipts.get(key) ?? (await store.get<HttpReceipt>("http", key));
        if (prior) {
          if (prior.hash !== hash)
            fail("REQUEST_ID_CONFLICT", errors.REQUEST_ID_CONFLICT);
          return prior.data;
        }
        if (g.status !== "RUNNING")
          fail("MATCH_NOT_RUNNING", "这场已经打完了");
        g.players[s].desiredControl = p.mode;
        log(g, "CONTROL_CHANGED", { seat: s, mode: p.mode });
        const record = { hash, status: 200, data: { mode: p.mode } };
        await save(g, null, [{ kind: "http", id: key, data: record }]);
        httpReceipts.set(key, record);
        return record.data;
      }),
  );
  on(
    socket,
    "time:ping",
    z.object({ clientSentAt: z.number() }).strict(),
    async (p) => ({
      clientSentAt: p.clientSentAt,
      serverReceivedAt: Date.now(),
      serverSentAt: Date.now(),
    }),
  );
  socket.on("disconnect", () => {
    social.disconnect(socket.id);
    scheduleGame(async () => {
      const b = bindings.get(u.userId);
      if (b?.socketId !== socket.id) return;
      bindings.delete(u.userId);
      subscriptions.delete(socket.id);
      const r = current(u.userId);
      if (!r) return;
      const changed = structuredClone(r);
      changed.slots.find((m) => m?.userId === u.userId)!.connected = false;
      if (changed.isRematchLobby && changed.status === "WAITING")
        changed.offlineSince[u.userId] = Date.now();
      changed.presenceVersion++;
      changed.roomViewSeq++;
      if (r.matchId) {
        const { g, s } = await gameFor(r.matchId, u.userId);
        g.players[s].connected = false;
        const d = g.decisions[s];
        if (d?.owner === "HUMAN" && !d.choice) d.blocked = true;
        await save(g, changed);
      } else await save(null, changed);
    }).catch(() => {});
  });
});
async function actionTransaction(
  g: GameState,
  s: Seat,
  actor: string,
  requestId: string,
  p: Action,
  received: number,
  internal: boolean,
): Promise<Receipt> {
  const transactionStart = performance.now();
  const key = `${g.matchId}:${actor}:${requestId}`,
    { bindingId, lastSeenViewSeq, ...logical } = p,
    hash = sha(canonical(logical));
  const previous =
    receipts.get(key) ?? (await store.get<SavedReceipt>("receipt", key));
  if (previous) {
    if (previous.hash !== hash)
      fail("REQUEST_ID_CONFLICT", errors.REQUEST_ID_CONFLICT);
    return previous.receipt;
  }
  const receipt: Receipt = {
    protocolVersion: PROTOCOL,
    serverTime: Date.now(),
    requestId,
    matchId: g.matchId,
    receiptId: uid(),
    status: "REJECTED",
  };
  try {
    const check = (condition: boolean, code: string) => {
      if (!condition) fail(code, errors[code] ?? code);
    };
    check(g.status === "RUNNING", "MATCH_NOT_RUNNING");
    check(p.serverEpoch === g.serverEpoch, "EPOCH_STALE");
    check(p.handId === g.handId, "HAND_MISMATCH");
    check(g.window?.windowId === p.windowId, "WINDOW_EXPIRED");
    const d = g.decisions[s];
    check(!!d && d.decisionId === p.decisionId, "DECISION_NOT_OWNED");
    check(!d!.choice, "DECISION_ALREADY_SUBMITTED");
    check(!d!.blocked || internal, "CONTROL_PENDING");
    check(internal || d!.owner === "HUMAN", "DECISION_NOT_OWNED");
    check(
      internal || received < (clocks.get(p.windowId) ?? -Infinity),
      "WINDOW_EXPIRED",
    );
    check(
      d!.options.some((o) => o.optionId === p.optionId),
      "OPTION_NOT_AVAILABLE",
    );
    receipt.acceptance = apply(g, s, p.optionId, requestId);
    receipt.status = "ACCEPTED";
    receipt.decisionId = p.decisionId;
  } catch (e) {
    if (!(e instanceof BusinessError)) throw e;
    receipt.error = errorData(e);
  }
  const saved = { hash, userId: actor, receipt };
  if (receipt.status === "ACCEPTED")
    await save(g, null, [{ kind: "receipt", id: key, data: saved }]);
  else await store.commit([{ kind: "receipt", id: key, data: saved }]);
  receipts.set(key, saved);
  if (receipt.status === "ACCEPTED") {
    measure("actionCommitMs", transactionStart);
    if (receipt.acceptance === "ACTION_APPLIED")
      measure("resolutionCommitMs", transactionStart);
  }
  return receipt;
}
const interval = setInterval(
  () => {
    for (const r of rooms.values())
      if (
        r.status === "WAITING" &&
        r.isRematchLobby &&
        Object.keys(r.offlineSince).length
      )
        enqueue(async () => {
          const latest = structuredClone(rooms.get(r.roomId)!);
          if (expireOffline(latest)) {
            roomChanged(latest);
            await save(null, latest);
          }
        }).catch(() => {});
    for (const original of games.values()) {
      if (
        original.phase === "HAND_RESULT" &&
        original.resultDisplayUntil !== null &&
        original.resultDisplayUntil <= Date.now()
      ) {
        enqueue(async () => {
          const live = games.get(original.matchId);
          if (!live) return;
          const g = structuredClone(live);
          if (g.phase !== "HAND_RESULT" || g.resultDisplayUntil! > Date.now())
            return;
          advanceResult(g);
          await save(g, null);
        }).catch(() => {});
        continue;
      }
      if (original.status !== "RUNNING" || !original.window) continue;
      for (const s of SEATS) {
        const d = original.decisions[s];
        if (!d || d.choice) continue;
        if (
          performance.now() >=
          (clocks.get(original.window.windowId) ?? Infinity)
        )
          enqueue(async () => {
            const live = games.get(original.matchId);
            if (!live) return;
            const g = structuredClone(live);
            if (
              g.decisions[s]?.decisionId !== d.decisionId ||
              g.decisions[s]?.choice
            )
              return;
            const decision = g.decisions[s]!;
            const p = g.players[s];
            const fallback =
              g.phase === "SELF_ACTION"
                ? (decision.options.find(
                    (o) => o.type === "DISCARD" && o.tile === p.drawn,
                  ) ??
                  decision.options
                    .filter((o) => o.type === "DISCARD")
                    .sort((a, b) => a.tile! - b.tile!)[0])
                : decision.options.find((o) => o.type === "PASS");
            if (!fallback) throw Error("NO_TIMEOUT_OPTION");
            await actionTransaction(
              g,
              s,
              `TIMEOUT:${s}`,
              `timeout:${d.decisionId}`,
              {
                matchId: g.matchId,
                handId: g.handId,
                serverEpoch: g.serverEpoch,
                bindingId: "INTERNAL",
                windowId: g.window!.windowId,
                decisionId: d.decisionId,
                optionId: fallback.optionId,
                lastSeenViewSeq: 0,
              },
              performance.now(),
              true,
            );
          }).catch(() => {});
        else if (d.owner === "AI" && !botPending.has(d.decisionId)) {
          botPending.add(d.decisionId);
          const input = project(original, s);
          const started = performance.now();
          bots
            .choose(input)
            .then(async (optionId) => {
              measure(
                BOT_LEVEL_METRICS[botLevelOf(input)],
                started,
              );
              if (!optionId) return;
              const computeMs = performance.now() - started;
              if (computeMs > 500)
                console.log(
                  JSON.stringify({
                    event: "BOT_SLOW",
                    ms: Math.round(computeMs),
                  }),
                );
              const readyAt = botReadyAt(
                original.window!,
                clocks.get(original.window!.windowId) ?? -Infinity,
                process.env.NODE_ENV === "test" &&
                  process.env.FAST_TEST === "1",
              );
              const remaining = readyAt - performance.now();
              if (remaining > 0) await pause(remaining);
              if (closing) return;
              return enqueue(async () => {
                if (closing) return;
                const live = games.get(original.matchId);
                if (!live) return;
                const g = structuredClone(live);
                if (
                  g.status !== "RUNNING" ||
                  g.decisions[s]?.decisionId !== d.decisionId ||
                  g.decisions[s]?.choice ||
                  g.serverEpoch !== original.serverEpoch
                )
                  return;
                if (
                  performance.now() >=
                  (clocks.get(g.window!.windowId) ?? -Infinity)
                )
                  return;
                const payload: Action = {
                  matchId: g.matchId,
                  handId: g.handId,
                  serverEpoch: g.serverEpoch,
                  bindingId: "INTERNAL",
                  windowId: g.window!.windowId,
                  decisionId: d.decisionId,
                  optionId,
                  lastSeenViewSeq: 0,
                };
                await actionTransaction(
                  g,
                  s,
                  `BOT:${s}`,
                  `bot:${d.decisionId}`,
                  payload,
                  performance.now(),
                  true,
                );
              });
            })
            .catch((e) =>
              console.error(
                JSON.stringify({ event: "BOT_ERROR", message: e.message }),
              ),
            )
            .finally(() => botPending.delete(d.decisionId));
        }
      }
    }
  },
  process.env.NODE_ENV === "test" && process.env.FAST_TEST === "1" ? 10 : 200,
);
const authExpiry = setInterval(() => {
  const expired = new Set(
    [...ns.sockets.values()]
      .filter((socket) => !auth.resolveHash(socket.data.sessionHash))
      .map((socket) => socket.data.sessionHash as string),
  );
  for (const hash of expired)
    void enqueue(() => releaseAuthContext(hash, true)).catch(() => {});
}, 1000);
const cleanup = setInterval(() => {
  flushMetrics();
  void auth.purgeExpiredLimits().catch(() => {});
  for (const cache of [receipts, httpReceipts])
    while (cache.size > 5000) cache.delete(cache.keys().next().value!);
  const activeWindows = new Set(
    [...games.values()].map((g) => g.window?.windowId),
  );
  for (const key of clocks.keys())
    if (!activeWindows.has(key)) clocks.delete(key);
  for (const [key, v] of rate) if (Date.now() - v.at > 120000) rate.delete(key);
}, 60000);
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    !process.env.PUBLIC_ORIGIN)
)
  throw Error(
    "Production requires SESSION_SECRET (32+ chars) and PUBLIC_ORIGIN",
  );
const staticDirectory = process.env.STATIC_DIR ?? resolve(root, "dist");
if (existsSync(resolve(staticDirectory, "index.html"))) {
  app.use(express.static(staticDirectory, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve(staticDirectory, "index.html")),
  );
}
app.use((err: unknown, _req: Request, res: Response, _next: unknown) =>
  res.status((err as any)?.type==='entity.too.large'?413:400).json({
    error: {
      code: (err as any)?.type==='entity.too.large'?"PAYLOAD_TOO_LARGE":"INVALID_PAYLOAD",
      message: (err as any)?.type==='entity.too.large'?"上传内容超过大小限制":"请求无法解析",
      retryable: false,
    },
  }),
);
const port = Number(process.env.PORT ?? 3000),
  host = process.env.HOST ?? "127.0.0.1";
http.listen(port, host, () =>
  console.log(`Mahjong server http://${host}:${port}`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  clearInterval(cleanup);
  clearInterval(authExpiry);
  await tail;
  flushMetrics();
  await mailQueue.close();
  await bots.close();
  await new Promise<void>((done) => io.close(() => done()));
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
