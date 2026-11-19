import { ensureSocialProfile } from "../backend/src/social/schema.ts";
// Isolated capacity exercise. Never point seed at the production database.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { io, type Socket } from "socket.io-client";
import { Store } from "../backend/src/store.ts";
import {
  createGame,
  quad,
  project,
  apply,
  advanceResult,
} from "../backend/src/engine.ts";
import { chooseBot } from "../backend/src/bot.ts";
import { summarize } from "../backend/src/history.ts";
import { APP_VERSION, type Frame, type Room } from "../shared/types.ts";
import { migrateAuth } from "../backend/src/auth/migration.ts";
import { authConfig } from "../backend/src/auth/config.ts";
import { Passwords } from "../backend/src/auth/crypto.ts";
const authScenario = process.env.LOAD_AUTH_LOAD === "1";
const socialScenario = process.env.LOAD_SOCIAL_LOAD === "1";
const accountScenario = authScenario || socialScenario;
if (process.argv.includes("--seed") || process.argv.includes("--reset")) {
  const database = process.env.DATABASE_URL;
  if (
    process.env.ALLOW_ISOLATED_SEED !== "YES" ||
    !database ||
    !/^\/mahjong_v[234]_capacity[a-z0-9_]*$/.test(new URL(database).pathname)
  )
    throw Error(
      "Seeding and reset require an explicitly acknowledged isolated capacity database",
    );
}
const fixture =
  process.env.LOAD_FIXTURE ?? "/private/tmp/mahjong-v2-load-fixture.json";
const origin = process.env.LOAD_ORIGIN ?? "http://127.0.0.1:18029";
const siteOrigin = new URL(origin).origin;
const socketPath = new URL(origin).pathname.replace(/\/$/, "") + "/socket.io";
function loadHeaders(cookie: string, ip = "192.0.2.1") {
  return {
    Origin: process.env.LOAD_PUBLIC_ORIGIN ?? siteOrigin,
    ...(process.env.LOAD_PUBLIC_ORIGIN
      ? { Host: new URL(process.env.LOAD_PUBLIC_ORIGIN).host }
      : {}),
    Cookie: cookie,
    "X-Forwarded-For": ip,
    "X-Capacity-Client-IP": ip,
    ...(process.env.LOAD_ACCESS_TOKEN
      ? { "X-Capacity-Token": process.env.LOAD_ACCESS_TOKEN }
      : {}),
  };
}

const reportPath =
  process.env.LOAD_REPORT ?? "/private/tmp/mahjong-v2-load-report.json";
