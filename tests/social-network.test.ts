import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import { writeFileSync } from "node:fs";
import { fixture, password } from "./social-fixture.ts";
import { chooseBot } from "../backend/src/bot.ts";
import type { Frame } from "../shared/types.ts";
const origin = "http://127.0.0.1:3181";
test(
  "V4 HTTP/Socket end-to-end: profiles, private friendships, invitation join, normal match/replay and remote session revocation",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture();
    await f.store.close();
    let output = "";
    const sockets: Socket[] = [];
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "backend/src/server.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: "",
          SQLITE_PATH: f.path,
          PORT: "3181",
          HOST: "127.0.0.1",
          NODE_ENV: "test",
          FAST_TEST: "1",
          MAIL_ENVIRONMENT: "preview",
          SESSION_SECRET: f.auth.config.requestSecret,
          AUTH_ENABLED: "true",
          EMAIL_VERIFICATION_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    t.after(async () => {
      sockets.forEach((s) => s.disconnect());
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((r) => child.once("exit", () => r()));
      }
      await f.close();
    });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(origin + "/healthz")).ok) break;
      } catch {}
      if (child.exitCode !== null) throw Error(output);
      await delay(30);
    }
    const cookies = f.users.map((u) => "mj_session=" + u.token);
    async function api(
      i: number,
      path: string,
      method = "GET",
      body?: any,
      key = randomUUID() as string,
    ) {
      const r = await fetch(origin + "/api/v2" + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookies[i] ?? "",
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          "User-Agent": "Mozilla/5.0 (iPhone) AppleWebKit/605.1 Safari/604.1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: r.status,
        private: r.headers.get("cache-control"),
        cookie: r.headers.get("set-cookie"),
        ...(await r.json()),
      };
    }
    async function ok(i: number, path: string, method = "GET", body?: any) {
      const r = await api(i, path, method, body);
      assert.equal(r.status, 200, JSON.stringify(r));
      return r.data;
    }
    function emit(socket: Socket, event: string, payload: any): Promise<any> {
      return new Promise((resolve, reject) =>
        socket
          .timeout(5000)
          .emit(
            event,
            { protocolVersion: "2.0", requestId: randomUUID(), payload },
            (e: Error, r: any) =>
              e
                ? reject(e)
                : r.ok
                  ? resolve(r.data)
                  : reject(Error(r.error.code)),
          ),
      );
    }
    async function connect(i: number) {
      const socket = io(origin + "/game", {
        transports: ["websocket"],
        extraHeaders: { Origin: origin, Cookie: cookies[i] },
        auth: { protocolVersion: "2.0" },
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((r, j) => {
        socket.once("connect", r);
        socket.once("connect_error", j);
      });
      return socket;
    }
    const caps = await ok(0, "/capabilities");
    assert.equal(caps.appVersion, "0.4.0");
    assert(caps.friends && caps.sessionManagement);
    const profiles = await Promise.all(
      [0, 1, 2, 3].map((i) => ok(i, "/profile")),
    );
    assert.equal((await api(0, "/social/snapshot")).private, "no-store");
    await ok(0, "/profile", "PATCH", {
      displayName: "甲的更新昵称",
      avatarId: "crane",
      expectedProfileVersion: profiles[0].profileVersion,
    });
    const guest = await api(8, "/sessions/guest", "POST", {
      displayName: "游客回归",
    });
    cookies[8] = guest.cookie!.split(";")[0];
    assert.equal((await api(8, "/profile")).status, 403);
    const a = await connect(0),
      b = await connect(1);
    let notifications = 0;
    b.on("social:changed", () => notifications++);
    const request = await ok(0, "/friend-requests", "POST", {
      friendCode: profiles[1].friendCode,
    });
    await ok(1, "/friend-requests/" + request.requestId + "/accept", "POST", {
      expectedVersion: request.version,
    });
    assert.equal((await ok(0, "/social/snapshot")).friends[0].status, "ONLINE");
    assert.equal((await ok(2, "/social/snapshot")).friends.length, 0);
    assert.equal(
      (
        await api(
          2,
          "/friend-requests/" + request.requestId + "/accept",
          "POST",
          { expectedVersion: 1 },
        )
      ).status,
      404,
    );
    const bindings = [
      await emit(a, "session:claim", { takeover: false }),
      await emit(b, "session:claim", { takeover: false }),
    ];
    let room = await ok(0, "/rooms", "POST", {
      format: "EAST_ONLY",
      rulesetId: "riichi-4p-v1.0",
      timePresetId: "standard-v1",
    });
    assert.equal(room.slots[0].displayName, "甲的更新昵称");
    assert.equal(room.slots[0].avatarId, "crane");
    const invitation = await ok(0, "/room-invitations", "POST", {
      recipientFriendCode: profiles[1].friendCode,
      roomId: room.roomId,
      lobbyGeneration: 1,
      expectedRoomVersion: room.roomVersion,
    });
    const snap = await ok(1, "/social/snapshot");
    assert.equal(snap.counts.invitations, 1);
    assert(!JSON.stringify(snap).includes(room.inviteCode));
    assert(!JSON.stringify(snap).includes(room.roomId));
    await ok(
      1,
      "/room-invitations/" + invitation.invitationId + "/accept",
      "POST",
      { expectedVersion: 1 },
    );
    room = await ok(0, "/rooms/" + room.roomId);
    assert.equal(room.slots.filter(Boolean).length, 2);
    assert.equal(
      (
        await api(0, "/profile", "PATCH", {
          displayName: "不应改",
          avatarId: "moon",
          expectedProfileVersion: 2,
        })
      ).data,
      undefined,
    );
    for (const seat of [2, 3])
      room = await ok(
        0,
        "/rooms/" + room.roomId + "/slots/" + seat + "/bot",
        "PUT",
        {
          botLevel: "BASIC",
          expectedRoomVersion: room.roomVersion,
          lobbyGeneration: 1,
        },
      );
    for (const i of [0, 1])
      room = await ok(i, "/rooms/" + room.roomId + "/ready", "PUT", {
        ready: true,
        expectedRoomVersion: room.roomVersion,
        lobbyGeneration: 1,
      });
    const { matchId } = await ok(
      0,
      "/rooms/" + room.roomId + "/start",
      "POST",
      { expectedRoomVersion: room.roomVersion, lobbyGeneration: 1 },
    );
    const frames: (Frame | null)[] = [null, null];
    const submitted = new Set<string>();
    for (const [i, socket] of [a, b].entries()) {
      socket.on("game:view", (frame: Frame) => {
        frames[i] = frame;
        const d = frame.state.self.decision;
        if (d?.canSubmit && !submitted.has(d.decisionId)) {
          submitted.add(d.decisionId);
          void emit(socket, "game:action", {
            matchId,
            handId: frame.state.hand.handId,
            serverEpoch: frame.serverEpoch,
            bindingId: bindings[i].bindingId,
            windowId: d.windowId,
            decisionId: d.decisionId,
            optionId: chooseBot(frame.state),
            lastSeenViewSeq: frame.viewSeq,
          }).catch(() => {});
        }
      });
      await emit(socket, "game:attach", {
        matchId,
        bindingId: bindings[i].bindingId,
        lastStreamId: null,
        lastViewSeq: null,
      });
    }
    const until = async (fn: () => boolean) => {
      const end = Date.now() + 60000;
      while (!fn()) {
        if (Date.now() > end) throw Error("V4 game timeout: " + output);
        await delay(20);
      }
    };
    await until(() => frames.every((f) => f?.state.status === "FINISHED"));
    assert.equal(
      frames[0]!.state.matchResult!.finalPoints.reduce((a, b) => a + b, 0),
      100000,
    );
    const replay = await ok(0, "/matches/" + matchId + "/replay");
    const frozenA = replay.players.find((p: any) => p.displayName === "甲的更新昵称");
    assert(frozenA, "随机分座后仍保留账号A的开场资料");
    assert.equal(frozenA.avatarId, "crane");
    assert.equal((await api(2, "/matches/" + matchId + "/replay")).status, 403);
    const login = await api(9, "/auth/login", "POST", {
      email: "test0@example.com",
      password,
      flowId: randomUUID(),
      confirmSwitchGuest: false,
    });
    assert.equal(login.status, 200);
    cookies[9] = login.cookie!.split(";")[0];
    const other = await connect(9);
    const sessions = await ok(0, "/auth/sessions");
    const target = sessions.items.find((s: any) => !s.current);
    assert(target);
    await ok(0, "/auth/sessions/revoke", "POST", {
      sessionId: target.sessionId,
      currentPassword: password,
      flowId: randomUUID(),
    });
    await until(() => !other.connected);
    assert.equal((await api(9, "/me")).status, 401);
    assert.equal((await api(0, "/me")).status, 200);
    assert(notifications > 0);
    writeFileSync(
      "reports/v4-social-network.json",
      JSON.stringify(
        {
          version: "0.4.0",
          profileFrozen: true,
          friendsAccepted: true,
          inviteJoined: true,
          normalMatchFinished: true,
          replayAuthorized: true,
          remoteSessionRevoked: true,
          privateResponsesNoStore: true,
          notificationsObserved: notifications,
          scriptedClients: true,
          realSMTP: false,
          passed: true,
        },
        null,
        2,
      ),
    );
  },
);
