import { useSocial } from "./use-social";
import { SocialPage } from "./social-page";
import { Avatar } from "./Avatar";
import type { SocialCapabilities } from "../../shared/social";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import {
  kind,
  isRed,
  tileName,
  PROTOCOL,
  RULESET,
  WINDS,
  type Room,
  type Frame,
  type MatchView,
  type Option,
  type Result,
  type Seat,
  type Envelope,
  type Action,
  type CurrentUser,
  type AuthCapabilities,
} from "../../shared/types";
import "./style.css";
import { api } from "./api";
import { AccountPanel, type AccountPage } from "./account";
import { History, Stats, formatName } from "./history-pages";
import { Tile } from "./Tile";
import { Melds } from "./Melds";
import { TableSurface } from "./TableSurface";
import { CallChoices, ResponseSource } from "./turn-feedback";
import { responseTarget } from "../../shared/game-feedback";
const uuid = () => crypto.randomUUID();
type Me = CurrentUser;
const actionNames: Record<string, string> = {
  DISCARD: "打出",
  RIICHI_DISCARD: "立直并打出",
  TSUMO: "自摸",
  RON: "荣和",
  PASS: "过",
  PON: "碰",
  CHI: "吃",
  ANKAN: "暗杠",
  KAKAN: "加杠",
  DAIMINKAN: "明杠",
  ABORT_KYUUSHU: "九种九牌",
};
const resultNames: Record<string, string> = {
  TSUMO: "自摸",
  RON: "荣和",
  EXHAUSTIVE_DRAW: "荒牌流局",
  NAGASHI_MANGAN: "流局满贯",
  ABORT_KYUUSHU: "九种九牌",
  ABORT_FOUR_WINDS: "四风连打",
  ABORT_FOUR_RIICHI: "四家立直",
  ABORT_FOUR_KANS: "四杠散了",
  ABORT_TRIPLE_RON: "三家和",
};
const endNames: Record<string, string> = {
  BANKRUPTCY: "飞人终局",
  DEALER_AGARI_YAME: "庄家和了止",
  DEALER_TENPAI_YAME: "庄家听牌止",
  SCHEDULE_COMPLETE: "计划赛程结束",
  EXTENSION_TARGET_REACHED: "延长达到目标点数",
  EXTENSION_HARD_LIMIT: "延长场结束",
};
const wind = (w: string) =>
  ({ EAST: "东", SOUTH: "南", WEST: "西", NORTH: "北" })[w] ?? w;