if (process.argv.includes("--reset")) {
  if (
    process.env.ALLOW_ISOLATED_SEED !== "YES" ||
    !process.env.DATABASE_URL ||
    !/^\/mahjong_v[234]_capacity[a-z0-9_]*$/.test(
      new URL(process.env.DATABASE_URL).pathname,
    )
  )
    throw Error(
      "Reset is restricted to explicitly acknowledged capacity databases",
    );
  const saved = JSON.parse(readFileSync(fixture, "utf8"));
  const store = new Store();
  await store.open();
  const resetClient = await store.pool!.connect();
  try {
    await resetClient.query("BEGIN");
    await resetClient.query(
      "DELETE FROM documents WHERE kind<>'session' AND NOT(kind='match' AND id=$1)",
      [saved.replayMatchId],
    );
    await resetClient.query(
      "DELETE FROM history_summaries WHERE match_id NOT LIKE 'capacity-history-%' AND match_id<>$1",
      [saved.replayMatchId],
    );
    await resetClient.query(
      "DELETE FROM history_members WHERE NOT EXISTS(SELECT 1 FROM history_summaries s WHERE s.match_id=history_members.match_id)",
    );
    await resetClient.query("DELETE FROM replay_positions");
    if (socialScenario) {
      for (const table of [
        "friendships",
        "friend_requests",
        "blocks",
        "room_invitations",
        "social_cooldowns",
        "social_limits",
        "social_receipts",
        "social_audit",
      ])
        await resetClient.query("DELETE FROM " + table);
      await resetClient.query("UPDATE social_user_state SET revision=0");
    }
    await resetClient.query("COMMIT");
    console.log(
      JSON.stringify({
        reset: "isolated-capacity",
        preservedReplay: saved.replayMatchId,
      }),
    );
  } catch (e) {
    await resetClient.query("ROLLBACK");
    throw e;
  } finally {
    resetClient.release();
    await store.close();
  }
  process.exit(0);
}
if (process.argv.includes("--seed")) {
  if (process.env.ALLOW_ISOLATED_SEED !== "YES")
    throw Error("Explicit isolated database acknowledgement required");
  const store = new Store();
  await store.open();
  await store.initV2();
  const profiles = Array.from({ length: socialScenario ? 50 : 40 }, (_, i) => ({
    userId: "capacity-user-" + i,
    displayName: "容量验证" + i,
    cookie: "mj_session=" + randomBytes(32).toString("hex"),
    email: `capacity-${i}@example.invalid`,
    password: "capacity-only-password-" + i,
    uid: 0,
  }));
  await store.commit(
    profiles.map((p) => ({
      kind: "session",
      id: createHash("sha256").update(p.cookie.slice(11)).digest("hex"),
      data: {
        userId: p.userId,
        displayName: p.displayName,
        expires: Date.now() + 86400000,
      },
    })),
  );
  const g = createGame(
    "capacity-history",
    quad((s) => ({
      memberId: "history-" + s,
      userId: profiles[s].userId,
      displayName: profiles[s].displayName,
      participantKind: "HUMAN",
      ready: true,
      connected: true,
      botLevel: null,
    })),
    undefined,
    Date.now(),
    123,
    "HANCHAN",
  );
  while (g.phase !== "MATCH_RESULT") {
    if (g.phase === "HAND_RESULT") {
      advanceResult(g);
      continue;
    }
    const s = g.decisions.findIndex((d) => d && !d.choice) as 0 | 1 | 2 | 3;
    apply(g, s, chooseBot(project(g, s)));
  }
  const summary = summarize(g)!;
  await store.commit([{ kind: "match", id: g.matchId, data: g }]);
  for (let batch = 0; batch < 10; batch++) {
    await store.commit(
      Array.from({ length: 1000 }, (_, i) => {
        const s = {
          ...summary,
          matchId:
            batch === 0 && i === 0
              ? g.matchId
              : "capacity-history-" + (batch * 1000 + i),
          finishedAt: Date.now() - i - batch * 1000,
        };
        return { kind: "history", id: s.matchId, data: s };
      }),
    );
  }
  if (accountScenario) {
    // Preverified synthetic fixtures exist only in the guarded disposable DB.
    // No SMTP credentials, challenge bypass or test endpoint is added to the app.
    await migrateAuth(store, authConfig({ MAIL_ENVIRONMENT: "preview" }));
    const passwords = new Passwords(2);
    for (const p of profiles) {
      const hash = await passwords.hash(p.password);
      await store.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO auth_accounts(user_id,email_key,email_address,email_verified_at,password_hash,auth_version,updated_at) VALUES(?,?,?,?,?,1,?)",
          [p.userId, p.email, p.email, Date.now(), hash, Date.now()],
        );
        await tx.query("UPDATE auth_users SET kind='ACCOUNT' WHERE user_id=?", [
          p.userId,
        ]);
        await tx.query(
          "UPDATE auth_sessions SET auth_version=1 WHERE user_id=?",
          [p.userId],
        );
        await ensureSocialProfile(tx, p.userId);
        p.uid = Number(
          (await tx.one("SELECT uid FROM social_profiles WHERE user_id=?", [
            p.userId,
          ]))!.uid,
        );
      });
    }
    await store.commit(
      profiles.map((p) => ({
        kind: "session",
        id: createHash("sha256").update(p.cookie.slice(11)).digest("hex"),
        data: { userId: p.userId, displayName: p.displayName, expires: 0 },
      })),
    );
  }
  writeFileSync(
    fixture,
    JSON.stringify({
      profiles,
      replayMatchId: g.matchId,
      authScenario: accountScenario,
      socialScenario,
    }),
    { mode: 0o600 },
  );
  await store.close();
  console.log(JSON.stringify({ seeded: 10000, sessions: profiles.length }));
  process.exit(0);
}
const fixtureData = JSON.parse(readFileSync(fixture, "utf8"));
fixtureData.profiles.forEach((p: { ip?: string }, index: number) => {
  p.ip = `192.0.2.${index + 1}`;
});
if (authScenario && !fixtureData.authScenario)
  throw Error("Authentication load requires account fixtures");
