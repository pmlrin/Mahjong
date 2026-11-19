import { readLocalPreference, writeLocalPreference } from "./table-preferences";
import { Game, actionNames, resultNames } from "./Game";
import { RulesPage as Rules } from "./rules-page";
import { useSocial } from "./use-social";
import { SocialPage } from "./social-page";
import { Avatar } from "./Avatar";
import { TailBadge } from "./rating-view";
import { MatchPanel, PublicTables } from "./public-lobby";
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
  type Seat,
  type CurrentUser,
  type AuthCapabilities,
  type BotLevel,
  type MatchFormat,
  type MatchFound,
  type MatchQueueStatus,
  type PublicLobby,
  BOT_LEVELS,
  botLevelLabel,
} from "../../shared/types";
import "./style.css";
import { api } from "./api";
import {
  AccountPanel,
  type AccountPage,
  type ProfileSection,
} from "./account";
import { History, formatName } from "./history-pages";
import { Tile } from "./Tile";
import { Melds } from "./Melds";
import { loadSounds, playSound } from "./sounds";
import { SoundToggles } from "./sound-toggles";
const uuid = () => crypto.randomUUID();
type Me = CurrentUser;
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
      | "account"
    >(() =>
      new URLSearchParams(location.search).has("replay") ? "replay" : "home",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [network, setNetwork] = useState(false),
    [takeover, setTakeover] = useState(false),
    [sound, setSound] = useState(readLocalPreference("mj_sound") === "true"),
    [music, setMusic] = useState(readLocalPreference("mj_music") === "true"),
    [replayTarget, setReplayTarget] = useState<{
      id: string;
      handId?: string;
    } | null>(() => {
      const id = new URLSearchParams(location.search).get("replay");
      return id ? { id } : null;
    }),
    [inviteLevels, setInviteLevels] = useState<Record<number, BotLevel>>({}),
    [capabilities, setCapabilities] = useState<{
      formats: ("EAST_ONLY" | "HANCHAN")[];
      botLevels: BotLevel[];
      maintenance: boolean;
      auth?: AuthCapabilities;
      profileEditing?: boolean;
      sessionManagement?: boolean;
      friends?: boolean;
      friendInvitations?: boolean;
    } | null>(null),
    [accountPage, setAccountPage] = useState<AccountPage>("profile"),
    [profileSection, setProfileSection] = useState<ProfileSection>("profile"),
    [friendFromLink, setFriendFromLink] = useState(
      () => new URLSearchParams(location.search).get("friend") ?? "",
    ),
    [sessionEpoch, setSessionEpoch] = useState(0),
    [authPaused, setAuthPaused] = useState(false),
    [lobby, setLobby] = useState<PublicLobby | null>(null),
    [matching, setMatching] = useState<MatchQueueStatus | null>(null),
    [leavePrompt, setLeavePrompt] = useState<((ok: boolean) => void) | null>(
      null,
    );
  const social = useSocial(
    me?.identityKind === "ACCOUNT" && !authPaused
      ? me.userId + ":" + sessionEpoch
      : null,
    !!capabilities?.friends,
    network,
  );
  const friendsPending =
    me?.identityKind === "ACCOUNT" && capabilities?.friends
      ? (social.snapshot?.counts.total ?? 0)
      : 0;
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
    meRef = useRef<Me | null>(null);
  roomRef.current = room;
  meRef.current = me;
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
        reject(new Error("正在连接，请稍候"));
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
            reject(new Error("连接有变，正在重新同步"));
            return;
          }
          if (err) reject(new Error("这一手还没有回音，正在确认"));
          else if (!r?.ok)
            reject(
              Object.assign(
                new Error(r?.error?.message ?? "没能完成，请再试一次"),
                {
                  code: r?.error?.code,
                },
              ),
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
    s.on("lobby:rooms", (l: PublicLobby) => {
      if (valid()) setLobby(l);
    });
    s.on("match:status", (q: MatchQueueStatus) => {
      if (valid()) setMatching(q);
    });
    s.on("match:found", (m: MatchFound) => {
      if (!valid()) return;
      setMatching(null);
      latest.current = null;
      setFrame(null);
      api<Room>("/rooms/" + m.roomId)
        .then((r) => {
          if (valid()) return watch(r);
        })
        .catch((e) => setError(e.message));
    });
    s.on("social:changed", () => {
      if (valid()) void socialRefresh.current();
    });
    s.on("room:view", (r: Room) => {
      if (!valid()) return;
      if (roomRef.current && roomRef.current.roomId !== r.roomId) return;
      const rating = r.slots.find(
        (m) => m?.userId === meRef.current?.userId,
      )?.rating;
      if (rating != null)
        setMe((old) => (old && old.rating !== rating ? { ...old, rating } : old));
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
  // A shared `?friend=` link opens the friends page with that code looked up.
  useEffect(() => {
    if (
      friendFromLink &&
      me?.identityKind === "ACCOUNT" &&
      capabilities?.friends &&
      !authPaused &&
      (screen === "home" || screen === "room")
    )
      openAccount("profile", "friends");
  }, [friendFromLink, me?.identityKind, capabilities?.friends, authPaused]);
  function consumeFriendLink() {
    setFriendFromLink("");
    const params = new URLSearchParams(location.search);
    params.delete("friend");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
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
  // Public tables are pushed live while the lounge is on screen.
  useEffect(() => {
    if (!network || screen !== "home" || !me) return;
    let active = true;
    emit("lobby:watch", { watch: true })
      .then((l: PublicLobby) => active && setLobby(l))
      .catch(() => {});
    return () => {
      active = false;
      emit("lobby:watch", { watch: false }).catch(() => {});
    };
  }, [network, screen, me?.userId]);
  // The queue lives on the server; resync after every reconnect.
  useEffect(() => {
    if (!network || !me) return;
    api<MatchQueueStatus>("/match/queue")
      .then(setMatching)
      .catch(() => {});
  }, [network, me?.userId]);
  // A finished table no longer holds the seat; only WAITING/PLAYING do.
  const liveRoom =
    room && (room.status === "WAITING" || room.status === "PLAYING")
      ? room
      : null,
    seatedRoomId = liveRoom?.roomId ?? me?.roomId ?? null,
    inMatch = liveRoom ? liveRoom.status === "PLAYING" : !!me?.matchId;
  /** Before taking another seat: ask, then leave the waiting room. False keeps the seat. */
  async function leaveFirst(): Promise<boolean> {
    const roomId = seatedRoomId;
    if (!roomId) return true;
    if (inMatch) throw Error("这一局还没打完，先回牌桌吧");
    const ok = await new Promise<boolean>((resolve) =>
      setLeavePrompt(() => resolve),
    );
    setLeavePrompt(null);
    if (!ok) return false;
    const old =
      liveRoom?.roomId === roomId
        ? liveRoom
        : await api<Room>("/rooms/" + roomId);
    await api("/rooms/" + roomId + "/leave", "POST", {
      lobbyGeneration: old.lobbyGeneration,
    });
    setRoom(null);
    setMe((m) => m && { ...m, roomId: null, matchId: null });
    return true;
  }
  async function startMatch(format: MatchFormat) {
    await run(async () => {
      if (!(await leaveFirst())) return;
      setMatching(
        await api<MatchQueueStatus>("/match/queue", "POST", { format }),
      );
    });
  }
  async function cancelMatch() {
    await run(async () => {
      setMatching(await api<MatchQueueStatus>("/match/queue", "DELETE"));
    });
  }
  async function joinPublic(roomId: string) {
    if (liveRoom && roomId === liveRoom.roomId) return setScreen("room");
    await run(async () => {
      if (!(await leaveFirst())) return;
      const r = await api<Room>("/rooms/" + roomId + "/join", "POST", {});
      latest.current = null;
      setFrame(null);
      await watch(r);
    });
  }
  async function newRoom() {
    await run(async () => {
      if (!(await leaveFirst())) return;
      const r = await api<Room>("/rooms", "POST", {
        format: "EAST_ONLY",
        rulesetId: RULESET,
        timePresetId: "standard-v1",
        visibility: "PRIVATE",
      });
      latest.current = null;
      setFrame(null);
      await watch(r);
    });
  }
  async function join() {
    if (liveRoom && code === liveRoom.inviteCode) return setScreen("room");
    await run(async () => {
      if (!(await leaveFirst())) return;
      await watch(await api<Room>("/rooms/join", "POST", { inviteCode: code }));
    });
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
          const wasReady = room!.slots.find(
            (m) => m?.userId === me?.userId,
          )?.ready;
          setRoom(r);
          if (wasReady && (path === "/config" || path.endsWith("/bot")))
            setError("牌桌有变，请重新准备");
        }
      } catch (e) {
        setRoom(await api<Room>("/rooms/" + room!.roomId));
        throw e;
      }
    });
  }
  function showRules() {
    setScreen("rules");
  }
  function toggleSound() {
    setSound((v) => {
      writeLocalPreference("mj_sound", String(!v));
      if (!v) void loadSounds().then(() => playSound("discard"));
      return !v;
    });
  }
  useEffect(() => {
    if (sound) void loadSounds();
  }, [sound]);
  function toggleMusic() {
    setMusic((v) => {
      writeLocalPreference("mj_music", String(!v));
      return !v;
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
  function openAccount(
    page: AccountPage = "profile",
    section: ProfileSection = "profile",
  ) {
    setAccountPage(page);
    setProfileSection(section);
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
      setError("已完成，请用账号重新登录。");
      return;
    }
    const current = await api<Me>("/me");
    clearIdentityContext(false);
    setMe(current);
    meRef.current = current;
    setAuthPaused(false);
    setSessionEpoch((v) => v + 1);
    setAccountPage(current.identityKind === "GUEST" ? "register" : "profile");
    setProfileSection("profile");
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
    // Only a paused identity (released for an auth step) needs a fresh session.
    if (authPaused) {
      setAuthPaused(false);
      setSessionEpoch((v) => v + 1);
    }
    setScreen(frame ? "game" : room ? "room" : "home");
  }
  const view = frame?.state;
  return (
    <div className={`app ${screen === "game" ? "game-app" : ""}`}>
      <header className="header">
        <button className="brand" onClick={() => setScreen("home")}>
          <span className="brand-seal">烛</span>
          <span>
            明烛<span className="brand-en">Mingzhu</span>
          </span>
        </button>
        <nav>
          <button
            className={screen === "home" ? "active" : ""}
            onClick={() => setScreen("home")}
          >
            首页
          </button>
          {room && (
            <button
              className={screen === "room" || screen === "game" ? "active" : ""}
              onClick={() => setScreen(room.matchId ? "game" : "room")}
            >
              牌桌
            </button>
          )}
          <button
            className={screen === "rules" ? "active" : ""}
            onClick={showRules}
          >
            规则
          </button>
        </nav>
        <div className="user">
          <span
            className={`status-dot ${network ? "on" : ""}`}
            role="img"
            aria-label={network ? "已连接" : "未连接"}
            title={network ? "已连接" : "未连接"}
          />
          <button
            className={`account-entry${screen === "account" ? " active" : ""}`}
            aria-label={
              friendsPending ? `个人信息，${friendsPending} 条待处理` : "个人信息"
            }
            onClick={() => openAccount(me ? "profile" : "login")}
          >
            {me?.identityKind === "ACCOUNT" && <Avatar id={me.avatarId} />}
            <span className="identity-name">{me?.displayName ?? "登录"}</span>
            {me?.identityKind === "GUEST" && (
              <span className="identity-kind">游客</span>
            )}
            {friendsPending > 0 && (
              <span className="social-badge" aria-hidden="true">
                {friendsPending}
              </span>
            )}
          </button>
          <SoundToggles
            sound={sound}
            music={music}
            onSound={toggleSound}
            onMusic={toggleMusic}
          />
        </div>
      </header>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="关闭">
            ×
          </button>
        </div>
      )}
      {leavePrompt && (
        <div
          className="modal-shade"
          onClick={(e) => e.target === e.currentTarget && leavePrompt(false)}
          onKeyDown={(e) => e.key === "Escape" && leavePrompt(false)}
        >
          <section
            className="modal leave-prompt"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-prompt-title"
          >
            <h2 id="leave-prompt-title">离开现在这桌？</h2>
            <p className="modal-sub">
              你还坐在一张没开局的牌桌上。离开后座位会空出来，再回来要重新入座。
            </p>
            <div className="leave-prompt-actions">
              <button className="primary" onClick={() => leavePrompt(true)}>
                离开，去新的一桌
              </button>
              <button
                className="secondary"
                autoFocus
                onClick={() => leavePrompt(false)}
              >
                留在这桌
              </button>
            </div>
          </section>
        </div>
      )}
      {takeover && (
        <div className="takeover">
          <p>这张牌桌的灯，正亮在另一个页面里。</p>
          <button className="primary" onClick={() => run(() => claim(true))}>
            在这里继续
          </button>
        </div>
      )}
      {capabilities?.maintenance && (
        <p className="maintenance-notice" role="status">
          正在扫雪修灯：进行中的对局照常，暂不开新桌。
        </p>
      )}
      {boot ? (
        <main className="loading">掸掸雪，正在为你留座…</main>
      ) : screen === "home" ? (
        <main className="lounge">
          <section className="lounge-stage">
            <div className="lounge-inner">
              <div className="hero-copy">
                <h1>
                  山上落雪，
                  <br />
                  桌边点灯。
                </h1>
                <p className="intro">
                  发一条链接，朋友推门就坐；
                  <br />
                  缺一家，请假想妖来凑。
                </p>
              </div>
              {!me ? (
                <form
                  className="entry-card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    login();
                  }}
                >
                  <h2>留个名字，进屋坐</h2>
                  <div className="entry-row">
                    <input
                      id="nickname"
                      aria-label="牌桌上的名字"
                      placeholder="牌桌上怎么称呼你"
                      maxLength={16}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="nickname"
                    />
                    <button className="primary" disabled={busy || !name.trim()}>
                      入座
                    </button>
                  </div>
                  <small>不必注册。关了页面再回来，灯和座位都还在。</small>
                  <div className="account-shortcuts">
                    <button
                      type="button"
                      className="text-button"
                      disabled={!capabilities?.auth?.passwordLogin}
                      onClick={() => openAccount("login")}
                    >
                      已有账号，登录
                    </button>
                  </div>
                </form>
              ) : (
                <div className="entry-card">
                  <h2>灯还亮着，来一局？</h2>
                  <p className="guest-hint">
                    {me.identityKind === "ACCOUNT" ? (
                      `${me.displayName}，回来啦，座位给你焐着。`
                    ) : (
                      <>
                        你现在是游客。
                        {capabilities?.auth?.registration && (
                          <>
                            <button
                              className="text-button"
                              onClick={() => openAccount("register")}
                            >
                              注册
                            </button>
                            后，换台设备也能接着打。
                          </>
                        )}
                      </>
                    )}
                  </p>
                  <div className="create-line">
                    <button
                      className="primary create"
                      onClick={newRoom}
                      disabled={
                        busy ||
                        !network ||
                        !capabilities ||
                        capabilities.maintenance ||
                        !!matching?.queued ||
                        inMatch
                      }
                    >
                      点灯开桌
                    </button>
                  </div>
                  <MatchPanel
                    status={matching}
                    formats={capabilities?.formats ?? ["EAST_ONLY", "HANCHAN"]}
                    disabled={
                      busy ||
                      !network ||
                      !capabilities ||
                      capabilities.maintenance ||
                      inMatch
                    }
                    onStart={startMatch}
                    onCancel={cancelMatch}
                  />
                  <div className="join-line">
                    <input
                      aria-label="房间邀请码"
                      placeholder="或输入朋友的 6 位邀请码"
                      maxLength={6}
                      inputMode="numeric"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    />
                    <button
                      className="secondary"
                      onClick={join}
                      disabled={busy || code.length !== 6 || !network || inMatch}
                    >
                      入座
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="hero-art">
              <div className="art-hand" aria-hidden="true">
                {[0, 32, 36, 68, 72, 104, 108, 112, 116, 120, 124, 128, 132].map(
                  (t) => (
                    <Tile key={t} tile={t} />
                  ),
                )}
              </div>
            </div>
          </section>
          {me && (
            <PublicTables
              lobby={lobby}
              disabled={
                busy || !network || !!matching?.queued || inMatch
              }
              onJoin={joinPublic}
            />
          )}
          <div className="lounge-bottom">
            <div className="lounge-note">
              <h2>把夜晚留给牌局</h2>
              <p>不必下载，不必久等。外头风雪再大，这里总有一盏灯。</p>
            </div>
            <div className="lounge-feature">
              <h3>一条链接，推门就坐</h3>
              <p>
                开桌后把邀请链接发给朋友，点开便坐到你身边。缺一家，就请假想妖补上：它们是会打牌的
                AI，朋友一到就让座。
              </p>
            </div>
            <div className="lounge-feature">
              <h3>一张有纵深的牌桌</h3>
              <p>
                横屏即是 3D
                牌桌。快速出牌、自动摸切、不鸣牌，一键开关，出牌像变一个练熟了的小魔术。
              </p>
            </div>
          </div>
        </main>
      ) : screen === "room" && room ? (
        <main className="room-page">
          <div className="page-title">
            <h1>
              灯点着，
              <br />
              等你们到齐。
            </h1>
          </div>
          <div className="seats">
            <div className="room-center">
              <div className="room-invite">
                <small>邀请码</small>
                <strong>{room.inviteCode}</strong>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(
                        location.origin +
                          import.meta.env.BASE_URL +
                          "?invite=" +
                          room.inviteCode,
                      );
                      setError("邀请链接已复制，发给朋友，推门就能坐");
                    })
                  }
                >
                  复制邀请链接
                </button>
              </div>
              {me?.identityKind === "ACCOUNT" &&
                capabilities?.friendInvitations &&
                room.hostUserId === me.userId && (
                  <button
                    className="secondary"
                    onClick={() => openAccount("profile", "friends")}
                  >
                    邀请好友
                  </button>
                )}
              <div className="room-meta">
                {room.hostUserId === me?.userId && room.status === "WAITING" ? (
                  <label>
                    赛制{" "}
                    <select
                      aria-label="赛制"
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
                ) : (
                  <span>{formatName(room.config.format)}</span>
                )}
                {room.hostUserId === me?.userId && room.status === "WAITING" ? (
                  <label className="visibility-toggle">
                    <input
                      type="checkbox"
                      checked={room.visibility === "PUBLIC"}
                      disabled={busy}
                      onChange={(e) =>
                        roomAction("/visibility", "PUT", {
                          visibility: e.target.checked ? "PUBLIC" : "PRIVATE",
                          expectedRoomVersion: room.roomVersion,
                        })
                      }
                    />
                    公开到大厅
                  </label>
                ) : (
                  room.visibility === "PUBLIC" && (
                    <span>公开牌桌，谁都能坐下</span>
                  )
                )}
                <span>起始 25,000 点，有赤宝牌与食断</span>
                <span>出牌 15 秒，应答 8 秒</span>
              </div>
            </div>
            {room.slots.map((m, i) => (
              <section className={`seat-card ${m ? "occupied" : ""}`} key={i}>
                <span className="seat-index">{i + 1} 号位</span>
                <div className="seat-avatar">
                  {m ? (
                    m.participantKind === "BOT" ? (
                      "妖"
                    ) : (
                      <Avatar id={m.avatarId} />
                    )
                  ) : (
                    "＋"
                  )}
                </div>
                <h2>
                  {m?.displayName ?? "虚位以待"}
                  {m?.participantKind === "HUMAN" && (
                    <TailBadge rating={m.rating} withValue />
                  )}
                </h2>
                <p>
                  {m
                    ? m.participantKind === "BOT"
                      ? `假想妖，${botLevelLabel(m.botLevel)}`
                      : `${m.userId === room.hostUserId ? "房主，" : ""}${m.userId === me?.userId ? "你" : m.connected ? "在线" : "暂离"}`
                    : "邀一位朋友，或请假想妖来坐"}
                </p>
                <div className="seat-controls">
                  {m ? (
                    <>
                      <span className={`ready ${m.ready ? "yes" : ""}`}>
                        {m.ready ? "已准备" : "未准备"}
                      </span>
                      {m.participantKind === "BOT" &&
                        room.hostUserId === me?.userId && (
                          <>
                            <label>
                              档位{" "}
                              <select
                                aria-label={`${i + 1} 号位假想妖档位`}
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
                                    {botLevelLabel(level)}
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
                              请离
                            </button>
                          </>
                        )}
                    </>
                  ) : room.hostUserId === me?.userId ? (
                    <>
                      <label>
                        档位{" "}
                        <select
                          aria-label={`${i + 1} 号位请假想妖入座的档位`}
                          value={inviteLevels[i] ?? "STANDARD"}
                          disabled={busy}
                          onChange={(e) =>
                            setInviteLevels((levels) => ({
                              ...levels,
                              [i]: e.target.value as BotLevel,
                            }))
                          }
                        >
                          {(capabilities?.botLevels ?? BOT_LEVELS).map(
                            (level) => (
                              <option key={level} value={level}>
                                {botLevelLabel(level)}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          roomAction("/slots/" + i + "/bot", "PUT", {
                            botLevel: inviteLevels[i] ?? "STANDARD",
                            expectedRoomVersion: room.roomVersion,
                          })
                        }
                      >
                        请假想妖入座
                      </button>
                    </>
                  ) : (
                    <span className="muted">等朋友推门</span>
                  )}
                </div>
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
              离开
            </button>
            <span>开局时随机定座</span>
            <button
              className={
                room.slots.find((m) => m?.userId === me?.userId)?.ready
                  ? "secondary"
                  : "primary"
              }
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
                : "准备"}
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
                开局
              </button>
            )}
          </div>
          <p className="room-footnote">
            众人准备后，由房主开局。换人、改赛制或调假想妖档位后，需重新准备。
          </p>
        </main>
      ) : screen === "game" && view ? (
        <Game
          key={me!.userId + ":" + sessionEpoch + ":" + view.matchId}
          userId={me!.userId}
          identity={me!.userId + ":" + sessionEpoch}
          authorized={(c) =>
            latest.current === c.frame &&
            binding.current === c.binding &&
            !!socket.current?.connected &&
            meRef.current?.userId === me?.userId
          }
          view={view}
          frame={frame!}
          network={network}
          binding={binding.current}
          emit={emit}
          setError={setError}
          onNew={newRoom}
          onRematch={room?.hostUserId === me?.userId ? rematch : undefined}
          onReplay={() => openReplay(view.matchId)}
          sound={sound}
          music={music}
          onToggleSound={toggleSound}
          onToggleMusic={toggleMusic}
        />
      ) : screen === "rules" ? (
        <Rules onBack={() => setScreen(view ? "game" : "home")} />
      ) : screen === "account" ? (
        <AccountPanel
          key={accountPage}
          section={profileSection}
          onSection={setProfileSection}
          friendsBadge={friendsPending}
          history={
            me && !authPaused ? (
              <History
                key={me.userId + ":" + sessionEpoch}
                userId={me.userId}
                onReplay={openReplay}
              />
            ) : null
          }
          friends={
            me?.identityKind === "ACCOUNT" &&
            capabilities?.friends &&
            !authPaused ? (
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
                beforeJoin={leaveFirst}
                initialCode={friendFromLink}
                onCodeConsumed={consumeFriendLink}
                onJoined={async (roomId) => {
                  const generation = identityGeneration.current;
                  const current = await api<Me>("/me");
                  if (generation !== identityGeneration.current) return;
                  if (current.roomId !== roomId) throw Error("牌桌有变，请重新查看");
                  setMe(current);
                  const joined = await api<Room>("/rooms/" + roomId);
                  if (generation !== identityGeneration.current) return;
                  await watch(joined);
                }}
              />
            ) : null
          }
          socialCapabilities={capabilities ?? {}}
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
      ) : screen === "replay" && replayTarget ? (
        <Replay
          key={replayTarget.id}
          matchId={replayTarget.id}
          initialHandId={replayTarget.handId}
          onBack={() => openAccount("profile", "history")}
        />
      ) : (
        <main className="loading">正在推开牌桌的门…</main>
      )}
      {screen !== "game" && (
        <footer>
          <span>明烛，雪夜里和朋友打的四人立直麻将。</span>
        </footer>
      )}
    </div>
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
          throw Error("这份牌谱版本较旧，暂时打不开");
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
            if (!initialHandId) setNotice("已翻到上次看到的那一页");
          } else setNotice("上次夹的书签被雪埋了，从局首看起");
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
      }).catch((e) => setNotice("进度暂未保存：" + e.message));
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
  return (
    <main className="replay-page">
      <button className="text-button" onClick={onBack}>
        返回战绩
      </button>
      <div className="page-title">
        <div>
          <h1>牌谱</h1>
          <p className="page-sub">
            {data
              ? formatName(data.format ?? "EAST_ONLY") +
                "，灯下再看一遍那时的选择"
              : "灯下再看一遍那时的选择"}
          </p>
        </div>
      </div>
      {err && <p role="alert">{err}</p>}
      {notice && <p aria-live="polite">{notice}</p>}
      {data && (
        <>
          <div className="replay-controls">
            <label>
              局{" "}
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
              视角{" "}
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
              亮出四家手牌
            </label>
          </div>
          <div className="replay-board">
            {data.players.map((p) => (
              <section key={p.seat}>
                <h3>
                  <Avatar id={p.avatarId} /> {p.displayName}
                  <span>{state.points[p.seat].toLocaleString()} 点</span>
                  <small>{p.seat === seat ? "视角" : ""}</small>
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
              <summary>本局牌山</summary>
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
              局首
            </button>
            <button
              className="secondary"
              disabled={step === 0}
              onClick={() => {
                setPlay(false);
                setStep((s) => Math.max(0, s - 1));
              }}
            >
              上一步
            </button>
            <button className="primary" onClick={() => setPlay(!play)}>
              {play ? "暂停" : "播放"}
            </button>
            <button
              className="secondary"
              disabled={step >= events.length - 1}
              onClick={() => {
                setPlay(false);
                setStep((s) => Math.min(events.length - 1, s + 1));
              }}
            >
              下一步
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
            {current ? eventLabel(current, data) : ""}
          </p>
          <details className="key-events" open>
            <summary>本局要点（{keyEvents.length}）</summary>
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
                  第 {index + 1} 手：{eventLabel(e, data)}
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
        RIICHI_DECLARED: p + "宣告立直",
        RIICHI_ESTABLISHED: p + "立直成立",
        CALL_RESOLVED: p + actionNames[e.data?.meld?.type],
        KAN_PROPOSED: p + "宣告杠",
        KAN_COMMITTED: p + "杠成立",
        DORA_REVEALED: "翻开新宝牌",
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
          (resultNames[e.data?.reason] ?? "本局终了"),
        MATCH_FINISHED: "一场终了",
        RESPONSE_RECORDED: p + "应答",
        CONTROL_CHANGED: p + "切换托管",
        RECOVERED: "牌桌恢复",
      } as Record<string, string>
    )[e.type] ?? e.type
  );
}
createRoot(document.getElementById("root")!).render(<App />);
