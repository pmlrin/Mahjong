import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import { Store } from "../backend/src/store.ts";
import { AuthService } from "../backend/src/auth/service.ts";
import { authConfig } from "../backend/src/auth/config.ts";
import { MailQueue, type MailMessage } from "../backend/src/auth/mail.ts";
import { chooseBot } from "../backend/src/bot.ts";
import { createGame, quad } from "../backend/src/engine.ts";
import { summarize } from "../backend/src/history.ts";
import type { Frame, Room } from "../shared/types.ts";
const origin = "http://127.0.0.1:3131",
  initial = "initial password 🔒",
  next = "reset password 🔑",
  changed = "changed password 🎲";
class Client {
  cookie = "";
  socket: Socket | null = null;
  binding = "";
  frame: Frame | null = null;
  notices: any[] = [];
  revoked = false;
  auto = false;
  done = new Set<string>();
  async api(
    method: string,
    path: string,
    body?: unknown,
    key = randomUUID() as string,
  ) {
    const r = await fetch(origin + "/api/v2" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = r.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0];
    return { status: r.status, ...(await r.json()) };
  }
  async connect() {
    const socket = io(origin + "/game", {
      auth: { protocolVersion: "2.0" },
      transports: ["websocket"],
      extraHeaders: { Origin: origin, Cookie: this.cookie },
      reconnection: false,
    });
    this.socket = socket;
    socket.on("game:view", (f: Frame) => {
      this.frame = f;
      const d = f.state.self.decision;
      if (this.auto && d?.canSubmit && !this.done.has(d.decisionId)) {
        this.done.add(d.decisionId);
        void this.emit("game:action", {
          matchId: f.matchId,
          handId: f.state.hand.handId,
          serverEpoch: f.serverEpoch,
          bindingId: this.binding,
          windowId: d.windowId,
          decisionId: d.decisionId,
          optionId: chooseBot(f.state),
          lastSeenViewSeq: f.viewSeq,
        }).catch(() => {});
      }
    });
    socket.on("server:notice", (n) => {
      this.notices.push(n);
      if (n.code === "SESSION_REVOKED") this.revoked = true;
    });
    await new Promise<void>((r, j) => {
      socket.once("connect", r);
      socket.once("connect_error", j);
    });
  }
  emit(event: string, payload: any): Promise<any> {
    return new Promise((r, j) =>
      this.socket!.timeout(5000).emit(
        event,
        { protocolVersion: "2.0", requestId: randomUUID(), payload },
        (e: Error, result: any) => (e ? j(e) : r(result)),
      ),
    );
  }
  async claim() {
    const c = await this.emit("session:claim", { takeover: false });
    assert(c.ok);
    this.binding = c.data.bindingId;
  }
  async attach(matchId: string) {
    const a = await this.emit("game:attach", {
      matchId,
      bindingId: this.binding,
      lastStreamId: null,
      lastViewSeq: null,
    });
    assert(a.ok);
  }
  close() {
    this.socket?.disconnect();
  }
}
async function until(fn: () => boolean, timeout = 10000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw Error("Timed out");
    await delay(20);
  }
}
test(
  "V3 HTTP/Socket: upgrade, cross-browser ownership, explicit release, reset and password-change revoke active connections",
  { timeout: 120000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "mj-auth-net-")),
      path = join(dir, "test.sqlite"),
      saved = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path;
    const store = new Store();
    await store.open();
    await store.initV2();
    if (saved === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = saved;
    const config = {
      ...authConfig({}),
      enabled: true,
      emailEnabled: true,
      environment: "preview" as const,
      requestSecret: randomBytes(32).toString("base64url"),
      otpSecret: randomBytes(32).toString("base64url"),
      encryptionKey: randomBytes(32).toString("base64"),
      smtpPassword: "test-only",
      allowlist: new Set(["owner@example.com", "guest@example.com"]),
      providerBudgetPath: join(dir, "provider-budget.sqlite"),
    };
    let now = Date.now() - 120000;
    const auth = new AuthService(
      store,
      config,
      { serialize: (fn) => fn(), assertReleased() {}, async invalidate() {} },
      () => now,
    );
    await auth.initialize();
    let message: MailMessage;
    const queue = new MailQueue(
      auth,
      {
        send: async (m) => {
          message = m;
          return { accepted: true };
        },
      },
      () => {},
    );
    const context = (token: string | null) => ({
      tokenHash: token ? auth.resolveToken(token)!.tokenHash : null,
      flowId: randomUUID(),
      requestId: randomUUID(),
      ip: "127.0.0.1",
    });
    async function proof(
      purpose: "REGISTER" | "RESET_PASSWORD",
      email: string,
      ctx: ReturnType<typeof context>,
    ) {
      const c = await auth.requestCode(purpose, email, ctx);
      await queue.tick();
      const code = message!.text.match(/\b\d{6}\b/)![0];
      return (
        await auth.verify(purpose, c.data.challengeId, code, {
          ...ctx,
          requestId: randomUUID(),
        })
      ).data.grant as string;
    }
    const old = await auth.createGuest("旧访客", randomUUID()),
      regCtx = context(old.token),
      regGrant = await proof("REGISTER", "owner@example.com", regCtx),
      owner = await auth.complete("REGISTER", regGrant, initial, initial, {
        ...regCtx,
        requestId: randomUUID(),
      });
    const second = await auth.login(
      "owner@example.com",
      initial,
      false,
      context(null),
    );
    now += 60000;
    const resetCtx = context(null),
      resetGrant = await proof("RESET_PASSWORD", "owner@example.com", resetCtx);
    const guest = await auth.createGuest("保留战绩的游客", randomUUID()),
      guestCtx = context(guest.token),
      guestGrant = await proof("REGISTER", "guest@example.com", guestCtx);
    const finished = createGame(
      "seed-room",
      quad((s) => ({
        memberId: "m" + s,
        userId: s === 0 ? guest.identity.userId : "fixture-" + s,
        displayName: "开场昵称" + s,
        participantKind: "HUMAN",
        ready: true,
        connected: true,
        botLevel: null,
      })),
    );
    finished.status = "FINISHED";
    finished.phase = "MATCH_RESULT";
    finished.finishedAt = now;
    finished.matchResult = {
      matchId: finished.matchId,
      reason: "SCHEDULE_COMPLETE",
      finalPoints: [40000, 25000, 20000, 15000],
      ranks: [1, 2, 3, 4],
      netPoints: [15000, 0, -5000, -10000],
      replayAvailable: true,
    };
    await store.commit([
      { kind: "match", id: finished.matchId, data: finished },
      { kind: "history", id: finished.matchId, data: summarize(finished)! },
    ]);
    await store.setPosition(guest.identity.userId, finished.matchId, {
      handId: finished.handId,
      eventIndex: 0,
      viewerSeat: 0,
    });
    await queue.close();
    await store.close();
    let child: ChildProcess | null = null,
      output = "",
      enabled = true;
    const clients: Client[] = [];
    const make = (token?: string) => {
      const c = new Client();
      if (token) c.cookie = "mj_auth_test=" + token;
      clients.push(c);
      return c;
    };
    async function start() {
      child = spawn(
        process.execPath,
        ["--import", "tsx", "backend/src/server.ts"],
        {
          cwd: resolve("."),
          env: {
            ...process.env,
            NODE_ENV: "test",
            FAST_TEST: "1",
            PORT: "3131",
            HOST: "127.0.0.1",
            SQLITE_PATH: path,
            PUBLIC_ORIGIN: origin,
            SESSION_COOKIE_NAME: "mj_auth_test",
            SESSION_SECRET: config.requestSecret,
            AUTH_ENABLED: enabled ? "1" : "0",
            EMAIL_VERIFICATION_ENABLED: "0",
            MAIL_ENVIRONMENT: "preview",
            OTP_HMAC_SECRET: config.otpSecret,
            MAIL_OUTBOX_ENCRYPTION_KEY: config.encryptionKey,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.on("data", (b) => (output += b));
      child.stderr!.on("data", (b) => (output += b));
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(origin + "/healthz")).ok) return;
        } catch {}
        await delay(30);
      }
      throw Error("Server failed: " + output.slice(-2000));
    }
    async function stop() {
      if (!child?.pid) return;
      const exited = new Promise<void>((r) => child!.once("exit", () => r()));
      child.kill("SIGTERM");
      await exited;
      child = null;
    }
    let failed = false;
    const checked = (name: string, fn: () => Promise<void>) =>
      t.test(name, async () => {
        try {
          await fn();
        } catch (e) {
          failed = true;
          throw e;
        }
      });
    try {
      await start();
      const g = make(guest.token),
        a = make(owner.token),
        b = make(second.token);
      let guestAccountToken = "",
        savedReceipt: any,
        matchId = "";
      await checked(
        "T02/T10/T12/T27: register keeps old identity, snapshots and bookmark; logout closes one session only",
        async () => {
          const caps = (await g.api("GET", "/capabilities")).data;
          assert.equal(caps.auth.registration, false);
          assert.equal(caps.auth.passwordLogin, true);
          await g.connect();
          await g.claim();
          const priorCookie = g.cookie;
          const result = await g.api("POST", "/auth/register/complete", {
            grant: guestGrant,
            password: initial,
            confirmation: initial,
            flowId: guestCtx.flowId,
          });
          assert.equal(result.status, 200);
          guestAccountToken = g.cookie;
          await until(() => g.revoked);
          const me = await g.api("GET", "/me");
          assert.equal(me.data.userId, guest.identity.userId);
          assert.equal(me.data.identityKind, "ACCOUNT");
          assert.equal(me.data.maskedEmail, "gu***@example.com");
          assert.equal(
            (await g.api("GET", "/history")).data.items[0].matchId,
            finished.matchId,
          );
          assert.equal(
            (await g.api("GET", `/matches/${finished.matchId}/replay-position`))
              .data.viewerSeat,
            0,
          );
          assert.equal(
            (await a.api("GET", `/matches/${finished.matchId}`)).status,
            403,
          );
          const invalid = make();
          invalid.cookie = priorCookie;
          assert.equal((await invalid.api("GET", "/me")).status, 401);
          const other = make();
          const signed = await other.api("POST", "/auth/login", {
            email: "guest@example.com",
            password: initial,
            confirmSwitchGuest: false,
            flowId: randomUUID(),
          });
          assert.equal(signed.status, 200);
          assert.equal(
            (await other.api("GET", "/me")).data.userId,
            guest.identity.userId,
          );
          await other.connect();
          await other.claim();
          const oldToken = other.cookie;
          assert.equal(
            (await other.api("POST", "/auth/logout", { flowId: randomUUID() }))
              .status,
            200,
          );
          await until(() => other.revoked);
          const stale = make();
          stale.cookie = oldToken;
          assert.equal((await stale.api("GET", "/me")).status, 401);
          assert.equal((await g.api("GET", "/me")).status, 200);
        },
      );
      await checked(
        "T13/T18: controlling a match blocks direct identity changes; accepted moves remain durable",
        async () => {
          await a.connect();
          await a.claim();
          await b.connect();
          const refused = await b.emit("session:claim", { takeover: false });
          assert.equal(refused.error.code, "CONTROL_IN_USE");
          let r: Room = (
            await a.api("POST", "/rooms", {
              format: "HANCHAN",
              rulesetId: "riichi-4p-v1.0",
              timePresetId: "standard-v1",
            })
          ).data;
          for (let s = 1; s < 4; s++)
            r = (
              await a.api("PUT", `/rooms/${r.roomId}/slots/${s}/bot`, {
                botLevel: "STANDARD",
                expectedRoomVersion: r.roomVersion,
                lobbyGeneration: r.lobbyGeneration,
              })
            ).data;
          r = (
            await a.api("PUT", `/rooms/${r.roomId}/ready`, {
              ready: true,
              expectedRoomVersion: r.roomVersion,
              lobbyGeneration: r.lobbyGeneration,
            })
          ).data;
          matchId = (
            await a.api("POST", `/rooms/${r.roomId}/start`, {
              expectedRoomVersion: r.roomVersion,
              lobbyGeneration: r.lobbyGeneration,
            })
          ).data.matchId;
          await a.attach(matchId);
          await until(() => !!a.frame?.state.self.decision?.canSubmit);
          const f = a.frame!,
            d = f.state.self.decision!,
            o = d.options.find((o) => o.type === "DISCARD")!;
          savedReceipt = await a.emit("game:action", {
            matchId,
            handId: f.state.hand.handId,
            serverEpoch: f.serverEpoch,
            bindingId: a.binding,
            windowId: d.windowId,
            decisionId: d.decisionId,
            optionId: o.optionId,
            lastSeenViewSeq: f.viewSeq,
          });
          assert.equal(savedReceipt.data.status, "ACCEPTED");
          assert.equal(
            (await a.api("POST", "/auth/logout", { flowId: randomUUID() }))
              .error.code,
            "CONTROL_RELEASE_REQUIRED",
          );
          assert.equal(
            (
              await a.api("POST", "/auth/password/change", {
                currentPassword: initial,
                password: changed,
                confirmation: changed,
                flowId: randomUUID(),
              })
            ).error.code,
            "CONTROL_RELEASE_REQUIRED",
          );
          const key = randomUUID();
          assert.equal(
            (await a.api("POST", "/auth/release-control", {}, key)).status,
            200,
          );
          assert.equal(
            (await a.api("POST", "/auth/release-control", {}, key)).status,
            200,
          );
          await b.claim();
          await b.attach(matchId);
          assert.equal(b.frame!.state.self.desiredControl, "AI");
          const ack = await a.emit("game:sync", {
            matchId,
            syncId: randomUUID(),
          });
          assert.equal(ack.error.code, "CONTROL_REVOKED");
        },
      );
      await checked(
        "T14/T16/T18: anonymous reset revokes the active other device, keeps seat, points, mode and original receipt",
        async () => {
          const reset = make();
          const result = await reset.api(
            "POST",
            "/auth/password-reset/complete",
            {
              grant: resetGrant,
              password: next,
              confirmation: next,
              flowId: resetCtx.flowId,
            },
          );
          assert.equal(result.status, 200);
          assert.equal(result.data.loginRequired, true);
          assert.equal(reset.cookie, "");
          await until(() => a.revoked && b.revoked);
          assert.equal((await a.api("GET", "/me")).status, 401);
          assert.equal((await b.api("GET", "/me")).status, 401);
          assert.equal((await g.api("GET", "/me")).status, 200);
          assert.equal(
            (
              await reset.api("POST", "/auth/login", {
                email: "owner@example.com",
                password: initial,
                confirmSwitchGuest: false,
                flowId: randomUUID(),
              })
            ).error.code,
            "LOGIN_INVALID",
          );
          const login = await reset.api("POST", "/auth/login", {
            email: "owner@example.com",
            password: next,
            confirmSwitchGuest: false,
            flowId: randomUUID(),
          });
          assert.equal(login.status, 200);
          assert.equal(
            (await reset.api("GET", "/me")).data.userId,
            owner.data.userId,
          );
          await reset.connect();
          await reset.claim();
          await reset.attach(matchId);
          assert.equal(reset.frame!.state.format, "HANCHAN");
          assert.equal(reset.frame!.state.mode, "AI_PRACTICE");
          assert.equal(
            reset.frame!.state.players.filter(
              (p) => p.participantKind === "HUMAN",
            ).length,
            1,
          );
          const receipt = await reset.api(
            "GET",
            `/matches/${matchId}/requests/${savedReceipt.data.requestId}`,
          );
          assert.equal(receipt.data.receiptId, savedReceipt.data.receiptId);
          await until(() => reset.frame?.state.status === "FINISHED", 30000);
          assert.equal(
            reset.frame!.state.matchResult!.finalPoints.reduce(
              (a, b) => a + b,
              0,
            ),
            100000,
          );
        },
      );
      await checked(
        "T17/T30: password change rotates current cookie, revokes other sessions; feature off preserves account authentication",
        async () => {
          const d = make(),
            e = make();
          for (const c of [d, e])
            assert.equal(
              (
                await c.api("POST", "/auth/login", {
                  email: "owner@example.com",
                  password: next,
                  confirmSwitchGuest: false,
                  flowId: randomUUID(),
                })
              ).status,
              200,
            );
          const prior = d.cookie;
          const result = await d.api("POST", "/auth/password/change", {
            currentPassword: next,
            password: changed,
            confirmation: changed,
            flowId: randomUUID(),
          });
          assert.equal(result.status, 200);
          assert.notEqual(d.cookie, prior);
          assert.equal((await e.api("GET", "/me")).status, 401);
          const stale = make();
          stale.cookie = prior;
          assert.equal((await stale.api("GET", "/me")).status, 401);
          assert.equal(
            (await d.api("GET", "/me")).data.identityKind,
            "ACCOUNT",
          );
          clients.forEach((c) => c.close());
          await stop();
          enabled = false;
          await start();
          assert.equal(
            (await d.api("GET", "/me")).data.identityKind,
            "ACCOUNT",
          );
          const caps = (await d.api("GET", "/capabilities")).data;
          assert.equal(caps.auth.registration, false);
          assert.equal(caps.auth.passwordLogin, true);
          const fresh = make();
          assert.equal(
            (
              await fresh.api("POST", "/auth/login", {
                email: "owner@example.com",
                password: changed,
                confirmSwitchGuest: false,
                flowId: randomUUID(),
              })
            ).status,
            200,
          );
        },
      );
      await checked(
        "T28/T32: two registered accounts complete East game after half game and revocation tests",
        async () => {
          const first = make(),
            other = make();
          for (const [c, email, pw] of [
            [first, "owner@example.com", changed],
            [other, "guest@example.com", initial],
          ] as const) {
            assert.equal(
              (
                await c.api("POST", "/auth/login", {
                  email,
                  password: pw,
                  flowId: randomUUID(),
                  confirmSwitchGuest: false,
                })
              ).status,
              200,
            );
            await c.connect();
            await c.claim();
          }
          let r: Room = (
            await first.api("POST", "/rooms", {
              format: "EAST_ONLY",
              rulesetId: "riichi-4p-v1.0",
              timePresetId: "standard-v1",
            })
          ).data;
          r = (
            await other.api("POST", "/rooms/join", { inviteCode: r.inviteCode })
          ).data;
          for (let s = 2; s < 4; s++)
            r = (
              await first.api("PUT", `/rooms/${r.roomId}/slots/${s}/bot`, {
                botLevel: s === 2 ? "BASIC" : "STANDARD",
                expectedRoomVersion: r.roomVersion,
                lobbyGeneration: r.lobbyGeneration,
              })
            ).data;
          for (const c of [first, other])
            r = (
              await c.api("PUT", `/rooms/${r.roomId}/ready`, {
                ready: true,
                expectedRoomVersion: r.roomVersion,
                lobbyGeneration: r.lobbyGeneration,
              })
            ).data;
          const started = await first.api("POST", `/rooms/${r.roomId}/start`, {
            expectedRoomVersion: r.roomVersion,
            lobbyGeneration: r.lobbyGeneration,
          });
          assert.equal(started.status, 200);
          for (const c of [first, other]) {
            c.auto = true;
            await c.attach(started.data.matchId);
          }
          await until(
            () =>
              [first, other].every(
                (c) => c.frame?.state.hand.phase === "MATCH_RESULT",
              ),
            30000,
          );
          assert.equal(first.frame!.state.format, "EAST_ONLY");
          assert.equal(first.frame!.state.mode, "FRIENDS");
          assert.equal(
            (await first.api("GET", `/matches/${started.data.matchId}/replay`))
              .status,
            200,
          );
        },
      );
      assert(
        ![initial, next, changed, guestGrant, resetGrant].some((value) =>
          output.includes(value),
        ),
        "server logs must not contain credentials",
      );
      writeFileSync(
        "reports/v4-auth-network.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            protocol: "2.0",
            passed: !failed,
            realSMTP: false,
            registration: true,
            crossBrowserOwnership: true,
            explicitControlRelease: true,
            resetRevokesSocket: true,
            passwordChangeRotatesSession: true,
            featureOffPreservesAccount: true,
            secretsInLogs: [
              initial,
              next,
              changed,
              guestGrant,
              resetGrant,
            ].some((v) => output.includes(v)),
            serverEvents: output
              .split("\n")
              .filter((line) => line.startsWith("{"))
              .map((line) => {
                try {
                  const r = JSON.parse(line);
                  return { event: r.event };
                } catch {
                  return {};
                }
              }),
          },
          null,
          2,
        ),
      );
    } finally {
      clients.forEach((c) => c.close());
      await stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