if (
  socialScenario &&
  (!fixtureData.socialScenario || fixtureData.profiles.length !== 50)
)
  throw Error("Social load requires 50 guarded account fixtures");
const samples: Record<string, number[]> = {
    rtt: [],
    receipt: [],
    restore: [],
    history: [],
    stats: [],
    replay: [],
    authLogin: [],
    invalidGrant: [],
    socialRead: [],
    socialWrite: [],
    socialConvergence: [],
  },
  failures: string[] = [];
const startupSamples: Record<string, number[]> = Object.fromEntries(
  Object.keys(samples).map((metric) => [metric, []]),
);
let measurementStartedAt: number | null = null;
const capture = async <T>(metric: string, fn: () => Promise<T>) => {
  const t = performance.now();
  const r = await fn();
  const elapsed = performance.now() - t;
  if (
    socialScenario &&
    (measurementStartedAt === null || t < measurementStartedAt)
  ) {
    startupSamples[metric].push(elapsed);
    // Restore explicitly measures startup/reconnect rather than steady traffic.
    if (metric === "restore") samples[metric].push(elapsed);
  } else samples[metric].push(elapsed);
  return r;
};
let stopping = false;
const clients: {
  socket: Socket;
  cookie: string;
  ip: string;
  binding: string;
  frame: Frame | null;
  done: Set<string>;
}[] = [];
async function api(
  c: { cookie: string; ip?: string },
  method: string,
  path: string,
  body?: unknown,
) {
  const r = await fetch(origin + "/api/v2" + path, {
    method,
    headers: {
      ...loadHeaders(c.cookie, c.ip),
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const d = await r.json();
  if (!r.ok) throw Error(`${path}: ${r.status} ${d.error?.code}`);
  return d.data;
}
function emit(c: (typeof clients)[number], event: string, payload: unknown) {
  return new Promise<any>((resolve, reject) =>
    c.socket
      .timeout(10000)
      .emit(
        event,
        { protocolVersion: "2.0", requestId: randomUUID(), payload },
        (err: Error, r: any) =>
          err
            ? reject(err)
            : r.ok
              ? resolve(r.data)
              : reject(Error(r.error?.code)),
      ),
  );
}
async function connect(index: number) {
  const profile = fixtureData.profiles[index];
  const c = {
    socket: io(siteOrigin + "/game", {
      path: socketPath,
      transports: ["websocket"],
      auth: { protocolVersion: "2.0" },
      extraHeaders: loadHeaders(profile.cookie, profile.ip),
      reconnection: false,
    }),
    cookie: profile.cookie,
    ip: profile.ip,
    binding: "",
    frame: null as Frame | null,
    done: new Set<string>(),
  };
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.socket.once("connect", () => resolve());
    c.socket.once("connect_error", reject);
  });
  c.binding = (await emit(c, "session:claim", { takeover: false })).bindingId;
  c.socket.on("game:view", (f: Frame) => {
    c.frame = f;
    const d = f.state.self.decision;
    if (stopping || !d?.canSubmit || c.done.has(d.decisionId)) return;
    c.done.add(d.decisionId);
    const o =
      d.options.find((o) => o.type === "TSUMO" || o.type === "RON") ??
      d.options.find(
        (o) => o.type === "DISCARD" && o.tile === f.state.self.drawnTile,
      ) ??
      d.options.find((o) => o.type === "DISCARD" || o.type === "PASS");
    if (!o) return;
    setTimeout(() => {
      if (stopping) return;
      capture("receipt", () =>
        emit(c, "game:action", {
          matchId: f.matchId,
          handId: f.state.hand.handId,
          serverEpoch: f.serverEpoch,
          bindingId: c.binding,
          windowId: d.windowId,
          decisionId: d.decisionId,
          optionId: o.optionId,
          lastSeenViewSeq: f.viewSeq,
        }),
      )
        .then((r) => {
          if (r.status !== "ACCEPTED")
            failures.push(r.error?.code ?? "REJECTED");
        })
        .catch((e) => failures.push(e.message));
    }, 650);
  });
  return c;
}
const humanCount = Number(process.env.LOAD_HUMANS ?? 4),
  duration = Number(process.env.LOAD_DURATION_MS ?? 35000);
const cpu: number[] = [],
  rss: number[] = [];
const pid = process.env.SERVER_PID;
let lastTicks: number | null = null,
  lastAt = performance.now();
const sample = setInterval(() => {
  if (!pid) return;
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
    const ticks = Number(line[13]) + Number(line[14]);
    const at = performance.now();
    if (lastTicks !== null)
      cpu.push((((ticks - lastTicks) * 10) / (at - lastAt)) * 100);
    lastTicks = ticks;
    lastAt = at;
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(
      /VmRSS:\s+(\d+)/,
    );
    if (m) rss.push(Number(m[1]) / 1024);
  } catch {}
}, 1000);
const started = performance.now();
let queries: ReturnType<typeof setInterval>[] = [];
const authRequests = new Set<Promise<void>>();
let authSuccesses = 0,
  invalidGrantRejections = 0,
  authSequence = 0,
  maxAuthInFlight = 0;
