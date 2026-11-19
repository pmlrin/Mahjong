import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";
import type { MatchFound, PublicLobby, Room } from "../shared/types.ts";

const origin = "http://127.0.0.1:3141",
  dir = mkdtempSync(join(tmpdir(), "mahjong-lobby-"));
let child: ChildProcess;
let output = "";

class Client {
  cookie = "";
  userId = "";
  socket!: Socket;
  lobby: PublicLobby | null = null;
  found: MatchFound | null = null;
  async api(method: string, path: string, body?: unknown) {
    const r = await fetch(origin + "/api/v2" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const c = r.headers.get("set-cookie");
    if (c) this.cookie = c.split(";")[0];
    return { status: r.status, ...(await r.json()) };
  }
  emit(event: string, payload: unknown): Promise<any> {
    return new Promise((res, rej) =>
      this.socket
        .timeout(5000)
        .emit(
          event,
          { protocolVersion: "2.0", requestId: crypto.randomUUID(), payload },
          (e: Error, r: any) => (e ? rej(e) : res(r)),
        ),
    );
  }
  async login(name: string) {
    const r = await this.api("POST", "/sessions/guest", { displayName: name });
    assert.equal(r.status, 200);
    this.userId = r.data.userId;
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
    this.socket.on("lobby:rooms", (l: PublicLobby) => (this.lobby = l));
    this.socket.on("match:found", (m: MatchFound) => (this.found = m));
    assert((await this.emit("session:claim", { takeover: false })).ok);
  }
}
const clients: Client[] = [];
async function login(name: string) {
  const c = new Client();
  clients.push(c);
  await c.login(name);
  return c;
}
async function until<T>(fn: () => T | null | undefined | false, ms = 5000) {
  for (let t = 0; t < ms; t += 50) {
    const v = fn();
    if (v) return v;
    await delay(50);
  }
  throw Error("timed out\n" + output);
}

test.before(async () => {
  child = spawn(
    process.execPath,
    ["--import", "tsx", "backend/src/server.ts"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        PORT: "3141",
        HOST: "127.0.0.1",
        NODE_ENV: "test",
        FAST_TEST: "1",
        MATCH_BOT_FILL_MS: "1500",
        SQLITE_PATH: join(dir, "db.sqlite"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.on("data", (b) => (output += b));
  child.stderr!.on("data", (b) => (output += b));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin + "/healthz")).ok) return;
    } catch {}
    await delay(50);
  }
  throw Error("Server failed: " + output);
});
test.after(async () => {
  for (const c of clients) c.socket?.disconnect();
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await exited;
  rmSync(dir, { recursive: true, force: true });
});

