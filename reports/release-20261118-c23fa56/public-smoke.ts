import { io, type Socket } from "socket.io-client";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { chooseBot } from "../../backend/src/bot.ts";
import type { Frame, Room, Action } from "../../shared/types.ts";
const origin = process.argv[2] ?? "http://127.0.0.1:3000";
const paceOnly = process.argv.includes("--pace-only");
const paceCheck = paceOnly || process.argv.includes("--pace-check");
const maxDuration = Number(process.env.SMOKE_MAX_MS ?? 1800000);
const count = paceCheck ? 4 : Number(process.argv[3] ?? 2);
const aiDiscards: { id: string; at: number }[] = [];
let pacingReleased = false;
const clients: {
  cookie: string;
  userId: string;
  socket: Socket;
  binding: string;
  frame: Frame | null;
}[] = [];
async function api(
  c: { cookie: string },
  method: string,
  path: string,
  body?: unknown,
) {
  const r = await fetch(origin + "/api/v2" + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: c.cookie,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookie = r.headers.get("set-cookie");
  if (cookie) c.cookie = cookie.split(";")[0];
  const out = await r.json();
  if (!r.ok) throw Error(out.error?.code + ": " + out.error?.message);
  return out.data;
}
function emit(
  c: (typeof clients)[number],
  event: string,
  payload: unknown,
): Promise<any> {
  return new Promise((res, rej) =>
    c.socket
      .timeout(10000)
      .emit(
        event,
        { protocolVersion: "2.0", requestId: crypto.randomUUID(), payload },
        (e: Error | null, r: any) => {
          if (e) rej(e);
          else if (!r.ok) rej(Error(r.error.code + ": " + r.error.message));
          else res(r.data);
        },
      ),
  );
}
const started = Date.now();
try {
  for (let i = 0; i < count; i++) {
    const c = {
      cookie: "",
      userId: "",
      socket: null as unknown as Socket,
      binding: "",
      frame: null as Frame | null,
    };
    const u = await api(c, "POST", "/sessions/guest", {
      displayName: "部署验证" + (i + 1),
    });
    c.userId = u.userId;
    c.socket = io(origin + "/game", {
      transports: ["websocket"],
      extraHeaders: { Origin: origin, Cookie: c.cookie },
      auth: { protocolVersion: "2.0" },
      reconnection: false,
    });
    clients.push(c);
    await new Promise<void>((res, rej) => {
      c.socket.once("connect", () => res());
      c.socket.once("connect_error", rej);
    });
    c.socket.on("game:view", (f: Frame) => {
      c.frame = f;
      const last = f.state.hand.lastDiscard;
      if (
        paceCheck &&
        c === clients[0] &&
        !pacingReleased &&
        last?.seat === f.state.viewerSeat &&
        !aiDiscards.some((d) => d.id === last.discardId)
      )
        aiDiscards.push({ id: last.discardId, at: performance.now() });
    });
    c.binding = (await emit(c, "session:claim", { takeover: false })).bindingId;
  }
  const host = clients[0];
  let room: Room = await api(host, "POST", "/rooms", {
    format: "EAST_ONLY",
    rulesetId: "riichi-4p-v1.0",
    timePresetId: "standard-v1",
  });
  for (const c of clients.slice(1))
    room = await api(c, "POST", "/rooms/join", { inviteCode: room.inviteCode });
  for (let s = count; s < 4; s++)
    room = await api(host, "PUT", `/rooms/${room.roomId}/slots/${s}/bot`, {
      botLevel: "STANDARD",
      expectedRoomVersion: room.roomVersion,
      lobbyGeneration: room.lobbyGeneration,
    });
  for (const c of clients)
    room = await api(c, "PUT", `/rooms/${room.roomId}/ready`, {
      ready: true,
      expectedRoomVersion: room.roomVersion,
      lobbyGeneration: room.lobbyGeneration,
    });
  const { matchId } = await api(host, "POST", `/rooms/${room.roomId}/start`, {
    expectedRoomVersion: room.roomVersion,
    lobbyGeneration: room.lobbyGeneration,
  });
  for (const c of clients) {
    await emit(c, "game:attach", {
      matchId,
      bindingId: c.binding,
      lastStreamId: null,
      lastViewSeq: null,
    });
    await emit(c, "game:control", {
      matchId,
      bindingId: c.binding,
      mode: "HUMAN",
    });
  }
  console.log(
    "Public match started:",
    matchId,
    "with",
    count,
    "human sessions",
  );
  const sent = new Set<string>();
  let handoverMs: number | undefined;
  while (!clients.every((c) => c.frame?.state.status === "FINISHED")) {
    if (Date.now() - started > (paceOnly ? 60000 : maxDuration))
      throw Error("Public smoke test exceeded its configured time budget");
    if (paceCheck && !pacingReleased && aiDiscards.length >= 3) {
      const gaps = aiDiscards
        .slice(1, 3)
        .map((d, i) => Math.round(d.at - aiDiscards[i].at));
      if (gaps.some((ms) => ms < 1800))
        throw Error(`AI pacing too fast: ${gaps.join(",")}`);
      console.log("Public AI discard gaps (ms):", gaps);
      await emit(clients[0], "game:control", {
        matchId,
        bindingId: clients[0].binding,
        mode: "HUMAN",
      });
      pacingReleased = true;
      if (paceOnly) {
        mkdirSync("reports", { recursive: true });
        writeFileSync(
          "reports/public-pace.json",
          JSON.stringify(
            {
              origin,
              at: new Date().toISOString(),
              matchId,
              aiDiscardGapsMs: gaps,
              latestDiscardReceived: !!clients[0].frame!.state.hand.lastDiscard,
              pacingPassed: true,
              fullMatchVerified: false,
            },
            null,
            2,
          ),
        );
        console.log("Public pacing and latest-discard checks passed");
        break;
      }
    }
    for (const c of clients) {
      const f = c.frame,
        d = f?.state.self.decision;
      if (!f || !d?.canSubmit || sent.has(d.decisionId)) continue;
      if (handoverMs === undefined && !paceCheck && d.options.some((o) => o.type === "DISCARD") && d.deadlineAt - f.serverTime > 8000) {
        const before = performance.now();
        const previousDiscard = f.state.hand.lastDiscard?.discardId;
        await emit(c, "game:control", { matchId, bindingId: c.binding, mode: "AI" });
        while (performance.now() - before < 5000) {
          const latest = c.frame?.state.hand.lastDiscard;
          if (latest?.seat === f.state.viewerSeat && latest.discardId !== previousDiscard) break;
          if (c.frame?.state.phase === "HAND_RESULT") break;
          await delay(40);
        }
        handoverMs = Math.round(performance.now() - before);
        if (handoverMs >= 5000) throw Error("AI did not act on the open turn within 5 seconds");
        await emit(c, "game:control", { matchId, bindingId: c.binding, mode: "HUMAN" });
        console.log("AI took over the open turn in", handoverMs, "ms");
        continue;
      }
      sent.add(d.decisionId);
      const p: Action = {
        matchId,
        handId: f.state.hand.handId,
        serverEpoch: f.serverEpoch,
        bindingId: c.binding,
        windowId: d.windowId,
        decisionId: d.decisionId,
        optionId: chooseBot(f.state),
        lastSeenViewSeq: f.viewSeq,
      };
      const receipt = await emit(c, "game:action", p);
      if (receipt.status !== "ACCEPTED")
        throw Error(JSON.stringify(receipt.error));
    }
    await delay(100);
  }
  if (paceOnly && !pacingReleased)
    throw Error("Not enough AI discards to verify pacing");
  if (!paceOnly) {
    if (!paceCheck && handoverMs === undefined) throw Error("No handover verified");
    const replay = await api(host, "GET", `/matches/${matchId}/replay`);
    const points = clients[0].frame!.state.matchResult!.finalPoints;
    if (points.reduce((a, b) => a + b, 0) !== 100000)
      throw Error("Point conservation failed");
    mkdirSync("reports", { recursive: true });
    writeFileSync(
      paceCheck
        ? "reports/public-smoke-pacing.json"
        : "reports/release-20261118-c23fa56/production-match.json",
      JSON.stringify(
        {
          origin,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - started,
          humanSessions: count,
          aiSeats: 4 - count,
          matchId,
          points,
          replayEvents: replay.events.length,
          handoverMs,
          ...(paceCheck
            ? {
                aiDiscardGapsMs: aiDiscards
                  .slice(1, 3)
                  .map((d, i) => Math.round(d.at - aiDiscards[i].at)),
              }
            : {}),
          passed: true,
        },
        null,
        2,
      ),
    );
    console.log(
      "Public full-match smoke test passed:",
      points,
      "elapsed",
      Date.now() - started,
      "ms",
    );
  }
} finally {
  clients.forEach((c) => c.socket?.disconnect());
}