async function authRequest(
  path: string,
  body: unknown,
  cookie = "",
  ip = "192.0.2.1",
) {
  const response = await fetch(origin + "/api/v2/auth/" + path, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: {
      ...loadHeaders(cookie, ip),
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}
async function exerciseAuth() {
  const p = fixtureData.profiles[authSequence++ % fixtureData.profiles.length];
  const login = await capture("authLogin", () =>
    authRequest(
      "login",
      {
        email: p.email,
        password: p.password,
        flowId: randomUUID(),
        confirmSwitchGuest: false,
      },
      "",
      p.ip,
    ),
  );
  if (
    login.status !== 200 ||
    login.body.data.userId !== p.userId ||
    !login.cookie
  )
    throw Error("AUTH_LOGIN_FAILED");
  const logout = await authRequest(
    "logout",
    { flowId: randomUUID() },
    login.cookie,
    p.ip,
  );
  if (logout.status !== 200) throw Error("AUTH_LOGOUT_FAILED");
  authSuccesses++;
  const invalid = await capture("invalidGrant", () =>
    authRequest(
      "password-reset/complete",
      {
        grant: randomBytes(32).toString("base64url"),
        password: p.password,
        confirmation: p.password,
        flowId: randomUUID(),
      },
      "",
      p.ip,
    ),
  );
  if (invalid.status !== 400 || invalid.body.error?.code !== "GRANT_INVALID")
    throw Error("INVALID_GRANT_NOT_REJECTED");
  invalidGrantRejections++;
}

const socialSockets: Socket[] = [];
const socialWrites = new Set<Promise<void>>();
const rematchTasks = new Set<Promise<void>>();
const socialReads = new Map<number, Promise<void>>(),
  socialAgain = new Set<number>();
const convergence = new Map<number, { revision: number; since: number }>();
const expectedRevision = Array(50).fill(0);
let socialOperations = 0,
  socialNotifications = 0,
  socialCursor = 0,
  operationCursor = 0,
  activeRequest: any = null;
const relationPairs: [number, number][] = [];
for (let offset = 1; offset <= 25; offset++)
  for (let i = 0; i < 50; i++) {
    const j = (i + offset) % 50;
    if (i < j) relationPairs.push([i, j]);
  }
function refreshSocial(index: number): Promise<void> {
  if (stopping) return Promise.resolve();
  const old = socialReads.get(index);
  if (old) {
    socialAgain.add(index);
    return old;
  }
  const profile = fixtureData.profiles[index];
  const request = capture("socialRead", () =>
    api(profile, "GET", "/social/snapshot"),
  )
    .then((snapshot) => {
      const pending = convergence.get(index);
      if (pending && snapshot.revision >= pending.revision) {
        samples.socialConvergence.push(performance.now() - pending.since);
        convergence.delete(index);
      }
    })
    .catch((e) => {
      failures.push(e.message);
    })
    .finally(() => {
      socialReads.delete(index);
      if (socialAgain.delete(index) && !stopping) void refreshSocial(index);
    });
  socialReads.set(index, request);
  return request;
}
async function connectSocial() {
  // Bound startup concurrency; this is outside the steady measurement window.
  for (let start = 0; start < 50; start += 10)
    await Promise.all(
      Array.from({ length: 10 }, async (_, offset) => {
        const i = start + offset;
        const p = fixtureData.profiles[i];
        const socket = io(siteOrigin + "/game", {
          path: socketPath,
          transports: ["websocket"],
          extraHeaders: loadHeaders(p.cookie, p.ip),
          auth: { protocolVersion: "2.0" },
          reconnection: false,
        });
        socialSockets.push(socket);
        socket.on("social:changed", () => {
          socialNotifications++;
          void refreshSocial(i);
        });
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("connect_error", reject);
        });
        await refreshSocial(i);
      }),
    );
}
async function exerciseSocial() {
  const [sender, recipient] = relationPairs[Math.floor(operationCursor / 2)];
  const action = operationCursor++ % 2;
  const since = performance.now();
  for (const i of [sender, recipient])
    convergence.set(i, { revision: ++expectedRevision[i], since });
  if (action === 0)
    activeRequest = await capture("socialWrite", () =>
      api(fixtureData.profiles[sender], "POST", "/friend-requests", {
        uid: fixtureData.profiles[recipient].uid,
      }),
    );
  else
    await capture("socialWrite", () =>
      api(
        fixtureData.profiles[recipient],
        "POST",
        "/friend-requests/" + activeRequest.requestId + "/accept",
        { expectedVersion: activeRequest.version },
      ),
    );
  socialOperations++;
}
const loadTables: { cs: typeof clients; roomId: string; busy: boolean }[] = [];
let rematches = 0;
async function maintainTables() {
  for (const table of loadTables) {
    if (
      table.busy ||
      !table.cs.every((c) => c.frame?.state.status === "FINISHED")
    )
      continue;
    table.busy = true;
    try {
      let room: Room = await api(table.cs[0], "GET", "/rooms/" + table.roomId);
      room = await api(
        table.cs[0],
        "POST",
        "/rooms/" + room.roomId + "/rematch",
        {
          expectedRoomVersion: room.roomVersion,
          lobbyGeneration: room.lobbyGeneration,
        },
      );
      for (const c of table.cs)
        room = await api(c, "PUT", "/rooms/" + room.roomId + "/ready", {
          ready: true,
          expectedRoomVersion: room.roomVersion,
          lobbyGeneration: room.lobbyGeneration,
        });
      const { matchId } = await api(
        table.cs[0],
        "POST",
        "/rooms/" + room.roomId + "/start",
        {
          expectedRoomVersion: room.roomVersion,
          lobbyGeneration: room.lobbyGeneration,
        },
      );
      for (const c of table.cs)
        await emit(c, "game:attach", {
          matchId,
          bindingId: c.binding,
          lastStreamId: null,
          lastViewSeq: null,
        });
      rematches++;
    } catch (e) {
      failures.push((e as Error).message);
    } finally {
      table.busy = false;
    }
  }
}