function App() {
  const [me, setMe] = useState<Me | null>(null),
    [boot, setBoot] = useState(true),
    [name, setName] = useState(""),
    [code, setCode] = useState(
      new URLSearchParams(location.search).get("invite") ?? "",
    ),
    [room, setRoom] = useState<Room | null>(null),
    [frame, setFrame] = useState<Frame | null>(null),
    [screen, setScreen] = useState<
      | "home"
      | "room"
      | "game"
      | "rules"
      | "replay"
      | "history"
      | "stats"
      | "settings"
      | "account"
      | "social"
    >(() =>
      new URLSearchParams(location.search).has("replay") ? "replay" : "home",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [network, setNetwork] = useState(false),
    [takeover, setTakeover] = useState(false),
    [sound, setSound] = useState(localStorage.getItem("mj_sound") === "true"),
    [rules, setRules] = useState(""),
    [format, setFormat] = useState<"EAST_ONLY" | "HANCHAN">("EAST_ONLY"),
    [replayTarget, setReplayTarget] = useState<{
      id: string;
      handId?: string;
    } | null>(() => {
      const id = new URLSearchParams(location.search).get("replay");
      return id ? { id } : null;
    }),
    [size, setSize] = useState(
      localStorage.getItem("mj_tableSize") ?? "standard",
    ),
    [reduced, setReduced] = useState(
      localStorage.getItem("mj_reducedMotion") === "true",
    ),
    [diagnostic, setDiagnostic] = useState(""),
    [capabilities, setCapabilities] = useState<{
      formats: ("EAST_ONLY" | "HANCHAN")[];
      botLevels: ("BASIC" | "STANDARD")[];
      maintenance: boolean;
      auth?: AuthCapabilities;
      profileEditing?: boolean;
      sessionManagement?: boolean;
      friends?: boolean;
      friendInvitations?: boolean;
    } | null>(null),
    [accountPage, setAccountPage] = useState<AccountPage>("profile"),
    [sessionEpoch, setSessionEpoch] = useState(0),
    [authPaused, setAuthPaused] = useState(false);
  const social = useSocial(
    me?.identityKind === "ACCOUNT" && !authPaused
      ? me.userId + ":" + sessionEpoch
      : null,
    !!capabilities?.friends,
    network,
  );
  const socialRefresh = useRef(social.refresh);
  socialRefresh.current = social.refresh;
  const initialReplayIntent = useRef(
    new URLSearchParams(location.search).has("replay"),
  );
  const identityGeneration = useRef(0);
  const socket = useRef<Socket | null>(null),
    binding = useRef(""),
    latest = useRef<Frame | null>(null),
    roomRef = useRef<Room | null>(null),
    meRef = useRef<Me | null>(null),
    soundRef = useRef(sound);
  roomRef.current = room;
  meRef.current = me;
  soundRef.current = sound;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if ((e as any).code === "UNAUTHENTICATED") {
        clearIdentityContext(true);
        setAccountPage("login");
        setScreen("account");
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  function emit<T>(
    event: string,
    payload: T,
    requestId: string = uuid(),
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const s = socket.current,
        generation = identityGeneration.current;
      if (!s?.connected) {
        reject(new Error("网络连接中，请稍候"));
        return;
      }
      s.timeout(10000).emit(
        event,
        { protocolVersion: PROTOCOL, requestId, payload },
        (err: Error | null, r: any) => {
          if (
            socket.current !== s ||
            identityGeneration.current !== generation
          ) {
            reject(new Error("身份或连接已变化，请重新同步"));
            return;
          }
          if (err) reject(new Error("操作回执尚未收到，正在重新同步"));
          else if (!r?.ok)
            reject(
              Object.assign(new Error(r?.error?.message ?? "操作未成功"), {
                code: r?.error?.code,
              }),
            );
          else resolve(r.data);
        },
      );
    });
  }
  async function attach(matchId: string) {
    if (!binding.current) return;
    const generation = identityGeneration.current;
    await emit("game:attach", {
      matchId,
      bindingId: binding.current,
      lastStreamId: latest.current?.streamId ?? null,
      lastViewSeq: latest.current?.viewSeq ?? null,
    });
    if (generation === identityGeneration.current) setScreen("game");
  }
  async function watch(r: Room) {
    const generation = identityGeneration.current;
    if (!r.slots.some((member) => member?.userId === meRef.current?.userId))
      return;
    setRoom(r);
    await emit("room:watch", { roomId: r.roomId });
    if (generation !== identityGeneration.current) return;
    if (r.matchId) await attach(r.matchId);
    else setScreen("room");
  }
  async function claim(force = false) {
    const generation = identityGeneration.current,
      connection = socket.current;
    const valid = () =>
      generation === identityGeneration.current &&
      connection === socket.current;
    try {
      const r = await emit("session:claim", { takeover: force });
      if (!valid()) return;
      binding.current = r.bindingId;
      setTakeover(false);
      const u = await api<Me>("/me");
      if (!valid()) return;
      meRef.current = u;
      setMe(u);
      if (u.roomId) {
        const r = await api<Room>("/rooms/" + u.roomId);
        if (!valid()) return;
        await watch(r);
      } else if (roomRef.current?.matchId)
        await attach(roomRef.current.matchId);
      if (!valid()) return;
      if (initialReplayIntent.current) {
        setScreen("replay");
        initialReplayIntent.current = false;
      }
    } catch (e) {
      if (!valid()) return;
      if ((e as any).code === "CONTROL_IN_USE") {
        setTakeover(true);
        binding.current = "";
      } else setError((e as Error).message);
    }
  }
  useEffect(() => {
    api<any>("/capabilities")
      .then(setCapabilities)
      .catch((e) => setError(e.message));
    api<Me>("/me")
      .then(setMe)
      .catch(() => {})
      .finally(() => setBoot(false));
  }, []);
  useEffect(() => {
    if (!me?.userId || authPaused) return;
    const s = io("/game", {
      path: import.meta.env.BASE_URL + "socket.io",
      auth: { protocolVersion: PROTOCOL },
      withCredentials: true,
    });
    socket.current = s;
    let active = true;
    const expectedUser = me.userId,
      generation = identityGeneration.current;
    const valid = () =>
      active &&
      generation === identityGeneration.current &&
      meRef.current?.userId === expectedUser;
    s.on("connect", () => {
      if (!valid()) return;
      setNetwork(true);
      claim();
    });
    s.on("disconnect", () => {
      if (!valid()) return;
      setNetwork(false);
      binding.current = "";
    });
    s.on("connect_error", (e) => {
      if (!valid()) return;
      setNetwork(false);
      setError(e.message);
    });
    s.on("social:changed", () => {
      if (valid()) void socialRefresh.current();
    });
    s.on("room:view", (r: Room) => {
      if (!valid()) return;
      if (roomRef.current && roomRef.current.roomId !== r.roomId) return;
      if (
        r.status === "CLOSED" ||
        !r.slots.some((m) => m?.userId === meRef.current?.userId)
      ) {
        if (roomRef.current?.roomId === r.roomId) {
          setRoom(null);
          setMe((old) =>
            old ? { ...old, roomId: null, matchId: null } : null,
          );
          setScreen("home");
        }
        return;
      }
      if (
        r.status === "WAITING" &&
        (!roomRef.current ||
          r.lobbyGeneration > roomRef.current.lobbyGeneration)
      ) {
        latest.current = null;
        setFrame(null);
        setScreen("room");
      }
      roomRef.current = r;
      setRoom((old) =>
        old && old.roomId === r.roomId && old.roomViewSeq > r.roomViewSeq
          ? old
          : r,
      );
      if (r.matchId && r.matchId !== latest.current?.matchId && binding.current)
        attach(r.matchId).catch((e) => setError(e.message));
    });
    s.on("game:view", (f: Frame) => {
      if (!valid()) return;
      if (
        roomRef.current?.status === "WAITING" &&
        roomRef.current.previousMatchIds.includes(f.matchId)
      )
        return;
      const old = latest.current;
      if (
        old &&
        old.streamId === f.streamId &&
        (f.viewSeq < old.viewSeq || (f.viewSeq === old.viewSeq && !f.syncId))
      )
        return;
      if (old && old.streamId !== f.streamId && !f.syncId) return;
      latest.current = f;
      setFrame(f);
      if (
        soundRef.current &&
        old?.state.hand.seats.reduce((n, s) => n + s.discards.length, 0) !==
          f.state.hand.seats.reduce((n, s) => n + s.discards.length, 0)
      )
        beep();
    });
    s.on("server:notice", (n: { code: string; message: string }) => {
      if (!valid()) return;
      setError(n.message);
      if (n.code === "SESSION_REVOKED" || n.code === "AUTH_CONTEXT_RELEASED") {
        clearIdentityContext(n.code === "SESSION_REVOKED");
        setAuthPaused(true);
        if (n.code === "SESSION_REVOKED") {
          setAccountPage("login");
          setScreen("account");
        }
        return;
      }
      if (n.code === "CONTROL_REVOKED") {
        binding.current = "";
        setTakeover(true);
        latest.current = null;
        setFrame(null);
      }
    });
    return () => {
      active = false;
      s.removeAllListeners();
      s.disconnect();
      socket.current = null;
    };
  }, [me?.userId, sessionEpoch, authPaused]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (screen === "replay" && replayTarget)
      params.set("replay", replayTarget.id);
    else params.delete("replay");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }, [screen, replayTarget]);
  async function login() {
    await run(async () => {
      const u = await api<Me>("/sessions/guest", "POST", {
        displayName: name.trim(),
      });
      setMe({ ...u, roomId: null, matchId: null });
    });
  }
  const inviteConsumed = useRef(false);
  useEffect(() => {
    if (
      screen === "account" ||
      authPaused ||
      !me ||
      !network ||
      !binding.current ||
      !code ||
      inviteConsumed.current
    )
      return;
    const pending = new URLSearchParams(location.search).get("invite");
    if (!pending) return;
    inviteConsumed.current = true;
    const generation = identityGeneration.current;
    run(async () => {
      try {
        const r = await api<Room>("/rooms/join", "POST", { inviteCode: code });
        if (generation !== identityGeneration.current) return;
        await watch(r);
        const params = new URLSearchParams(location.search);
        params.delete("invite");
        const query = params.toString();
        history.replaceState(
          null,
          "",
          location.pathname + (query ? "?" + query : ""),
        );
      } catch (error) {
        inviteConsumed.current = false;
        throw error;
      }
    });
  }, [me, network, takeover, screen, authPaused]);
  async function newRoom() {
    await run(async () => {
      const r = await api<Room>("/rooms", "POST", {
        format,
        rulesetId: RULESET,
        timePresetId: "standard-v1",
      });
      latest.current = null;
      setFrame(null);
      await watch(r);
    });
  }
  async function join() {
    await run(async () =>
      watch(await api<Room>("/rooms/join", "POST", { inviteCode: code })),
    );
  }
  async function roomAction(path: string, method: string, body?: unknown) {
    await run(async () => {
      try {
        const r = await api<Room>(
          "/rooms/" + room!.roomId + path,
          method,
          {
            ...((body as object) ?? {}),
            lobbyGeneration: room!.lobbyGeneration,
          },
          method === "DELETE"
            ? {
                expectedRoomVersion: String(room!.roomVersion),
                "Lobby-Generation": String(room!.lobbyGeneration),
              }
            : {},
        );
        if (r.roomId) {
          setRoom(r);
          if (path === "/config" || path.endsWith("/bot"))
            setError("配置已变更，请重新准备");
        }
      } catch (e) {
        setRoom(await api<Room>("/rooms/" + room!.roomId));
        throw e;
      }
    });
  }
  async function showRules() {
    setScreen("rules");
    if (!rules)
      try {
        setRules(await api<string>("/rules"));
      } catch (e) {
        setError((e as Error).message);
      }
  }
  function toggleSound() {
    setSound((v) => {
      localStorage.setItem("mj_sound", String(!v));
      if (!v) beep();
      return !v;
    });
  }
  async function copyDiagnostic() {
    await run(async () => {
      const d = await api<any>("/diagnostics", "POST", {
        roomId: room?.roomId ?? null,
        matchId: frame?.matchId ?? null,
      });
      const text = JSON.stringify(d, null, 2);
      setDiagnostic(text);
      try {
        await navigator.clipboard.writeText(text);
        setError("诊断信息已复制，编号：" + d.diagnosticId);
      } catch {
        setScreen("settings");
      }
    });
  }
  function openReplay(id: string, handId?: string) {
    setReplayTarget({ id, handId });
    setScreen("replay");
  }
  async function rematch() {
    if (!room) return;
    await run(async () => {
      const r = await api<Room>("/rooms/" + room.roomId);
      const next = await api<Room>("/rooms/" + r.roomId + "/rematch", "POST", {
        expectedRoomVersion: r.roomVersion,
        lobbyGeneration: r.lobbyGeneration,
      });
      latest.current = null;
      setFrame(null);
      roomRef.current = next;
      await watch(next);
    });
  }
  function clearIdentityContext(clearMe: boolean) {
    identityGeneration.current++;
    inviteConsumed.current = false;
    binding.current = "";
    latest.current = null;
    roomRef.current = null;
    setRoom(null);
    setFrame(null);
    setTakeover(false);
    setReplayTarget(null);
    initialReplayIntent.current = false;
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("mj_pending_")) sessionStorage.removeItem(key);
    if (clearMe) {
      meRef.current = null;
      setMe(null);
    }
    setNetwork(false);
  }
  function openAccount(page: AccountPage = "profile") {
    setAccountPage(page);
    setScreen("account");
  }
  async function authIdentity(result: "changed" | "logout" | "loginRequired") {
    if (result === "logout") {
      clearIdentityContext(true);
      setAuthPaused(false);
      setSessionEpoch((v) => v + 1);
      setScreen("home");
      return;
    }
    if (result === "loginRequired") {
      const current = await api<Me>("/me").catch(() => null);
      setMe(current);
      if (!current) clearIdentityContext(true);
      setAccountPage("login");
      setScreen("account");
      setError("操作已完成，请用账号密码重新登录；当前游客记录不会合并");
      return;
    }
    const current = await api<Me>("/me");
    clearIdentityContext(false);
    setMe(current);
    meRef.current = current;
    setAuthPaused(false);
    setSessionEpoch((v) => v + 1);
    setAccountPage(current.identityKind === "GUEST" ? "register" : "profile");
    setScreen("account");
    setCapabilities(await api<any>("/capabilities"));
  }
  async function releaseForAuth() {
    await api("/auth/release-control", "POST", {});
    clearIdentityContext(false);
    setAuthPaused(true);
    setMe((old) => (old ? { ...old, roomId: null, matchId: null } : null));
    setScreen("account");
  }
  function cancelAccount() {
    setAuthPaused(false);
    setSessionEpoch((v) => v + 1);
    setScreen(frame ? "game" : "home");
  }
  const view = frame?.state;
  return (
    <div
      className={`app ${screen === "game" ? "game-app" : ""} table-${size} ${reduced ? "reduce-motion" : ""}`}
    >
      <header className="header">
        <button className="brand" onClick={() => setScreen("home")}>
          <span className="brand-seal">一</span>
          <span>
            一桌<span className="brand-en">ICHITAKU</span>
          </span>
        </button>
        <nav>
          <button
            className={screen === "home" ? "active" : ""}
            onClick={() => setScreen("home")}
          >
            会客厅
          </button>
          {room && (
            <button onClick={() => setScreen(room.matchId ? "game" : "room")}>
              我的牌桌
            </button>
          )}
          {me && (
            <>
              <button onClick={() => setScreen("history")}>历史战绩</button>
              <button onClick={() => setScreen("stats")}>我的统计</button>
            </>
          )}
          {me?.identityKind === "ACCOUNT" && capabilities?.friends && (
            <button
              className={screen === "social" ? "active" : ""}
              onClick={() => setScreen("social")}
            >
              好友{" "}
              {social.snapshot?.counts.total ? (
                <span className="social-badge">
                  {social.snapshot.counts.total}
                </span>
              ) : null}
            </button>
          )}
          <button onClick={() => setScreen("settings")}>设置</button>
          <button onClick={showRules}>
            玩法说明 <span>↗</span>
          </button>
        </nav>
        <div className="user">
          <span className={`status-dot ${network ? "on" : ""}`} />
          <button
            className="account-entry"
            aria-label="个人与账号"
            onClick={() => openAccount()}
          >
            {me?.identityKind === "ACCOUNT" && <Avatar id={me.avatarId} />}
            <span className="identity-name">
              {me?.displayName ?? "欢迎来坐"}
            </span>
            <span className="identity-kind">
              {me ? (me.identityKind === "ACCOUNT" ? "账号" : "游客") : "登录"}
            </span>
          </button>
          <button
            className="icon-button"
            onClick={toggleSound}
            aria-label={sound ? "关闭音效" : "开启音效"}
          >
            {sound ? "♫" : "♩"}
          </button>
        </div>
      </header>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          {me && <button onClick={copyDiagnostic}>复制诊断信息</button>}
          <button onClick={() => setError("")} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {takeover && (
        <div className="takeover">
          <p>另一页面正在控制你的牌桌。</p>
          <button className="primary" onClick={() => run(() => claim(true))}>
            在这里接管
          </button>
        </div>
      )}
      {capabilities?.maintenance && (
        <p className="maintenance-notice" role="status">
          正在维护，已有对局可继续，暂不能开始新比赛。
        </p>
      )}
      {boot ? (
        <main className="loading">正在为你留座…</main>
      ) : screen === "home" ? (
        <main className="lounge">
          <div className="eyebrow">
            <span /> 好友相聚，随时开桌
          </div>
          <div className="hero">
            <section className="hero-copy">
              <h1>
                好牌局，
                <br />从<span>一桌</span>开始<span className="period">。</span>
              </h1>
              <p className="intro">
                把朋友聚在一起，让好时光慢一点。
                <br />
                一场轻松的四人立直麻将，等你落座。
              </p>
              <div className="hero-tags">
                <span>四人立直</span>
                <i /> <span>好友邀请</span>
                <i />
                <span>AI 随时补位</span>
              </div>
              {!me ? (
                <form
                  className="entry-card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    login();
                  }}
                >
                  <label htmlFor="nickname">先认识一下你</label>
                  <div className="entry-row">
                    <input
                      id="nickname"
                      placeholder="起个牌桌上的名字"
                      maxLength={16}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="nickname"
                    />
                    <button className="primary" disabled={busy || !name.trim()}>
                      入座 <span>→</span>
                    </button>
                  </div>
                  <small>以游客身份进入，刷新后仍会为你保留座位。</small>
                  <div className="account-shortcuts">
                    <button
                      type="button"
                      className="text-button"
                      disabled={!capabilities?.auth?.passwordLogin}
                      onClick={() => openAccount("login")}
                    >
                      登录已有账号
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!capabilities?.auth?.registration}
                      onClick={() => openAccount("register")}
                    >
                      注册新账号
                    </button>
                  </div>
                </form>
              ) : (
                <div className="entry-card">
                  <p className="guest-hint">
                    {me.identityKind === "ACCOUNT"
                      ? `正式账号 · ${me.maskedEmail}`
                      : "游客身份，注册后可在其他浏览器登录"}
                  </p>
                  <div className="account-shortcuts">
                    <button
                      className="text-button"
                      onClick={() => openAccount()}
                    >
                      {me.identityKind === "ACCOUNT"
                        ? "个人与账号"
                        : "注册／登录账号"}
                    </button>
                  </div>
                  <label>
                    赛制{" "}
                    <select
                      aria-label="新房间赛制"
                      value={format}
                      onChange={(e) =>
                        setFormat(e.target.value as typeof format)
                      }
                    >
                      {capabilities?.formats.map((f) => (
                        <option key={f} value={f}>
                          {formatName(f)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary create"
                    onClick={newRoom}
                    disabled={
                      busy ||
                      !network ||
                      !capabilities ||
                      capabilities.maintenance
                    }
                  >
                    开一张好友桌 <span>＋</span>
                  </button>
                  <div className="join-line">
                    <input
                      aria-label="房间邀请码"
                      placeholder="输入 6 位邀请码"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                    />
                    <button
                      onClick={join}
                      disabled={busy || code.length !== 6 || !network}
                    >
                      加入 <span>↗</span>
                    </button>
                  </div>
                  {(me.roomId || room) && (
                    <button
                      className="continue"
                      onClick={() =>
                        run(async () => {
                          const u = await api<Me>("/me");
                          if (u.roomId)
                            await watch(await api<Room>("/rooms/" + u.roomId));
                          else if (room) await watch(room);
                        })
                      }
                    >
                      返回我的牌桌 →
                    </button>
                  )}
                </div>
              )}
            </section>
            <div className="hero-art" aria-hidden="true">
              <div className="art-circle" />
              <span className="art-caption">一期一会 · 一局一心</span>
              <div className="art-table">
                <div className="art-line" />
                <span className="art-east">東</span>
                <div className="art-center">
                  一桌<small>GOOD COMPANY. GOOD GAME.</small>
                </div>
                <div className="art-hand">
                  {[0, 4, 8, 36, 40, 44, 72, 76, 80, 112, 113, 128, 129].map(
                    (t) => (
                      <Tile key={t} tile={t} />
                    ),
                  )}
                </div>
                <div className="art-top">
                  {Array.from({ length: 13 }, (_, i) => (
                    <Tile key={i} back />
                  ))}
                </div>
                <div className="art-discards">
                  {[120, 96, 24, 116, 64, 32].map((t) => (
                    <Tile key={t} tile={t} small />
                  ))}
                </div>
                <div className="art-sticks">
                  <i />
                  <i />
                </div>
              </div>
              <div className="art-note">
                <span className="note-dot" />
                无需下载，打开即玩
              </div>
              <span className="art-year">EST. 2026</span>
            </div>
          </div>
          <div className="lounge-bottom">
            <span className="section-caption">把时间留给牌局</span>
            <div>
              <span className="feature-num">01</span>
              <p>
                邀朋友，开一桌<small>分享邀请码，熟悉的人围坐一起。</small>
              </p>
            </div>
            <div>
              <span className="feature-num">02</span>
              <p>
                少个人，也尽兴<small>AI 补齐空位，一个人也能练习。</small>
              </p>
            </div>
            <div>
              <span className="feature-num">03</span>
              <p>
                一局之后，再回味<small>留存牌谱，回看每一次选择。</small>
              </p>
            </div>
          </div>
        </main>
      ) : screen === "room" && room ? (
        <main className="room-page">
          <div className="page-title">
            <div>
              <div className="eyebrow">等朋友的时间，也很好</div>
              <h1>这一桌，等你到齐。</h1>
            </div>
            <div className="room-invite">
              <small>房间邀请码</small>
              <strong>{room.inviteCode}</strong>
              <button
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(
                      location.origin +
                        import.meta.env.BASE_URL +
                        "?invite=" +
                        room.inviteCode,
                    );
                    setError("邀请链接已复制，发给朋友就能入桌");
                  })
                }
              >
                复制邀请链接 ↗
              </button>
            </div>
          </div>
          {me?.identityKind === "ACCOUNT" &&
            capabilities?.friendInvitations &&
            room.hostUserId === me.userId && (
              <button className="secondary" onClick={() => setScreen("social")}>
                邀请站内好友
              </button>
            )}
          <div className="room-meta">
            <span>四人立直 · {formatName(room.config.format)}</span>
            {room.hostUserId === me?.userId && room.status === "WAITING" && (
              <label>
                赛制{" "}
                <select
                  aria-label="房间赛制"
                  value={room.config.format}
                  disabled={busy}
                  onChange={(e) =>
                    roomAction("/config", "PUT", {
                      format: e.target.value,
                      expectedRoomVersion: room.roomVersion,
                    })
                  }
                >
                  {capabilities?.formats.map((f) => (
                    <option key={f} value={f}>
                      {formatName(f)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span>25,000 点起始 · 赤宝牌 · 食断</span>
            <span>行动 15 秒 / 响应 8 秒</span>
          </div>
          <div className="seats">
            {room.slots.map((m, i) => (
              <section className={`seat-card ${m ? "occupied" : ""}`} key={i}>
                <span className="seat-index">SEAT 0{i + 1}</span>
                <div className="seat-avatar">
                  {m ? (
                    m.participantKind === "BOT" ? (
                      "竹"
                    ) : (
                      <Avatar id={m.avatarId} />
                    )
                  ) : (
                    "＋"
                  )}
                </div>
                <h2>{m?.displayName ?? "虚位以待"}</h2>
                <p>
                  {m
                    ? m.participantKind === "BOT"
                      ? `${m.botLevel === "BASIC" ? "基础" : "标准"} · AI 牌友`
                      : `${m.userId === room.hostUserId ? "房主 · " : ""}${m.userId === me?.userId ? "你" : m.connected ? "在线" : "暂时离线"}`
                    : "邀请一位朋友，或让 AI 来陪你"}
                </p>
                {m ? (
                  <>
                    <span className={`ready ${m.ready ? "yes" : ""}`}>
                      {m.ready ? "已准备" : "等待准备"}
                    </span>
                    {m.participantKind === "BOT" &&
                      room.hostUserId === me?.userId && (
                        <>
                          <label>
                            难度{" "}
                            <select
                              aria-label={`座位 ${i + 1} AI 难度`}
                              value={m.botLevel ?? "STANDARD"}
                              disabled={busy}
                              onChange={(e) =>
                                roomAction("/slots/" + i + "/bot", "PUT", {
                                  botLevel: e.target.value,
                                  expectedRoomVersion: room.roomVersion,
                                })
                              }
                            >
                              {capabilities?.botLevels.map((level) => (
                                <option key={level} value={level}>
                                  {level === "BASIC" ? "基础" : "标准"}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              roomAction("/slots/" + i + "/bot", "DELETE")
                            }
                          >
                            移除 AI
                          </button>
                        </>
                      )}
                  </>
                ) : room.hostUserId === me?.userId ? (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      roomAction("/slots/" + i + "/bot", "PUT", {
                        botLevel: "STANDARD",
                        expectedRoomVersion: room.roomVersion,
                      })
                    }
                  >
                    ＋ 邀请 AI
                  </button>
                ) : (
                  <span className="muted">等待朋友加入</span>
                )}
              </section>
            ))}
          </div>
          <div className="room-actions">
            <button
              className="text-button"
              onClick={() =>
                run(async () => {
                  await api("/rooms/" + room.roomId + "/leave", "POST", {
                    lobbyGeneration: room.lobbyGeneration,
                  });
                  setRoom(null);
                  setScreen("home");
                  setMe({ ...me!, roomId: null, matchId: null });
                })
              }
            >
              ← 离开房间
            </button>
            <span>座位将在开始时随机分配</span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                roomAction("/ready", "PUT", {
                  ready: !room.slots.find((m) => m?.userId === me?.userId)
                    ?.ready,
                  expectedRoomVersion: room.roomVersion,
                })
              }
            >
              {room.slots.find((m) => m?.userId === me?.userId)?.ready
                ? "取消准备"
                : "准备好了"}
            </button>
            {room.hostUserId === me?.userId && (
              <button
                className="primary"
                disabled={
                  busy ||
                  capabilities?.maintenance ||
                  room.slots.some((m) => !m || !m.ready)
                }
                onClick={() =>
                  run(async () => {
                    const r = await api<{ matchId: string }>(
                      "/rooms/" + room.roomId + "/start",
                      "POST",
                      {
                        expectedRoomVersion: room.roomVersion,
                        lobbyGeneration: room.lobbyGeneration,
                      },
                    );
                    await attach(r.matchId);
                  })
                }
              >
                开始对局 →
              </button>
            )}
          </div>
          <p className="room-footnote">
            真人全部准备后，由房主开始。成员、赛制或 AI
            难度变更会清空准备。半庄计划至南四，必要时延长；时长随连庄而变化。
          </p>
        </main>
      ) : screen === "game" && view ? (
        <Game
          view={view}
          frame={frame!}
          network={network}
          binding={binding.current}
          emit={emit}
          setError={setError}
          onNew={newRoom}
          onRematch={room?.hostUserId === me?.userId ? rematch : undefined}
          onReplay={() => openReplay(view.matchId)}
        />
      ) : screen === "rules" ? (
        <Rules text={rules} onBack={() => setScreen(view ? "game" : "home")} />
      ) : screen === "social" && me?.identityKind === "ACCOUNT" ? (
        <SocialPage
          key={me.userId + ":" + sessionEpoch}
          snapshot={social.snapshot}
          refresh={social.refresh}
          stale={social.stale}
          error={social.error}
          room={
            room?.status === "WAITING" && room.hostUserId === me.userId
              ? room
              : null
          }
          invitesEnabled={!!capabilities?.friendInvitations}
          onBack={() => setScreen(frame ? "game" : "home")}
          onJoined={async (roomId) => {
            const generation = identityGeneration.current;
            const current = await api<Me>("/me");
            if (generation !== identityGeneration.current) return;
            if (current.roomId !== roomId)
              throw Error("房间状态已变化，请重新查看当前房间");
            setMe(current);
            const joined = await api<Room>("/rooms/" + roomId);
            if (generation !== identityGeneration.current) return;
            await watch(joined);
          }}
        />
      ) : screen === "account" ? (
        <AccountPanel
          key={accountPage}
          socialCapabilities={capabilities ?? {}}
          onFriends={() => setScreen("social")}
          onProfileUpdated={async () => {
            const generation = identityGeneration.current;
            const updated = await api<Me>("/me");
            if (generation === identityGeneration.current) {
              setMe(updated);
              await social.refresh();
            }
          }}
          page={accountPage}
          setPage={setAccountPage}
          me={me}
          capabilities={capabilities?.auth ?? null}
          needsRelease={!!binding.current && !!(room || me?.roomId)}
          onRelease={releaseForAuth}
          onIdentity={authIdentity}
          onCancel={cancelAccount}
        />
      ) : screen === "history" && me ? (
        <History userId={me.userId} onReplay={openReplay} />
      ) : screen === "stats" && me ? (
        <Stats />
      ) : screen === "settings" ? (
        <main className="history-page">
          <h1>设置</h1>
          <div className="settings-list">
            <label>
              牌桌尺寸{" "}
              <select
                value={size}
                onChange={(e) => {
                  setSize(e.target.value);
                  localStorage.setItem("mj_tableSize", e.target.value);
                }}
              >
                <option value="standard">标准</option>
                <option value="compact">紧凑</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={reduced}
                onChange={(e) => {
                  setReduced(e.target.checked);
                  localStorage.setItem(
                    "mj_reducedMotion",
                    String(e.target.checked),
                  );
                }}
              />{" "}
              减少动画
            </label>
            <p>默认先选牌再确认；设置在当前浏览器保存。</p>
            {me && (
              <button
                className="secondary"
                onClick={copyDiagnostic}
                disabled={busy}
              >
                复制诊断信息
              </button>
            )}
            {diagnostic && (
              <textarea
                aria-label="诊断信息"
                readOnly
                value={diagnostic}
                rows={10}
                onFocus={(e) => e.target.select()}
              />
            )}
            <p className="muted">
              诊断信息仅包含定位编号和版本等必要信息，不含会话凭据、暗手或牌山。
            </p>
          </div>
        </main>
      ) : screen === "replay" && replayTarget ? (
        <Replay
          key={replayTarget.id}
          matchId={replayTarget.id}
          initialHandId={replayTarget.handId}
          onBack={() => setScreen("history")}
        />
      ) : (
        <main className="loading">正在连接牌桌…</main>
      )}
      {screen !== "game" && (
        <footer>
          <span>一桌 · 与好朋友，打好时光。</span>
          <span>
            四人立直麻将 <i> / </i> ICHITAKU
          </span>
        </footer>
      )}
    </div>
  );
}
let audio: AudioContext | undefined;
function beep() {
  try {
    audio ??= new AudioContext();
    audio.resume();
    const o = audio.createOscillator(),
      g = audio.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(750, audio.currentTime);
    o.frequency.exponentialRampToValueAtTime(350, audio.currentTime + 0.06);
    g.gain.setValueAtTime(0.04, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.07);
    o.connect(g);
    g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.08);
  } catch {}
}
function Game({
  view: v,
  frame,
  network,
  binding,
  emit,
  setError,
  onNew,
  onRematch,
  onReplay,
}: {
  view: MatchView;
  frame: Frame;
  network: boolean;
  binding: string;
  emit: (e: string, p: any, id?: string) => Promise<any>;
  setError: (s: string) => void;
  onNew: () => void;
  onRematch?: () => void;
  onReplay: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null),
    [riichi, setRiichi] = useState(false),
    [pending, setPending] = useState(false),
    [modal, setModal] = useState<string | null>(null),
    [now, setNow] = useState(Date.now()),
    [details, setDetails] = useState(false);
  const current = useRef({ v, frame });
  current.current = { v, frame };
  const offset = useRef(Date.now() - frame.serverTime);
  useEffect(() => {
    offset.current = Date.now() - frame.serverTime;
  }, [frame.serverTime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const d = v.self.decision,
    can = !!d?.canSubmit && network && !!binding && !pending,
    options = d?.options ?? [];
  const decisionId = d?.decisionId;
  useEffect(() => {
    setSelected(null);
    setRiichi(false);
    setPending(false);
    setModal(null);
  }, [
    decisionId,
    frame.serverEpoch,
    frame.viewSeq,
    v.self.desiredControl,
    d?.canSubmit,
  ]);
  useEffect(() => {
    if (!d || !d.canSubmit) setPending(false);
  }, [d?.canSubmit]);
  const time = d
    ? Math.max(0, Math.ceil((d.deadlineAt - (now - offset.current)) / 1000))
    : null;
  async function submit(o: Option) {
    if (!can || !d) return;
    setPending(true);
    const requestId = uuid();
    const payload: Action = {
      matchId: v.matchId,
      handId: v.hand.handId,
      serverEpoch: frame.serverEpoch,
      bindingId: binding,
      windowId: d.windowId,
      decisionId: d.decisionId,
      optionId: o.optionId,
      lastSeenViewSeq: frame.viewSeq,
    };
    const key = "mj_pending_" + v.matchId;
    sessionStorage.setItem(key, JSON.stringify({ requestId, payload }));
    try {
      const r = await emit("game:action", payload, requestId);
      if (r.status === "REJECTED") throw Error(r.error.message);
      sessionStorage.removeItem(key);
    } catch (e) {
      setError((e as Error).message);
      try {
        const r = await api<any>(`/matches/${v.matchId}/requests/${requestId}`);
        if (r.status === "ACCEPTED") sessionStorage.removeItem(key);
      } catch {}
      await emit("game:sync", { matchId: v.matchId, syncId: uuid() }).catch(
        () => {},
      );
      setPending(false);
    }
  }
  useEffect(() => {
    if (!network || !binding) return;
    const key = "mj_pending_" + v.matchId;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      api<any>(`/matches/${v.matchId}/requests/${saved.requestId}`)
        .then(() => sessionStorage.removeItem(key))
        .catch(async () => {
          if (
            saved.payload.decisionId ===
              current.current.v.self.decision?.decisionId &&
            saved.payload.serverEpoch === current.current.frame.serverEpoch
          ) {
            await emit(
              "game:action",
              { ...saved.payload, bindingId: binding },
              saved.requestId,
            ).catch(() => {});
          }
          sessionStorage.removeItem(key);
        });
    } catch {
      sessionStorage.removeItem(key);
    }
  }, [network, binding, v.matchId]);
  const hand = v.hand,
    self = v.viewerSeat,
    finished = hand.phase === "MATCH_RESULT";
  const own = hand.seats[self];
  const tiles = v.self.concealedTiles;
  const unique = [
    ...new Set(
      options
        .filter((o) => !["DISCARD", "RIICHI_DISCARD"].includes(o.type))
        .map((o) => o.type),
    ),
  ];
  const target = responseTarget(v);
  const availableResponses = [
    ...new Set(
      options
        .filter((o) => ["CHI", "PON", "DAIMINKAN", "RON"].includes(o.type))
        .map((o) => actionNames[o.type]),
    ),
  ];
  const actionPrompt =
    v.status === "ABORTED"
      ? "本场因技术原因中止"
      : pending || d?.submittedRequestId
        ? "已提交，等待裁决"
        : d?.owner === "AI"
          ? "AI 正在思考…"
          : d?.disabledReason === "CONTROL_PENDING"
            ? "将在下个操作窗口恢复人工"
            : can
              ? hand.phase === "SELF_ACTION"
                ? riichi
                  ? "选择立直弃牌"
                  : "选择一张牌，再点击打出"
                : `你可以${availableResponses.join("、")}，或选择过牌`
              : hand.phase === "HAND_RESULT"
                ? "本局已结束"
                : hand.phase === "SELF_ACTION" && hand.activeSeat !== null
                  ? `${v.players[hand.activeSeat].displayName}${v.players[hand.activeSeat].effectiveControl === "AI" ? "正在思考…" : "正在选择出牌…"}`
                  : "等待其他玩家响应…";
  const selectedOption = options.find(
    (o) =>
      o.type === (riichi ? "RIICHI_DISCARD" : "DISCARD") && o.tile === selected,
  );
  return (
    <main className="play-page">
      <div className="game-topline">
        <span>
          <span className={`status-dot ${network ? "on" : ""}`} />
          {network ? "牌桌已连接" : "正在重连，当前操作时间仍会继续"}
        </span>
        <span>
          {formatName(v.format)} <i>·</i> 四人立直
        </span>
        <button
          className="text-button"
          onClick={() =>
            emit("game:control", {
              matchId: v.matchId,
              bindingId: binding,
              mode: v.self.desiredControl === "AI" ? "HUMAN" : "AI",
            }).catch((e) => setError(e.message))
          }
        >
          {v.self.desiredControl === "AI" ? "恢复人工" : "交给 AI 托管"} ↗
        </button>
      </div>
      <div className="portrait-hint">转为横屏，牌桌看得更清楚 ↻</div>
      {v.status === "ABORTED" && (
        <div className="takeover">
          <p>本场因技术原因中止，不计入有效战绩。请另开一桌继续。</p>
          <button className="primary" onClick={onNew}>
            创建新房间
          </button>
        </div>
      )}
      <TableSurface view={v} />
      <section className="hand-panel">
        <div className="action-row">
          <div className="action-hint">
            {target && d ? (
              <ResponseSource source={target} prompt={actionPrompt} />
            ) : (
              actionPrompt
            )}
            {Object.values(v.self.furiten).some(Boolean) && (
              <span className="furiten">振听：不可荣和，可有役自摸</span>
            )}
          </div>
          <div className="action-buttons">
            {time !== null && (
              <span className={`countdown ${time <= 5 ? "urgent" : ""}`}>
                {time}
                <small>秒</small>
              </span>
            )}
            {options.some((o) => o.type === "RIICHI_DISCARD") && (
              <button
                className={`secondary ${riichi ? "chosen" : ""}`}
                disabled={!can}
                onClick={() => {
                  setRiichi(!riichi);
                  setSelected(null);
                }}
              >
                立直
              </button>
            )}
            {unique.map((type) => (
              <button
                key={type}
                className={
                  type === "RON" || type === "TSUMO"
                    ? "primary win-button"
                    : "secondary"
                }
                disabled={!can}
                onClick={() => {
                  const os = options.filter((o) => o.type === type);
                  if (
                    os.length === 1 &&
                    !["CHI", "PON", "DAIMINKAN"].includes(type)
                  )
                    submit(os[0]);
                  else setModal(type);
                }}
              >
                {actionNames[type]}
              </button>
            ))}
            {options.some((o) => o.type === "DISCARD") && (
              <button
                className="primary discard-button"
                disabled={!can || !selectedOption}
                onClick={() => selectedOption && submit(selectedOption)}
              >
                {riichi ? "立直并打出" : "打出"} <span>↑</span>
              </button>
            )}
          </div>
        </div>
        <div className="own-hand">
          {tiles.map((t) => (
            <Tile
              key={t}
              tile={t}
              selected={selected === t}
              disabled={
                !can ||
                !options.some(
                  (o) =>
                    o.type === (riichi ? "RIICHI_DISCARD" : "DISCARD") &&
                    o.tile === t,
                )
              }
              onClick={() => setSelected(t)}
            />
          ))}
          {v.self.drawnTile !== null && (
            <Tile
              tile={v.self.drawnTile}
              selected={selected === v.self.drawnTile}
              disabled={
                !can ||
                !options.some(
                  (o) =>
                    o.type === (riichi ? "RIICHI_DISCARD" : "DISCARD") &&
                    o.tile === v.self.drawnTile,
                )
              }
              onClick={() => setSelected(v.self.drawnTile)}
              mark
            />
          )}
        </div>
        <div className="hand-footer">
          <span>
            {own.riichi === "ESTABLISHED"
              ? "立直后只能摸切，或选择合法和牌与暗杠"
              : "点选手牌 · 点击打出"}
          </span>
          <span>
            {wind(own.seatWind)}家 / {hand.handIndex} 次配牌
          </span>
        </div>
      </section>
      {modal && (
        <div className="modal-shade">
          <section className="modal">
            <button className="close" onClick={() => setModal(null)}>
              ×
            </button>
            <h2>选择{actionNames[modal]}的方案</h2>
            {time !== null && (
              <span
                className={`call-window-time ${time <= 3 ? "urgent" : ""}`}
                role="timer"
              >
                剩余 {time} 秒
              </span>
            )}
            {target && ["CHI", "PON", "DAIMINKAN"].includes(modal) ? (
              <CallChoices
                type={modal}
                target={target}
                options={options.filter((o) => o.type === modal)}
                disabled={!can}
                onConfirm={(o) => {
                  setModal(null);
                  submit(o);
                }}
              />
            ) : (
              <div className="call-options">
                {options
                  .filter((o) => o.type === modal)
                  .map((o) => (
                    <button
                      className="secondary"
                      key={o.optionId}
                      onClick={() => {
                        setModal(null);
                        submit(o);
                      }}
                    >
                      {(o.consumedTiles ?? o.tiles ?? [o.tile!]).map((t) => (
                        <Tile key={t} tile={t} small />
                      ))}
                      <span>确认</span>
                    </button>
                  ))}
              </div>
            )}
          </section>
        </div>
      )}
      {hand.phase === "HAND_RESULT" && v.lastHandResult && (
        <div className="modal-shade result-shade">
          <section className="modal result-modal">
            <div className="eyebrow">这一局，落定</div>
            <h2>
              {resultNames[v.lastHandResult.reason] ?? v.lastHandResult.reason}
            </h2>
            <HandResult
              result={v.lastHandResult}
              view={v}
              details={details}
              setDetails={setDetails}
            />
            <p className="auto-next">
              {v.matchResult ? "即将显示整场成绩" : "下一局即将开始"} ·{" "}
              {Math.max(
                0,
                Math.ceil(
                  ((hand.resultDisplayUntil ?? 0) - (now - offset.current)) /
                    1000,
                ),
              )}{" "}
              秒
            </p>
          </section>
        </div>
      )}
      {finished && v.matchResult && (
        <div className="modal-shade">
          <section className="modal final-modal">
            <div className="eyebrow">一场好时光，感谢同桌</div>
            <h2>本场结算</h2>
            <p className="muted">{endNames[v.matchResult.reason]}</p>
            <div className="rankings">
              {[...v.players]
                .sort(
                  (a, b) =>
                    v.matchResult!.ranks[a.seat] - v.matchResult!.ranks[b.seat],
                )
                .map((p) => (
                  <div
                    key={p.seat}
                    className={p.seat === self ? "is-self" : ""}
                  >
                    <span className="rank">
                      0{v.matchResult!.ranks[p.seat]}
                    </span>
                    <span>
                      <Avatar id={p.avatarId} /> {p.displayName}
                      {p.seat === self ? " · 你" : ""}
                    </span>
                    <strong>{p.points.toLocaleString()}</strong>
                    <small>
                      {p.points >= 25000 ? "+" : ""}
                      {(p.points - 25000).toLocaleString()}
                    </small>
                  </div>
                ))}
            </div>
            <div className="final-actions">
              <button className="secondary" onClick={onReplay}>
                回看本场牌谱 ↗
              </button>
              {onRematch ? (
                <button className="primary" onClick={onRematch}>
                  同桌再战 →
                </button>
              ) : (
                <p>等待房主发起同桌再战</p>
              )}
              <button className="text-button" onClick={onNew}>
                另开一桌 ＋
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
function HandResult({
  result: r,
  view: v,
  details,
  setDetails,
}: {
  result: Result;
  view: MatchView;
  details: boolean;
  setDetails: (b: boolean) => void;
}) {
  return (
    <>
      {r.wins.map((w) => (
        <div className="win-detail" key={w.winnerSeat}>
          <h3>
            {v.players[w.winnerSeat].displayName}{" "}
            <small>
              {w.method === "TSUMO"
                ? "自摸"
                : w.method === "RON"
                  ? `荣和 · ${v.players[w.sourceSeat!].displayName} 放铳`
                  : "流局满贯"}
            </small>
          </h3>
          <div className="reveal-tiles">
            {r.revealedHands
              .find((h) => h.seat === w.winnerSeat)
              ?.concealedTiles.map((t) => (
                <Tile key={t} tile={t} small />
              ))}
            {w.winningTile !== null && <Tile tile={w.winningTile} mark small />}
          </div>
          <div className="yaku-list">
            {w.yaku.map((y, i) => (
              <span key={i}>
                {y.name}{" "}
                <b>
                  {y.yakumanMultiplier
                    ? `${y.yakumanMultiplier} 倍役满`
                    : `${y.han} 番`}
                </b>
              </span>
            ))}
          </div>
          <div className="score-summary">
            {w.yakumanMultiplier
              ? `${w.yakumanMultiplier} 倍役满`
              : w.fu === null
                ? "满贯"
                : `${w.han} 番 ${w.fu} 符`}{" "}
            <small>
              宝牌 {w.dora.omote} · 赤 {w.dora.aka} · 里 {w.dora.ura}
            </small>
          </div>
        </div>
      ))}
      {r.tenpaiSeats && (
        <p>
          {r.tenpaiSeats.length
            ? r.tenpaiSeats.map((s) => v.players[s].displayName).join("、") +
              " 听牌"
            : "四家未听"}
        </p>
      )}
      <div className="result-points">
        {v.players.map((p) => (
          <div key={p.seat}>
            <small>{p.displayName}</small>
            <b
              className={
                r.delta[p.seat] > 0
                  ? "positive"
                  : r.delta[p.seat] < 0
                    ? "negative"
                    : ""
              }
            >
              {r.delta[p.seat] > 0 ? "+" : ""}
              {r.delta[p.seat].toLocaleString()}
            </b>
            <span>{r.pointsAfter[p.seat].toLocaleString()}</span>
          </div>
        ))}
      </div>
      <button className="text-button" onClick={() => setDetails(!details)}>
        {details ? "收起" : "查看"}支付明细 {details ? "−" : "＋"}
      </button>
      {details && (
        <div className="ledger">
          {r.transfers.map((t) => (
            <p key={t.transferId}>
              <span>
                {t.from === "KYOTAKU" ? "供托" : v.players[t.from].displayName}{" "}
                → {t.to === "KYOTAKU" ? "供托" : v.players[t.to].displayName}
              </span>
              <b>{t.amount.toLocaleString()}</b>
              <small>
                {
                  {
                    HAND_VALUE: "和牌",
                    HONBA: "本场",
                    NOTEN: "未听罚符",
                    KYOTAKU_AWARD: "供托",
                    FINAL_KYOTAKU: "终局供托",
                  }[t.reason]
                }
              </small>
            </p>
          ))}
        </div>
      )}
    </>
  );
}
function Rules({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <main className="rules-page">
      <button className="text-button" onClick={onBack}>
        ← 返回
      </button>
      <div className="eyebrow">落座之前</div>
      <h1>这一桌的规矩</h1>
      <div className="rule-intro">
        <article>
          <span>01 / 基本</span>
          <h2>四人立直，东风或半庄</h2>
          <p>
            每人 25,000 点开局，30,000
            点为目标。允许食断、后付，万筒索各有一张赤五。连庄与延长照常进行。
          </p>
        </article>
        <article>
          <span>02 / 和牌</span>
          <h2>有役，才能和</h2>
          <p>
            四面子一雀头、七对子或国士无双，且至少有一役。宝牌增加番数，不能单独作为役。
          </p>
        </article>
        <article>
          <span>03 / 振听</span>
          <h2>振听时，可以自摸</h2>
          <p>
            自己的弃牌包含当前任一完成牌时不能荣和。放过合法荣和会产生同巡振听；立直后见逃持续本局。
          </p>
        </article>
      </div>
      <details>
        <summary>查看完整规则与役种说明</summary>
        <pre className="full-rules">{text || "正在读取规则…"}</pre>
      </details>
      <div className="rules-note">
        <p>
          行动限时 15 秒，响应 8
          秒。超时按规定摸切或过牌；掉线不会暂停牌局，后续窗口由 AI
          托管，重连后按窗口边界恢复人工。
        </p>
        <p>
          游客身份保存在当前浏览器，清除 Cookie
          后无法凭昵称找回。正常成绩与牌谱保存至少 30 天，技术中止资料至少 7
          天。整场结束前不能导出完整牌谱。
        </p>
        <p>音效由本项目合成，默认关闭，可点击右上角音符开启。</p>
      </div>
    </main>
  );
}
interface ReplayData {
  format?: string;
  replayVersion?: string;
  matchId: string;
  players: { seat: Seat; displayName: string; avatarId?: string }[];
  events: any[];
  result: any;
}
function Replay({
  matchId,
  initialHandId,
  onBack,
}: {
  matchId: string;
  initialHandId?: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<ReplayData | null>(null),
    [err, setErr] = useState(""),
    [hand, setHand] = useState(0),
    [step, setStep] = useState(0),
    [seat, setSeat] = useState<Seat>(0),
    [all, setAll] = useState(false),
    [play, setPlay] = useState(false),
    [positionReady, setPositionReady] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      api<ReplayData>(`/matches/${matchId}/replay`),
      api<any>(`/matches/${matchId}/replay-position`).catch(() => null),
    ])
      .then(([d, p]) => {
        if (!active) return;
        if (!["1.0", "2.0"].includes(d.replayVersion ?? "1.0"))
          throw Error("暂不支持这个牌谱版本");
        setData(d);
        setAll(false);
        const deals = d.events.filter((e) => e.type === "DEAL");
        const target = initialHandId
          ? {
              handId: initialHandId,
              eventIndex: d.events.findIndex(
                (e) => e.handId === initialHandId && e.type === "DEAL",
              ),
              viewerSeat: 0,
            }
          : p;
        if (target) {
          const h = deals.findIndex((e) => e.handId === target.handId),
            event = d.events[target.eventIndex];
          if (
            h >= 0 &&
            event?.handId === target.handId &&
            Number.isInteger(target.viewerSeat) &&
            target.viewerSeat >= 0 &&
            target.viewerSeat <= 3
          ) {
            setHand(h);
            setStep(
              d.events.filter((e) => e.handId === target.handId).indexOf(event),
            );
            setSeat(target.viewerSeat);
            if (!initialHandId)
              setNotice("已恢复上次观看位置，全信息展示默认关闭");
          } else setNotice("原观看位置已失效，已返回局首");
        }
        setPositionReady(true);
      })
      .catch((e) => {
        if (active) setErr(e.message);
      });
    return () => {
      active = false;
    };
  }, [matchId, initialHandId]);
  const deals = data?.events.filter((e) => e.type === "DEAL") ?? [],
    handId = deals[hand]?.handId,
    events = data?.events.filter((e) => e.handId === handId) ?? [];

  useEffect(() => {
    if (!play) return;
    const t = setInterval(
      () =>
        setStep((s) => {
          if (s >= events.length - 1) {
            setPlay(false);
            return s;
          }
          return s + 1;
        }),
      700,
    );
    return () => clearInterval(t);
  }, [play, events.length]);
  const state = rebuild(events.slice(0, step + 1));
  const current = events[step];
  useEffect(() => {
    if (!positionReady || !data || !current) return;
    const t = setTimeout(() => {
      api(`/matches/${matchId}/replay-position`, "PUT", {
        handId: current.handId,
        eventIndex: data.events.indexOf(current),
        viewerSeat: seat,
      }).catch((e) => setNotice("观看位置暂未保存：" + e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [positionReady, current, seat, data, matchId]);
  const keyEvents = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) =>
      [
        "RIICHI_DECLARED",
        "RIICHI_ESTABLISHED",
        "CALL_RESOLVED",
        "KAN_PROPOSED",
        "KAN_COMMITTED",
        "HAND_SETTLED",
        "MATCH_FINISHED",
      ].includes(e.type),
    );
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `mahjong-${matchId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <main className="replay-page">
      <button className="text-button" onClick={onBack}>
        ← 返回成绩
      </button>
      <div className="page-title">
        <div>
          <div className="eyebrow">再看一次，那时的选择</div>
          <h1>本场牌谱</h1>
        </div>
        <button className="secondary" disabled={!data} onClick={download}>
          导出 JSON ↓
        </button>
      </div>
      {data && (
        <p className="muted">
          {formatName(data.format ?? "EAST_ONLY")} · 牌谱版本{" "}
          {data.replayVersion ?? "1.0"}
        </p>
      )}
      {err && <p role="alert">{err}</p>}
      {notice && <p aria-live="polite">{notice}</p>}
      {data && (
        <>
          <div className="replay-controls">
            <label>
              选择局{" "}
              <select
                value={hand}
                onChange={(e) => {
                  setHand(Number(e.target.value));
                  setStep(0);
                  setPlay(false);
                }}
              >
                {deals.map((e, i) => (
                  <option value={i} key={e.handId}>
                    {wind(WINDS[e.data.round])}
                    {e.data.roundNumber}局 · {e.data.honba}本场
                  </option>
                ))}
              </select>
            </label>
            <label>
              查看座位{" "}
              <select
                value={seat}
                onChange={(e) => setSeat(Number(e.target.value) as Seat)}
              >
                {data.players.map((p) => (
                  <option value={p.seat} key={p.seat}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setAll(e.target.checked)}
              />
              全信息回放
            </label>
          </div>
          <div className="replay-board">
            {data.players.map((p) => (
              <section key={p.seat}>
                <h3>
                  <Avatar id={p.avatarId} /> {p.displayName} ·{" "}
                  {state.points[p.seat].toLocaleString()} 点
                  <small>{p.seat === seat ? " · 当前视角" : ""}</small>
                </h3>
                <div className="replay-hand">
                  {state.tiles[p.seat].map((t) => (
                    <Tile
                      key={t}
                      tile={t}
                      back={!all && p.seat !== seat}
                      small
                    />
                  ))}
                  <Melds melds={state.melds[p.seat]} />
                </div>
                <div className="replay-river">
                  {state.discards[p.seat].map((t, i) => (
                    <Tile key={i} tile={t} small />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {all && (
            <details>
              <summary>查看本局完整牌山（回放全信息）</summary>
              <div className="wall-tiles">
                {deals[hand]?.data.shuffled.map((t: number) => (
                  <Tile key={t} tile={t} small />
                ))}
              </div>
            </details>
          )}
          <div className="replay-timeline">
            <button
              className="secondary"
              onClick={() => {
                setPlay(false);
                setStep(0);
              }}
            >
              ↶ 局首
            </button>
            <button
              className="secondary"
              disabled={step === 0}
              onClick={() => {
                setPlay(false);
                setStep((s) => Math.max(0, s - 1));
              }}
            >
              ← 上一步
            </button>
            <button className="primary" onClick={() => setPlay(!play)}>
              {play ? "暂停 Ⅱ" : "播放 ▷"}
            </button>
            <button
              className="secondary"
              disabled={step >= events.length - 1}
              onClick={() => {
                setPlay(false);
                setStep((s) => Math.min(events.length - 1, s + 1));
              }}
            >
              下一步 →
            </button>
            <span>
              {step + 1} / {events.length}
            </span>
          </div>
          <input
            className="timeline-range"
            aria-label="回放进度"
            type="range"
            min="0"
            max={Math.max(0, events.length - 1)}
            value={step}
            onChange={(e) => {
              setPlay(false);
              setStep(Number(e.target.value));
            }}
          />
          <p className="replay-event">
            事件 #{data.events.indexOf(current) + 1} ·{" "}
            {current ? eventLabel(current, data) : ""}
          </p>
          <details className="key-events" open>
            <summary>本局关键事件（{keyEvents.length}）</summary>
            <div>
              {keyEvents.map(({ e, index }) => (
                <button
                  className={index === step ? "active" : ""}
                  key={index}
                  onClick={() => {
                    setPlay(false);
                    setStep(index);
                  }}
                >
                  #{data.events.indexOf(e) + 1} · {eventLabel(e, data)}
                </button>
              ))}
            </div>
          </details>
        </>
      )}
    </main>
  );
}
function rebuild(events: any[]) {
  const tiles: number[][] = [[], [], [], []],
    discards: number[][] = [[], [], [], []],
    melds: any[][] = [[], [], [], []];
  let points = [25000, 25000, 25000, 25000];
  for (const e of events) {
    const d = e.data;
    if (e.type === "DEAL") {
      if (d.points) points = [...d.points];
      const wall = [...d.shuffled];
      for (let n = 0; n < 13; n++)
        for (let j = 0; j < 4; j++)
          tiles[(d.dealer + j) % 4].push(wall.shift());
    } else if (e.type === "RIICHI_ESTABLISHED") points[d.seat] -= 1000;
    else if (e.type === "HAND_SETTLED") points = [...d.pointsAfter];
    else if (e.type === "DRAW") tiles[d.seat].push(d.tile);
    else if (e.type === "DISCARD") {
      tiles[d.seat] = tiles[d.seat].filter((t) => t !== d.tile);
      discards[d.seat].push(d.tile);
    } else if (e.type === "CALL_RESOLVED") {
      tiles[d.seat] = tiles[d.seat].filter((t) => !d.meld.tiles.includes(t));
      discards[d.meld.sourceSeat] = discards[d.meld.sourceSeat].filter(
        (t) => t !== d.meld.calledTile,
      );
      melds[d.seat].push(d.meld);
    } else if (e.type === "KAN_PROPOSED") {
      /* Ownership moves only after KAN_COMMITTED. */
    } else if (e.type === "KAN_COMMITTED") {
      if (d.meld) {
        tiles[d.seat] = tiles[d.seat].filter((t) => !d.meld.tiles.includes(t));
        const i = melds[d.seat].findIndex((m) => m.meldId === d.meld.meldId);
        if (i < 0) melds[d.seat].push(d.meld);
        else melds[d.seat][i] = d.meld;
      }
    }
  }
  for (const t of tiles) t.sort((a, b) => a - b);
  return { tiles, discards, melds, points };
}
function eventLabel(e: any, data: ReplayData) {
  const p =
    e.data?.seat === undefined
      ? ""
      : data.players[e.data.seat]?.displayName + " ";
  return (
    (
      {
        DEAL: "配牌",
        DRAW: p + "摸牌",
        DISCARD:
          p +
          "打出 " +
          (e.data.tile === undefined ? "" : tileName(e.data.tile)),
        RIICHI_DECLARED: p + "声明立直",
        RIICHI_ESTABLISHED: p + "立直成立",
        CALL_RESOLVED: p + actionNames[e.data?.meld?.type],
        KAN_PROPOSED: p + "声明杠",
        KAN_COMMITTED: p + "杠成立",
        DORA_REVEALED: "翻开杠宝牌指示",
        HAND_SETTLED:
          (e.data?.wins
            ?.map(
              (w: any) =>
                data.players[w.winnerSeat]?.displayName +
                (w.sourceSeat !== null
                  ? ` ← ${data.players[w.sourceSeat]?.displayName}`
                  : ""),
            )
            .join("、") ?? "") +
          " " +
          (resultNames[e.data?.reason] ?? "本局结算"),
        MATCH_FINISHED: "整场结束",
        RESPONSE_RECORDED: p + "提交响应",
        CONTROL_CHANGED: p + "切换托管",
        RECOVERED: "服务恢复",
      } as Record<string, string>
    )[e.type] ?? e.type
  );
}
createRoot(document.getElementById("root")!).render(<App />);