test("public rooms are listed live and anyone can sit, taking a bot's seat", async () => {
  const host = await login("房主"),
    watcher = await login("路人"),
    late = await login("后来者");
  const lobby = await watcher.emit("lobby:watch", { watch: true });
  assert(lobby.ok);
  assert.equal(lobby.data.rooms.length, 0);
  assert(lobby.data.online >= 3);

  let r: Room = (
    await host.api("POST", "/rooms", {
      format: "EAST_ONLY",
      rulesetId: "riichi-4p-v1.0",
      timePresetId: "standard-v1",
      visibility: "PUBLIC",
    })
  ).data;
  assert.equal(r.visibility, "PUBLIC");
  const listed = await until(() =>
    watcher.lobby?.rooms.find((x) => x.roomId === r.roomId),
  );
  assert.equal(listed.openSeats, 3);
  assert.equal(listed.seats[0]?.host, true);
  // The public list never leaks private identifiers.
  assert(!JSON.stringify(watcher.lobby).includes(host.userId));
  assert(!JSON.stringify(watcher.lobby).includes(r.inviteCode));

  // Fill the remaining seats with bots: the table stays joinable.
  for (const s of [1, 2, 3])
    r = (
      await host.api("PUT", `/rooms/${r.roomId}/slots/${s}/bot`, {
        botLevel: "STANDARD",
        expectedRoomVersion: r.roomVersion,
        lobbyGeneration: r.lobbyGeneration,
      })
    ).data;
  const joined = await watcher.api("POST", `/rooms/${r.roomId}/join`, {});
  assert.equal(joined.status, 200);
  assert.equal(
    joined.data.slots.filter((m: any) => m?.participantKind === "HUMAN").length,
    2,
  );
  await until(
    () =>
      watcher.lobby?.rooms.find((x) => x.roomId === r.roomId)?.openSeats === 2,
  );

  // Going private removes it from the lobby and blocks direct joins.
  r = joined.data;
  const hidden = await host.api("PUT", `/rooms/${r.roomId}/visibility`, {
    visibility: "PRIVATE",
    expectedRoomVersion: r.roomVersion,
    lobbyGeneration: r.lobbyGeneration,
  });
  assert.equal(hidden.status, 200);
  await until(
    () =>
      watcher.lobby && !watcher.lobby.rooms.some((x) => x.roomId === r.roomId),
  );
  const refused = await late.api("POST", `/rooms/${r.roomId}/join`, {});
  assert.equal(refused.status, 404);

  // A non-host cannot change visibility.
  const notHost = await watcher.api("PUT", `/rooms/${r.roomId}/visibility`, {
    visibility: "PUBLIC",
    expectedRoomVersion: hidden.data.roomVersion,
    lobbyGeneration: hidden.data.lobbyGeneration,
  });
  assert.equal(notHost.status, 403);
  for (const c of [host, watcher])
    await c.api("POST", `/rooms/${r.roomId}/leave`, {
      lobbyGeneration: r.lobbyGeneration,
    });
});

test("four queued players are matched straight into a running game", async () => {
  const cs = await Promise.all(
    ["甲", "乙", "丙", "丁"].map((n) => login("匹配" + n)),
  );
  for (const c of cs) {
    const q = await c.api("POST", "/match/queue", { format: "HANCHAN" });
    assert.equal(q.status, 200);
    assert.equal(q.data.queued, true);
  }
  const found = await Promise.all(cs.map((c) => until(() => c.found)));
  assert.equal(new Set(found.map((f) => f.matchId)).size, 1);
  const room: Room = (await cs[0].api("GET", "/rooms/" + found[0].roomId)).data;
  assert.equal(room.status, "PLAYING");
  assert.equal(room.config.format, "HANCHAN");
  assert.equal(room.visibility, "PRIVATE");
  assert(room.slots.every((m) => m?.participantKind === "HUMAN"));
  const status = await cs[1].api("GET", "/match/queue");
  assert.equal(status.data.queued, false);
  // Already seated: the queue refuses.
  assert.equal(
    (await cs[2].api("POST", "/match/queue", { format: "EAST_ONLY" })).status,
    409,
  );
  for (const c of cs) c.socket.disconnect();
});

test("two waiting players get bots after the fill delay; cancel and disconnect leave the queue", async () => {
  const a = await login("等人甲"),
    b = await login("等人乙"),
    quitter = await login("走人");
  await quitter.api("POST", "/match/queue", { format: "EAST_ONLY" });
  assert.equal(
    (await quitter.api("DELETE", "/match/queue")).data.queued,
    false,
  );
  await a.api("POST", "/match/queue", { format: "EAST_ONLY" });
  const q = await b.api("POST", "/match/queue", { format: "EAST_ONLY" });
  assert.equal(q.data.waiting, 2);
  assert(q.data.botFillAt);
  const found = await until(() => a.found);
  assert.equal(
    b.found?.matchId ?? (await until(() => b.found)).matchId,
    found.matchId,
  );
  const room: Room = (await a.api("GET", "/rooms/" + found.roomId)).data;
  assert.equal(
    room.slots.filter((m) => m?.participantKind === "BOT").length,
    2,
  );
  assert.equal(room.status, "PLAYING");

  // A lone waiter who disconnects is dropped.
  const lone = await login("独行");
  await lone.api("POST", "/match/queue", { format: "HANCHAN" });
  lone.socket.disconnect();
  await delay(1500);
  await lone.login("独行回来");
  assert.equal((await lone.api("GET", "/match/queue")).data.queued, false);
});