try {
  if (socialScenario) await connectSocial();
  await Promise.all(
    Array.from({ length: 10 }, async (_, table) => {
      const cs = await Promise.all(
        Array.from({ length: humanCount }, (_, s) => connect(table * 4 + s)),
      );
      let r: Room = await api(cs[0], "POST", "/rooms", {
        format: table % 2 ? "HANCHAN" : "EAST_ONLY",
        rulesetId: "riichi-4p-v1.0",
        timePresetId: "standard-v1",
      });
      for (const c of cs.slice(1))
        r = await api(c, "POST", "/rooms/join", { inviteCode: r.inviteCode });
      for (let s = humanCount; s < 4; s++)
        r = await api(cs[0], "PUT", `/rooms/${r.roomId}/slots/${s}/bot`, {
          botLevel: s % 2 ? "BASIC" : "STANDARD",
          expectedRoomVersion: r.roomVersion,
          lobbyGeneration: r.lobbyGeneration,
        });
      for (const c of cs)
        r = await api(c, "PUT", `/rooms/${r.roomId}/ready`, {
          ready: true,
          expectedRoomVersion: r.roomVersion,
          lobbyGeneration: r.lobbyGeneration,
        });
      const { matchId } = await api(cs[0], "POST", `/rooms/${r.roomId}/start`, {
        expectedRoomVersion: r.roomVersion,
        lobbyGeneration: r.lobbyGeneration,
      });
      loadTables.push({ cs, roomId: r.roomId, busy: false });
      for (const c of cs)
        await capture("restore", () =>
          emit(c, "game:attach", {
            matchId,
            bindingId: c.binding,
            lastStreamId: null,
            lastViewSeq: null,
          }),
        );
    }),
  );
  measurementStartedAt = performance.now();
  console.error(
    "CAPACITY_READY: ten tables and social connections initialized",
  );
  const query = (metric: string, path: string) =>
    capture(metric, () => api(clients[0], "GET", path)).catch((e) =>
      failures.push(e.message),
    );
  queries = [
    setInterval(() => void query("history", "/history"), 200),
    setInterval(() => void query("stats", "/stats?mode=FRIENDS"), 1000),
    setInterval(
      () =>
        void query("replay", `/matches/${fixtureData.replayMatchId}/replay`),
      1000,
    ),
    setInterval(
      () =>
        void capture("rtt", () =>
          emit(clients[0], "time:ping", { clientSentAt: Date.now() }),
        ).catch((e) => failures.push(e.message)),
      500,
    ),
  ];
  if (socialScenario) {
    let active = false;
    queries.push(
      setInterval(() => void refreshSocial(socialCursor++ % 50), 600),
      setInterval(() => {
        if (active) return;
        active = true;
        const request = exerciseSocial()
          .catch((e) => {
            failures.push(e.message);
          })
          .finally(() => {
            active = false;
            socialWrites.delete(request);
          });
        socialWrites.add(request);
      }, 1000),
      setInterval(() => {
        const task = maintainTables().finally(() => rematchTasks.delete(task));
        rematchTasks.add(task);
      }, 1000),
    );
  }
  if (authScenario)
    queries.push(
      setInterval(() => {
        if (authRequests.size >= 4) return;
        const request = exerciseAuth()
          .catch((error) => {
            failures.push(error.message);
          })
          .finally(() => {
            authRequests.delete(request);
          });
        authRequests.add(request);
        maxAuthInFlight = Math.max(maxAuthInFlight, authRequests.size);
      }, 250),
    );
  await new Promise((r) => setTimeout(r, duration));
} finally {
  queries.forEach(clearInterval);
  await Promise.allSettled([...socialWrites, ...rematchTasks]);
  if (socialScenario) {
    const end = performance.now() + 5000;
    while (convergence.size && performance.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (convergence.size) failures.push("SOCIAL_CONVERGENCE_TIMEOUT");
  }
  stopping = true;
  await Promise.allSettled([...socialReads.values()]);
  socialSockets.forEach((socket) => socket.disconnect());
  await Promise.allSettled([...authRequests]);
  clearInterval(sample);
  clients.forEach((c) => c.socket.disconnect());
}
const metrics = Object.fromEntries(
  Object.entries(samples).map(([k, v]) => {
    v.sort((a, b) => a - b);
    return [
      k,
      {
        count: v.length,
        p95Ms: v[Math.ceil(v.length * 0.95) - 1] ?? null,
        maxMs: v.at(-1) ?? null,
      },
    ];
  }),
);
const report = {
  at: new Date().toISOString(),
  version: APP_VERSION,
  protocol: "2.0",
  tables: 10,
  humanCount,
  botCount: 4 - humanCount,
  queryRate: { history: 5, stats: 1, replay: 1 },
  clientAddressModel:
    "Distinct TEST-NET addresses, trusted loopback test proxy only",
  clientTransport: process.env.LOAD_TRANSPORT_DESCRIPTION ?? "direct origin",
  syntheticSummaries: 10000,
  durationMs: Math.round(performance.now() - started),
  measurementWindowMs: duration,
  clientRunsOnServer: !!pid,
  environment: {
    platform: os.platform(),
    release: os.release(),
    node: process.version,
    cpus: os.cpus().length,
    totalMemoryMiB: Math.round(os.totalmem() / 1048576),
  },
  serverCpuPercentP95:
    cpu.sort((a, b) => a - b)[Math.ceil(cpu.length * 0.95) - 1] ?? null,
  serverRssMiBMax: rss.length ? Math.max(...rss) : null,
  metrics,
  startup: {
    durationMs:
      measurementStartedAt === null
        ? null
        : Math.round(measurementStartedAt - started),
    metrics: Object.fromEntries(
      Object.entries(startupSamples).map(([name, values]) => {
        values.sort((a, b) => a - b);
        return [
          name,
          {
            count: values.length,
            p95Ms: values[Math.ceil(values.length * 0.95) - 1] ?? null,
            maxMs: values.at(-1) ?? null,
          },
        ];
      }),
    ),
  },
  failures,
  social: {
    enabled: socialScenario,
    accounts: socialScenario ? 50 : 0,
    pollSeconds: 30,
    requestedValidOperationsPerSecond: 1,
    operations: socialOperations,
    notifications: socialNotifications,
    rematches,
    scriptedHumans: true,
  },
  authentication: {
    enabled: authScenario,
    successfulLoginLogout: authSuccesses,
    invalidGrantRejections,
    maxInFlight: maxAuthInFlight,
    requestedPerSecond: authScenario ? 4 : 0,
    realSMTP: false,
  },
  passed:
    (!socialScenario ||
      (socialOperations >= Math.floor(duration / 1000) * 0.9 &&
        metrics.socialRead.p95Ms !== null &&
        metrics.socialRead.p95Ms <= 500 &&
        metrics.socialWrite.p95Ms !== null &&
        metrics.socialWrite.p95Ms <= 500 &&
        metrics.socialConvergence.p95Ms !== null &&
        metrics.socialConvergence.maxMs !== null &&
        metrics.socialConvergence.maxMs <= 5000)) &&
    (!authScenario ||
      (authSuccesses >= Math.floor(duration / 250) * 0.75 &&
        invalidGrantRejections === authSuccesses &&
        maxAuthInFlight <= 4 &&
        metrics.authLogin.p95Ms !== null &&
        metrics.authLogin.p95Ms <= 2000)) &&
    failures.length === 0 &&
    metrics.rtt.p95Ms !== null &&
    metrics.rtt.p95Ms <= 100 &&
    metrics.receipt.p95Ms !== null &&
    metrics.receipt.p95Ms <= 300 &&
    metrics.restore.p95Ms !== null &&
    metrics.restore.p95Ms <= 3000 &&
    metrics.history.p95Ms !== null &&
    metrics.history.p95Ms <= 500,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
