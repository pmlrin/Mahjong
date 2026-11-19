import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import { chooseBot } from "../backend/src/bot.ts";
import {
  APP_VERSION,
  type Room,
  type Frame,
  type Action,
} from "../shared/types.ts";
const origin = "http://127.0.0.1:3101",
  dir = mkdtempSync(join(tmpdir(), "mahjong-test-"));
let child: ChildProcess;
let output = "";
let fastTest = true;
let pacingGapsMs: number[] = [];
async function start() {
  child = spawn(
    process.execPath,
    ["--import", "tsx", "backend/src/server.ts"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        PORT: "3101",
        HOST: "127.0.0.1",
        NODE_ENV: "test",
        FAST_TEST: fastTest ? "1" : "0",
        SQLITE_PATH: join(dir, "db.sqlite"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.on("data", (b) => (output += b));
  child.stderr!.on("data", (b) => (output += b));
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(origin + "/healthz");
      if (r.ok) return;
    } catch {}
    await delay(50);
  }
  throw Error("Server failed: " + output);
}
async function stop(signal: NodeJS.Signals = "SIGTERM") {
  if (!child?.pid) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill(signal);
  await exited;
}
class Client {
  cookie = "";
  userId = "";
  socket!: Socket;
  binding = "";
  frame: Frame | null = null;
  auto = false;
  done = new Set<string>();
  actionReceipts: any[] = [];
  async api(
    method: string,
    path: string,
    body?: unknown,
    key = crypto.randomUUID() as string,
    extra: Record<string, string> = {},
  ) {
    const r = await fetch(origin + "/api/v2" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const c = r.headers.get("set-cookie");
    if (c) this.cookie = c.split(";")[0];
    const data = await r.json();
    return { status: r.status, ...data };
  }
  async login(name: string) {
    const r = await this.api("POST", "/sessions/guest", { displayName: name });
    assert.equal(r.status, 200);
    this.userId = r.data.userId;
    await this.connect();
  }
  async connect() {
    this.socket = io(origin + "/game", {
      transports: ["websocket"],
      extraHeaders: { Cookie: this.cookie, Origin: origin },
      auth: { protocolVersion: "2.0" },
      reconnection: false,
    });
    await new Promise<void>((res, rej) => {
      this.socket.once("connect", () => res());
      this.socket.once("connect_error", rej);
    });
    this.socket.on("game:view", (f: Frame) => {
      if (
        this.frame &&
        this.frame.streamId === f.streamId &&
        this.frame.viewSeq > f.viewSeq
      )
        return;
      this.frame = f;
      if (this.auto)
        this.step().catch((e) => {
          output += "CLIENT_ERROR " + e.stack;
        });
    });
    const c = await this.emit("session:claim", { takeover: false });
    assert(c.ok);
    this.binding = c.data.bindingId;
  }
  emit(
    event: string,
    payload: unknown,
    requestId: string = crypto.randomUUID(),
  ): Promise<any> {
    return new Promise((res, rej) =>
      this.socket
        .timeout(10000)
        .emit(
          event,
          { protocolVersion: "2.0", requestId, payload },
          (e: Error, r: any) => (e ? rej(e) : res(r)),
        ),
    );
  }
  async attach(id: string) {
    const r = await this.emit("game:attach", {
      matchId: id,
      bindingId: this.binding,
      lastStreamId: null,
      lastViewSeq: null,
    });
    assert(r.ok);
  }
  payload(optionId?: string): Action {
    const f = this.frame!,
      d = f.state.self.decision!;
    return {
      matchId: f.matchId,
      handId: f.state.hand.handId,
      serverEpoch: f.serverEpoch,
      bindingId: this.binding,
      windowId: d.windowId,
      decisionId: d.decisionId,
      optionId:
        optionId ??
        d.options.find((o) => o.type === "DISCARD" || o.type === "PASS")!
          .optionId,
      lastSeenViewSeq: f.viewSeq,
    };
  }
  async step() {
    const f = this.frame,
      d = f?.state.self.decision;
    if (!f || !d?.canSubmit || this.done.has(d.decisionId)) return;
    this.done.add(d.decisionId);
    const optionId = chooseBot(f.state);
    const r = await this.emit("game:action", this.payload(optionId));
    this.actionReceipts.push(r);
  }
  close() {
    this.socket?.disconnect();
  }
}
const clients: Client[] = [];
function client() {
  const c = new Client();
  clients.push(c);
  return c;
}
async function makeRoom(
  cs: Client[],
  matchFormat: "EAST_ONLY" | "HANCHAN" = "EAST_ONLY",
) {
  let r = (
    await cs[0].api("POST", "/rooms", {
      format: matchFormat,
      rulesetId: "riichi-4p-v1.0",
      timePresetId: "standard-v1",
    })
  ).data as Room;
  for (const c of cs.slice(1))
    r = (await c.api("POST", "/rooms/join", { inviteCode: r.inviteCode })).data;
  for (let s = cs.length; s < 4; s++)
    r = (
      await cs[0].api("PUT", `/rooms/${r.roomId}/slots/${s}/bot`, {
        botLevel: "STANDARD",
        expectedRoomVersion: r.roomVersion,
        lobbyGeneration: r.lobbyGeneration,
      })
    ).data;
  for (const c of cs)
    r = (
      await c.api("PUT", `/rooms/${r.roomId}/ready`, {
        ready: true,
        expectedRoomVersion: r.roomVersion,
        lobbyGeneration: r.lobbyGeneration,
      })
    ).data;
  const key = crypto.randomUUID();
  const first = await cs[0].api(
    "POST",
    `/rooms/${r.roomId}/start`,
    { expectedRoomVersion: r.roomVersion, lobbyGeneration: r.lobbyGeneration },
    key,
  );
  const repeat = await cs[0].api(
    "POST",
    `/rooms/${r.roomId}/start`,
    { expectedRoomVersion: r.roomVersion, lobbyGeneration: r.lobbyGeneration },
    key,
  );
  assert.deepEqual(repeat.data, first.data);
  await Promise.all(cs.map((c) => c.attach(first.data.matchId)));
  return { room: r, matchId: first.data.matchId };
}
async function until(fn: () => boolean, timeout = 60000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw Error("Timed out: " + output.slice(-3000));
    await delay(20);
  }
}
test(
  "HTTP, multiplayer, privacy, idempotency, takeover, restart, replay and 4 human/AI combinations",
  { timeout: 180000 },
  async (t) => {
    let subtestFailed = false;
    const checkedTest = (name: string, fn: () => Promise<void>) =>
      t.test(name, async () => {
        try {
          await fn();
        } catch (e) {
          subtestFailed = true;
          throw e;
        }
      });
    try {
      await start();
      await checkedTest(
        "sessions, Origin enforcement and unsupported format",
        async () => {
          const a = client();
          await a.login("net-identity");
          const me = await a.api("GET", "/me");
          assert.equal(me.data.userId, a.userId);
          const noOrigin = await fetch(origin + "/api/v2/rooms", {
            method: "POST",
            headers: { Cookie: a.cookie, "Content-Type": "application/json" },
            body: "{}",
          });
          assert.equal(noOrigin.status, 403);
          assert.equal(
            (
              await a.api("POST", "/rooms", {
                format: "UNSUPPORTED",
                rulesetId: "riichi-4p-v1.0",
                timePresetId: "standard-v1",
              })
            ).status,
            400,
          );
          a.close();
        },
      );
      await checkedTest(
        "departed members stop receiving room updates and closed rooms disappear",
        async () => {
          const host = client(),
            guest = client();
          await host.login("leave-host");
          await guest.login("leave-guest");
          let r = (
            await host.api("POST", "/rooms", {
              format: "EAST_ONLY",
              rulesetId: "riichi-4p-v1.0",
              timePresetId: "standard-v1",
            })
          ).data as Room;
          r = (
            await guest.api("POST", "/rooms/join", { inviteCode: r.inviteCode })
          ).data;
          await guest.emit("room:watch", { roomId: r.roomId });
          await guest.api("POST", `/rooms/${r.roomId}/leave`, {
            lobbyGeneration: r.lobbyGeneration,
          });
          let updates = 0;
          guest.socket.on("room:view", () => updates++);
          r = (await host.api("GET", `/rooms/${r.roomId}`)).data;
          await host.api("PUT", `/rooms/${r.roomId}/ready`, {
            ready: true,
            expectedRoomVersion: r.roomVersion,
            lobbyGeneration: r.lobbyGeneration,
          });
          await delay(60);
          assert.equal(updates, 0);
          assert.equal(
            (await guest.api("GET", `/rooms/${r.roomId}`)).status,
            403,
          );
          await host.api("POST", `/rooms/${r.roomId}/leave`, {
            lobbyGeneration: r.lobbyGeneration,
          });
          assert.equal((await host.api("GET", "/me")).data.roomId, null);
          host.close();
          guest.close();
        },
      );
      let saved: {
        id: string;
        payload: Action;
        receipt: any;
        actor: Client;
      } | null = null;
      let matchId = "";
      const table = await Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
          const c = client();
          await c.login("player-" + i);
          return c;
        }),
      );
      await checkedTest(
        "4 separate members, start dedup, private projections, active replay denied",
        async () => {
          const made = await makeRoom(table);
          matchId = made.matchId;
          assert.equal(
            new Set(table.map((c) => c.frame!.state.viewerSeat)).size,
            4,
          );
          for (const c of table) {
            assert.equal(c.frame!.state.self.concealedTiles.length, 13);
            assert(!("wall" in c.frame!.state));
            assert(c.frame!.state.hand.seats.every((s) => !("tiles" in s)));
            assert.equal(
              (await c.api("GET", `/matches/${matchId}/replay`)).status,
              403,
            );
          }
          const outsider = client();
          await outsider.login("outsider");
          assert.equal(
            (await outsider.api("GET", `/rooms/${made.room.roomId}`)).status,
            403,
          );
          assert.equal(
            (
              await outsider.emit("game:attach", {
                matchId,
                bindingId: outsider.binding,
                lastStreamId: null,
                lastViewSeq: null,
              })
            ).ok,
            false,
          );
          outsider.close();
        },
      );
      await checkedTest(
        "P07/P08/P10: duplicated action yields original receipt; changed option conflicts",
        async () => {
          const actor = table.find(
            (c) => c.frame!.state.self.decision?.canSubmit,
          )!;
          const p = actor.payload(),
            id = crypto.randomUUID(),
            first = await actor.emit("game:action", p, id);
          assert.equal(first.data.status, "ACCEPTED");
          const repeats = await Promise.all(
            Array.from({ length: 10 }, () => actor.emit("game:action", p, id)),
          );
          assert(
            repeats.every((r) => r.data.receiptId === first.data.receiptId),
          );
          const conflict = await actor.emit(
            "game:action",
            { ...p, optionId: crypto.randomUUID() },
            id,
          );
          assert.equal(conflict.error.code, "REQUEST_ID_CONFLICT");
          saved = { id, payload: p, receipt: first.data, actor };
        },
      );
      await checkedTest(
        "P18: explicit same-session takeover revokes old connection",
        async () => {
          const c = table[0],
            other = client();
          other.cookie = c.cookie;
          other.userId = c.userId;
          other.socket = io(origin + "/game", {
            transports: ["websocket"],
            extraHeaders: { Cookie: c.cookie, Origin: origin },
            auth: { protocolVersion: "2.0" },
            reconnection: false,
          });
          await new Promise<void>((r) =>
            other.socket.once("connect", () => r()),
          );
          assert.equal(
            (await other.emit("session:claim", { takeover: false })).error.code,
            "CONTROL_IN_USE",
          );
          const takeover = await other.emit("session:claim", {
            takeover: true,
          });
          assert(takeover.ok);
          assert.equal(
            (
              await c.emit("game:sync", {
                matchId,
                syncId: crypto.randomUUID(),
              })
            ).error.code,
            "CONTROL_REVOKED",
          );
          const back = await c.emit("session:claim", { takeover: true });
          c.binding = back.data.bindingId;
          await c.attach(matchId);
          other.close();
        },
      );
      await checkedTest(
        "P21-P24/P36: committed action survives abrupt process death; new epoch",
        async () => {
          const epoch = table[0].frame!.serverEpoch;
          await stop("SIGKILL");
          table.forEach((c) => c.close());
          await start();
          for (const c of table) {
            await c.connect();
            await c.attach(matchId);
            assert.equal(c.frame!.serverEpoch, epoch + 1);
          }
          const original = saved!;
          const receipt = await original.actor.api(
            "GET",
            `/matches/${matchId}/requests/${original.id}`,
          );
          assert.equal(receipt.data.receiptId, original.receipt.receiptId);
          assert.equal(
            (
              await original.actor.emit(
                "game:action",
                { ...original.payload, bindingId: original.actor.binding },
                original.id,
              )
            ).data.receiptId,
            original.receipt.receiptId,
          );
        },
      );
      // A restart deliberately keeps frozen HUMAN windows until their original timeout.
      for (const c of table) {
        c.auto = true;
        await c.emit("game:control", {
          matchId,
          bindingId: c.binding,
          mode: "HUMAN",
        });
        await c.step();
      }
      await checkedTest(
        "four-human full match, authorized replay and export content",
        async () => {
          await until(
            () => table.every((c) => c.frame?.state.status === "FINISHED"),
            60000,
          );
          for (const c of table) {
            assert.equal(
              c.frame!.state.matchResult!.finalPoints.reduce(
                (a, b) => a + b,
                0,
              ),
              100000,
            );
            const replay = await c.api("GET", `/matches/${matchId}/replay`);
            assert.equal(replay.status, 200);
            assert(
              replay.data.events.some((e: any) => e.type === "MATCH_FINISHED"),
            );
            assert(!JSON.stringify(replay.data).includes("bindingId"));
          }
          table.forEach((c) => {
            c.auto = false;
            c.close();
          });
        },
      );
      await checkedTest(
        "switching to AI 托管 hands the open decision to the AI at once",
        async () => {
          const c = client();
          await c.login("hand-over");
          const { matchId } = await makeRoom([c]);
          await until(() => !!c.frame?.state.self.decision?.canSubmit, 30000);
          const open = c.frame!.state.self.decision!;
          const r = await c.emit("game:control", {
            matchId,
            bindingId: c.binding,
            mode: "AI",
          });
          assert.equal(r.data.mode, "AI");
          // The window lasts 15s; waiting for its timeout would fail this bound.
          await until(
            () => c.frame!.state.self.decision?.decisionId !== open.decisionId,
            5000,
          );
          await c.emit("game:control", {
            matchId,
            bindingId: c.binding,
            mode: "HUMAN",
          });
          c.close();
        },
      );
      await checkedTest(
        "1+3 / 2+2 / 3+1 humans and bots complete full matches",
        async () => {
          await Promise.all(
            [1, 2, 3].map(async (n) => {
              const cs = await Promise.all(
                Array.from({ length: n }, async (_, i) => {
                  const c = client();
                  await c.login(`${n}human-${i}`);
                  return c;
                }),
              );
              await makeRoom(cs);
              for (const c of cs) {
                c.auto = true;
                await c.step();
              }
              await until(
                () => cs.every((c) => c.frame?.state.status === "FINISHED"),
                60000,
              );
              assert.equal(
                cs[0].frame!.state.matchResult!.finalPoints.reduce(
                  (a, b) => a + b,
                  0,
                ),
                100000,
              );
              cs.forEach((c) => c.close());
            }),
          );
        },
      );
      await checkedTest(
        "V02–V10: three same-room matches, half game, immutable history, replay position, diagnostics and stale generation",
        async () => {
          const cs = [client(), client()];
          await cs[0].login("rematch-host");
          await cs[1].login("rematch-guest");
          const made = await makeRoom(cs, "HANCHAN");
          let id = made.matchId;
          const ids: string[] = [];
          let firstReplay = "";
          for (let round = 0; round < 3; round++) {
            for (const c of cs) {
              c.auto = true;
              await c.step();
            }
            await until(
              () =>
                cs.every(
                  (c) =>
                    c.frame?.matchId === id &&
                    c.frame!.state.hand.phase === "MATCH_RESULT",
                ),
              60000,
            );
            for (const c of cs) c.auto = false;
            assert.equal(cs[0].frame!.state.format, "HANCHAN");
            assert.equal(cs[0].frame!.state.mode, "FRIENDS");
            ids.push(id);
            const replay = await cs[0].api("GET", `/matches/${id}/replay`);
            assert.equal(replay.data.replayVersion, "2.0");
            if (!round) firstReplay = JSON.stringify(replay.data);
            const history = await cs[0].api(
              "GET",
              "/history?format=HANCHAN&mode=FRIENDS",
            );
            assert.equal(history.data.items.length, round + 1);
            assert(!JSON.stringify(history.data).includes("shuffled"));
            const stats = await cs[0].api(
              "GET",
              "/stats?format=HANCHAN&mode=FRIENDS",
            );
            assert.equal(stats.data.count, round + 1);
            const eventIndex = replay.data.events.findIndex(
              (e: any) => e.type === "DISCARD",
            );
            const event = replay.data.events[eventIndex];
            const position = {
              handId: event.handId,
              eventIndex,
              viewerSeat: 2,
            };
            assert.equal(
              (
                await cs[0].api(
                  "PUT",
                  `/matches/${id}/replay-position`,
                  position,
                )
              ).status,
              200,
            );
            assert.equal(
              (await cs[0].api("GET", `/matches/${id}/replay-position`)).data
                .eventIndex,
              eventIndex,
            );
            assert.equal(
              (await cs[1].api("GET", `/matches/${id}/replay-position`)).data,
              null,
            );
            assert.equal(
              (
                await cs[0].api("PUT", `/matches/${id}/replay-position`, {
                  ...position,
                  eventIndex: 999999,
                })
              ).status,
              400,
            );
            const d = (await cs[0].api("POST", "/diagnostics", { matchId: id }))
              .data;
            assert.deepEqual(
              Object.keys(d).sort(),
              [
                "diagnosticId",
                "appVersion",
                "protocolVersion",
                "rulesetId",
                "roomId",
                "matchId",
                "handId",
                "phase",
                "viewSeq",
                "serverEpoch",
                "serverTime",
              ].sort(),
            );
            assert.equal(d.appVersion, APP_VERSION);
            assert.equal(
              (
                await cs[0].emit("game:control", {
                  matchId: id,
                  bindingId: cs[0].binding,
                  mode: "AI",
                })
              ).error.code,
              "MATCH_NOT_RUNNING",
            );
            if (round === 2) break;
            let r = (await cs[0].api("GET", `/rooms/${made.room.roomId}`))
              .data as Room;
            const oldGeneration = r.lobbyGeneration;
            const key = crypto.randomUUID(),
              body = {
                expectedRoomVersion: r.roomVersion,
                lobbyGeneration: r.lobbyGeneration,
              };
            const response = await cs[0].api(
              "POST",
              `/rooms/${r.roomId}/rematch`,
              body,
              key,
            );
            assert.equal(response.status, 200);
            r = response.data;
            assert.deepEqual(
              (await cs[0].api("POST", `/rooms/${r.roomId}/rematch`, body, key))
                .data,
              r,
            );
            assert.equal(r.matchId, null);
            assert.equal(r.lobbyGeneration, oldGeneration + 1);
            assert.equal(r.inviteCode, made.room.inviteCode);
            assert(
              r.slots
                .filter(Boolean)
                .every((m) => m!.participantKind === "BOT" || !m!.ready),
            );
            for (const path of ["/ready", "/config"]) {
              const stale = await cs[0].api(
                "PUT",
                `/rooms/${r.roomId}${path}`,
                {
                  ...(path === "/ready"
                    ? { ready: true }
                    : { format: "EAST_ONLY" }),
                  expectedRoomVersion: r.roomVersion,
                  lobbyGeneration: oldGeneration,
                },
              );
              assert.equal(stale.error.code, "LOBBY_GENERATION_CONFLICT");
            }
            const staleLeave = await cs[0].api(
              "POST",
              `/rooms/${r.roomId}/leave`,
              { lobbyGeneration: oldGeneration },
            );
            assert.equal(staleLeave.error.code, "LOBBY_GENERATION_CONFLICT");
            assert.equal(
              (
                await cs[0].api("POST", `/rooms/${r.roomId}/start`, {
                  expectedRoomVersion: r.roomVersion,
                  lobbyGeneration: r.lobbyGeneration,
                })
              ).error.code,
              "ROOM_NOT_READY",
            );
            r = (
              await cs[0].api("PUT", `/rooms/${r.roomId}/slots/2/bot`, {
                botLevel: "BASIC",
                expectedRoomVersion: r.roomVersion,
                lobbyGeneration: r.lobbyGeneration,
              })
            ).data;
            for (const c of cs)
              r = (
                await c.api("PUT", `/rooms/${r.roomId}/ready`, {
                  ready: true,
                  expectedRoomVersion: r.roomVersion,
                  lobbyGeneration: r.lobbyGeneration,
                })
              ).data;
            id = (
              await cs[0].api("POST", `/rooms/${r.roomId}/start`, {
                expectedRoomVersion: r.roomVersion,
                lobbyGeneration: r.lobbyGeneration,
              })
            ).data.matchId;
            assert(!ids.includes(id));
            for (const c of cs) {
              await c.attach(id);
              assert(c.frame!.state.players.every((p) => p.points === 25000));
              assert(
                c.frame!.state.players.some((p) => p.botLevel === "BASIC"),
              );
            }
            assert.equal(
              JSON.stringify(
                (await cs[0].api("GET", `/matches/${ids[0]}/replay`)).data,
              ),
              firstReplay,
            );
          }
          // Joining the same room in a new generation never grants old-match access.
          let r = (await cs[0].api("GET", `/rooms/${made.room.roomId}`)).data;
          r = (
            await cs[0].api("POST", `/rooms/${r.roomId}/rematch`, {
              expectedRoomVersion: r.roomVersion,
              lobbyGeneration: r.lobbyGeneration,
            })
          ).data;
          await cs[1].api("POST", `/rooms/${r.roomId}/leave`, {
            lobbyGeneration: r.lobbyGeneration,
          });
          const newcomer = client();
          await newcomer.login("new-room-member");
          assert.equal(
            (
              await newcomer.api("POST", "/rooms/join", {
                inviteCode: r.inviteCode,
              })
            ).status,
            200,
          );
          for (const path of [
            `/matches/${ids[0]}`,
            `/matches/${ids[0]}/replay`,
            `/matches/${ids[0]}/replay-position`,
          ])
            assert.equal((await newcomer.api("GET", path)).status, 403);
          assert.equal(
            (await newcomer.api("GET", "/history")).data.items.length,
            0,
          );
          const legacy = await fetch(origin + "/api/v1/me");
          assert.equal(legacy.status, 426);
          cs.forEach((c) => c.close());
          newcomer.close();
        },
      );
      await checkedTest(
        "Q04: AI and timeout receipts persist; corrupt active hand is quarantined and aborts once across two recoveries",
        async () => {
          const c = client();
          await c.login("recovery-check");
          const made = await makeRoom([c], "HANCHAN");
          await until(() => !!c.frame?.state.self.decision?.canSubmit);
          const decisionId = c.frame!.state.self.decision!.decisionId;
          const { DatabaseSync } = await import("node:sqlite");
          const read = new DatabaseSync(join(dir, "db.sqlite"), {
            readOnly: true,
          });
          const receipt = () => {
            const r = read
              .prepare(
                "SELECT payload FROM documents WHERE kind='receipt' AND id LIKE ? AND json_extract(payload,'$.receipt.decisionId')=?",
              )
              .get(made.matchId + ":TIMEOUT:%", decisionId) as
              { payload: string } | undefined;
            return r ? JSON.parse(r.payload) : null;
          };
          await until(() => receipt()?.receipt.status === "ACCEPTED", 20000);
          const saved = receipt();
          assert(saved.userId.startsWith("TIMEOUT:"));
          assert(
            (
              read
                .prepare(
                  "SELECT COUNT(*) AS n FROM documents WHERE kind='receipt' AND id LIKE ?",
                )
                .get(made.matchId + ":BOT:%") as any
            ).n > 0,
          );
          read.close();
          const epoch = c.frame!.serverEpoch;
          await stop("SIGKILL");
          c.close();
          await start();
          await c.connect();
          await c.attach(made.matchId);
          assert.equal(c.frame!.state.format, "HANCHAN");
          assert.equal(c.frame!.state.mode, "AI_PRACTICE");
          assert.equal(c.frame!.serverEpoch, epoch + 1);
          await stop("SIGKILL");
          c.close();
          const db = new DatabaseSync(join(dir, "db.sqlite"));
          const row = db
            .prepare(
              "SELECT payload FROM documents WHERE kind='match' AND id=?",
            )
            .get(made.matchId) as any;
          const g = JSON.parse(row.payload);
          assert.equal(g.status, "RUNNING");
          g.wall.push(g.wall[0]);
          db.prepare(
            "UPDATE documents SET payload=? WHERE kind='match' AND id=?",
          ).run(JSON.stringify(g), made.matchId);
          db.close();
          await start();
          await c.connect();
          await c.attach(made.matchId);
          assert.equal(c.frame!.state.status, "ABORTED");
          assert.equal(c.frame!.state.matchResult, null);
          assert.equal(c.frame!.state.self.decision, null);
          assert.equal(
            (await c.api("GET", `/matches/${made.matchId}/replay`)).status,
            403,
          );
          assert.equal(
            (await c.api("GET", "/history")).data.items[0].status,
            "ABORTED",
          );
          assert.equal((await c.api("GET", "/stats")).data.count, 0);
          const verify = new DatabaseSync(join(dir, "db.sqlite"), {
            readOnly: true,
          });
          const a = JSON.parse(
            (
              verify
                .prepare(
                  "SELECT payload FROM documents WHERE kind='match' AND id=?",
                )
                .get(made.matchId) as any
            ).payload,
          );
          assert.equal(
            a.events.filter((e: any) => e.type === "MATCH_ABORTED").length,
            1,
          );
          assert(
            verify
              .prepare(
                "SELECT id FROM documents WHERE kind='quarantine' AND id=?",
              )
              .get(made.matchId),
          );
          verify.close();
          await stop("SIGKILL");
          c.close();
          await start();
          await c.connect();
          await c.attach(made.matchId);
          assert.equal(c.frame!.state.status, "ABORTED");
          const receiptAfter = new DatabaseSync(join(dir, "db.sqlite"), {
            readOnly: true,
          });
          const persisted = JSON.parse(
            (
              receiptAfter
                .prepare(
                  "SELECT payload FROM documents WHERE kind='receipt' AND id=?",
                )
                .get(
                  `${made.matchId}:${saved.userId}:${saved.receipt.requestId}`,
                ) as any
            ).payload,
          );
          assert.equal(persisted.receipt.receiptId, saved.receipt.receiptId);
          receiptAfter.close();
          c.close();
        },
      );
      await checkedTest(
        "real AI actions leave at least two seconds (2-6s think) between bot discards",
        async () => {
          await stop();
          fastTest = false;
          await start();
          const c = client();
          await c.login("pacing-check");
          const observed: { id: string; at: number }[] = [];
          c.socket.on("game:view", (f: Frame) => {
            const last = f.state.hand.lastDiscard;
            if (
              last &&
              f.state.players[last.seat].participantKind === "BOT" &&
              !observed.some((x) => x.id === last.discardId)
            )
              observed.push({ id: last.discardId, at: performance.now() });
          });
          await makeRoom([c]);
          c.auto = true;
          await c.step();
          await until(() => observed.length >= 3, 45000);
          for (let i = 1; i < 3; i++)
            assert(
              observed[i].at - observed[i - 1].at >= 1800,
              `AI discard gap ${observed[i].at - observed[i - 1].at}ms`,
            );
          pacingGapsMs = observed
            .slice(1, 3)
            .map((entry, index) => Math.round(entry.at - observed[index].at));
          c.close();
        },
      );
      mkdirSync("reports", { recursive: true });
      writeFileSync(
        "reports/v41-game-network.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            passed: !subtestFailed,
            version: APP_VERSION,
            protocol: "2.0",
            rematches: 3,
            formats: ["EAST_ONLY", "HANCHAN"],
            combinations: ["4+0", "3+1", "2+2", "1+3"],
            restart: "SIGKILL",
            aiDiscardGapsMs: pacingGapsMs,
            serverLog: output
              .split("\n")
              .filter((l) => !l.includes("TRANSACTION_FAILURE"))
              .slice(-20),
          },
          null,
          2,
        ),
      );
    } finally {
      clients.forEach((c) => c.close());
      await stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
