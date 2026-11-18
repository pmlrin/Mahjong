import React, { useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import type { Room } from "../../shared/types";
import {
  extractFriendCode,
  friendLink,
  type FriendSuggestion,
  type Relationship,
  type SocialPerson,
  type SocialSnapshot,
} from "../../shared/social";
const status = {
  WAITING: "在房间里",
  ONLINE: "在线",
  PLAYING: "对局中",
  OFFLINE: "离线",
};
const code = (s: string) => s.match(/.{4}/g)?.join("-") ?? s;
export function SocialPage({
  snapshot,
  refresh,
  stale,
  error: syncError,
  room,
  onJoined,
  onBack,
  invitesEnabled,
  initialCode = "",
  onCodeConsumed,
}: {
  snapshot: SocialSnapshot | null;
  refresh: () => Promise<void>;
  stale: boolean;
  error: string;
  room: Room | null;
  onJoined: (roomId: string) => Promise<void>;
  onBack: () => void;
  invitesEnabled: boolean;
  /** A friend code arriving from a shared `?friend=` link. */
  initialCode?: string;
  onCodeConsumed?: () => void;
}) {
  const [tab, setTab] = useState<"friends" | "pending" | "blocks">("friends"),
    [filter, setFilter] = useState(""),
    [lookupCode, setCode] = useState(initialCode),
    [found, setFound] = useState<
      (SocialPerson & { relationship: Relationship }) | null
    >(null),
    [myCode, setMyCode] = useState(""),
    [suggestions, setSuggestions] = useState<FriendSuggestion[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [blocks, setBlocks] = useState<SocialPerson[]>([]),
    [next, setNext] = useState<string | null>(null),
    [confirm, setConfirm] = useState<{
      name: string;
      run: () => Promise<void>;
    } | null>(null);
  const live = useRef(true);
  const revision = useRef(snapshot?.revision);
  revision.current = snapshot?.revision;
  React.useEffect(() => {
    api<{ friendCode: string }>("/profile")
      .then((p) => live.current && setMyCode(p.friendCode))
      .catch(() => {});
  }, []);
  // Recent tablemates; refetched whenever friendships or requests change.
  React.useEffect(() => {
    api<{ items: FriendSuggestion[] }>("/friends/suggestions")
      .then((r) => live.current && setSuggestions(r.items))
      .catch(() => live.current && setSuggestions([]));
  }, [snapshot?.revision]);
  React.useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const pending = useRef(new Map<string, { body: string; id: string }>());
  async function call(path: string, body: any = {}, method = "POST") {
    const serialized = JSON.stringify(body),
      previous = pending.current.get(path),
      id = previous?.body === serialized ? previous.id : crypto.randomUUID();
    pending.current.set(path, { body: serialized, id });
    try {
      const result = await api<any>(path, method, body, {
        "Idempotency-Key": id,
      });
      pending.current.delete(path);
      return result;
    } catch (e) {
      if ((e as any).code) pending.current.delete(path);
      throw e;
    }
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) {
        setBusy(false);
        await refresh();
      }
    }
  }
  async function loadBlocks(more = false) {
    const r = await api<{ items: SocialPerson[]; nextCursor: string | null }>(
      "/blocks" + (more && next ? "?cursor=" + encodeURIComponent(next) : ""),
    );
    if (live.current) {
      setBlocks((old) => (more ? [...old, ...r.items] : r.items));
      setNext(r.nextCursor);
    }
  }
  async function lookup(text: string) {
    const friendCode = extractFriendCode(text);
    if (!friendCode) throw Error("请输入完整的 12 位好友码，或粘贴好友链接");
    setFound(null);
    const result = await call("/friends/lookup", { friendCode });
    if (live.current) setFound(result);
  }
  React.useEffect(() => {
    if (!initialCode) return;
    onCodeConsumed?.();
    void run(() => lookup(initialCode));
  }, []);
  /** Sends a request, or accepts theirs if they already asked. */
  async function addFriend(p: SocialPerson) {
    const r = await call("/friend-requests", { friendCode: p.friendCode });
    if (!live.current) return;
    if (found?.friendCode === p.friendCode)
      setFound({
        ...found,
        relationship: r.becameFriends || r.alreadyFriends ? "FRIEND" : "OUTGOING",
      });
    setMessage(
      r.becameFriends || r.alreadyFriends
        ? `已和 ${p.displayName} 成为好友`
        : `已向 ${p.displayName} 发出申请，7 天内有效`,
    );
  }
  const addButton = (p: SocialPerson, relationship: Relationship) =>
    relationship === "NONE" || relationship === "INCOMING" ? (
      <button
        className="primary"
        disabled={busy}
        onClick={() => run(() => addFriend(p))}
      >
        {relationship === "INCOMING" ? "同意" : "加为好友"}
      </button>
    ) : null;
  const relationNote = (r: Relationship) =>
    r === "SELF"
      ? "这是你自己"
      : r === "FRIEND"
        ? "已经是好友"
        : r === "INCOMING"
          ? "对方想加你为好友"
          : r === "OUTGOING"
            ? "申请已发出，等对方同意"
            : "";
  const person = (p: SocialPerson) => (
    <span className="person-line">
      <Avatar id={p.avatarId} />
      <span>
        <strong>{p.displayName}</strong>
        <small>{code(p.friendCode)}</small>
      </span>
    </span>
  );
  async function actRequest(id: string, action: string, version: number) {
    await call("/friend-requests/" + id + "/" + action, {
      expectedVersion: version,
    });
    setMessage(
      action === "accept"
        ? "已成为好友"
        : action === "cancel"
          ? "已撤回"
          : "已婉拒",
    );
  }
  async function actInvite(id: string, action: string, version: number) {
    const result = await call("/room-invitations/" + id + "/" + action, {
      expectedVersion: version,
    });
    if (action === "accept") await onJoined(result.roomId);
    else setMessage(action === "cancel" ? "已撤回" : "已婉拒");
  }
  const card = (
    key: string,
    who: SocialPerson,
    note: React.ReactNode,
    actions: React.ReactNode,
  ) => (
    <article className="social-card" key={key}>
      {person(who)}
      {note}
      <div className="social-actions">{actions}</div>
    </article>
  );
  const receivedInvites = invitesEnabled
    ? (snapshot?.receivedInvitations ?? [])
    : [];
  const sentInvites = invitesEnabled ? (snapshot?.sentInvitations ?? []) : [];
  const receivedRequests = snapshot?.receivedRequests ?? [];
  const sentRequests = snapshot?.sentRequests ?? [];
  const pendingCount =
    (snapshot?.counts.requests ?? 0) +
    (invitesEnabled ? (snapshot?.counts.invitations ?? 0) : 0);
  const formatOf = (f: string) => (f === "HANCHAN" ? "半庄战" : "东风战");
  const until = (t: number) =>
    new Date(t).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <main className="social-page">
      <button className="text-button" onClick={onBack}>
        返回
      </button>
      <h1>好友</h1>
      <p className="page-sub">把常一起打的人，留在这里</p>
      {stale && (
        <p className="account-notice">
          连接中断，在线状态可能不是最新的；恢复后会自动刷新。
        </p>
      )}
      {(error || syncError) && (
        <p role="alert" className="account-error">
          {error || syncError}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <nav className="social-tabs">
        <button
          className={tab === "friends" ? "active" : ""}
          onClick={() => setTab("friends")}
        >
          好友
        </button>
        <button
          className={tab === "pending" ? "active" : ""}
          onClick={() => setTab("pending")}
        >
          待处理{pendingCount ? ` (${pendingCount})` : ""}
        </button>
      </nav>
      {tab === "friends" && (
        <section>
          {myCode && (
            <div className="my-friend-code">
              <span>
                我的好友码 <code>{code(myCode)}</code>
              </span>
              <button
                className="secondary"
                onClick={() =>
                  run(async () => {
                    const link = friendLink(location.origin, myCode);
                    if (navigator.share)
                      await navigator
                        .share({ title: "加我好友，一起打麻将", url: link })
                        .catch(() => navigator.clipboard.writeText(link));
                    else await navigator.clipboard.writeText(link);
                    setMessage("好友链接已复制，发给朋友，对方点开即可加你");
                  })
                }
              >
                分享好友链接
              </button>
            </div>
          )}
          <form
            className="friend-lookup"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => lookup(lookupCode));
            }}
          >
            <label>
              加好友
              <input
                value={lookupCode}
                onChange={(e) => {
                  const text = e.target.value;
                  setCode(text);
                  setFound(null);
                  // A full code or a pasted link looks itself up.
                  const parsed = extractFriendCode(text);
                  if (parsed && parsed !== extractFriendCode(lookupCode))
                    void run(() => lookup(parsed));
                }}
                placeholder="输入好友码，或粘贴好友链接"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
            </label>
            <button className="secondary" disabled={busy}>
              查找
            </button>
          </form>
          {found &&
            card(
              "found",
              found,
              <span>{relationNote(found.relationship)}</span>,
              addButton(found, found.relationship),
            )}
          {suggestions && suggestions.length > 0 && (
            <section className="friend-suggestions">
              <h2>最近同桌</h2>
              {suggestions.map((p) =>
                card(
                  "suggest-" + p.friendCode,
                  p,
                  <small>
                    {p.relationship === "OUTGOING"
                      ? "申请已发出"
                      : p.relationship === "INCOMING"
                        ? "对方想加你为好友"
                        : until(p.lastPlayedAt) + " 同桌"}
                  </small>,
                  addButton(p, p.relationship),
                ),
              )}
            </section>
          )}
          {snapshot && snapshot.friends.length > 8 && (
            <label>
              找好友
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="名字"
              />
            </label>
          )}
          {!snapshot ? (
            <p>正在载入…</p>
          ) : !snapshot.friends.length ? (
            <p className="muted">
              还没有好友。分享你的好友链接，或从「最近同桌」里一键添加。
            </p>
          ) : (
            snapshot.friends
              .filter((f) =>
                f.displayName
                  .normalize("NFC")
                  .toLocaleLowerCase()
                  .includes(filter.normalize("NFC").toLocaleLowerCase()),
              )
              .map((f) =>
                card(
                  f.friendCode,
                  f,
                  <span>{status[f.status]}</span>,
                  <>
                    {room && invitesEnabled && (
                      <button
                        className="secondary"
                        disabled={busy || !room.slots.includes(null)}
                        onClick={() =>
                          run(async () => {
                            await call("/room-invitations", {
                              recipientFriendCode: f.friendCode,
                              roomId: room.roomId,
                              lobbyGeneration: room.lobbyGeneration,
                              expectedRoomVersion: room.roomVersion,
                            });
                            setMessage("邀请已发出，5 分钟内有效");
                          })
                        }
                      >
                        邀请入座
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={() =>
                        setConfirm({
                          name: `和 ${f.displayName} 解除好友？`,
                          run: async () => {
                            await call(
                              "/friends/" + f.friendCode,
                              {},
                              "DELETE",
                            );
                          },
                        })
                      }
                    >
                      解除好友
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        setConfirm({
                          name: `屏蔽 ${f.displayName}？对方将不能再加你或邀请你，但仍能用房间邀请码同桌。`,
                          run: async () => {
                            await call("/blocks", { friendCode: f.friendCode });
                          },
                        })
                      }
                    >
                      屏蔽
                    </button>
                  </>,
                ),
              )
          )}
          {room && invitesEnabled && (
            <p className="muted">
              邀请不占座；有空位时才能邀请，AI 占着的座位请先请离。
            </p>
          )}
          <button
            className="text-button"
            onClick={() => {
              setTab("blocks");
              void run(() => loadBlocks());
            }}
          >
            已屏蔽的人
          </button>
        </section>
      )}
      {tab === "pending" && (
        <>
          {!receivedInvites.length &&
            !receivedRequests.length &&
            !sentInvites.length &&
            !sentRequests.length && <p>暂时没有需要处理的。</p>}
          {receivedInvites.length > 0 && (
            <section>
              <h2>邀你入座</h2>
              {receivedInvites.map((i) =>
                card(
                  i.invitationId,
                  i.sender,
                  <p className="meta-row">
                    <span>{formatOf(i.format)}</span>
                    <span>已有 {i.occupants} 人</span>
                    <span>{until(i.expiresAt)} 前有效</span>
                  </p>,
                  <>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          actInvite(i.invitationId, "accept", i.version),
                        )
                      }
                    >
                      入座
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          actInvite(i.invitationId, "decline", i.version),
                        )
                      }
                    >
                      婉拒
                    </button>
                  </>,
                ),
              )}
            </section>
          )}
          {receivedRequests.length > 0 && (
            <section>
              <h2>想加你为好友</h2>
              {receivedRequests.map((r) =>
                card(
                  r.requestId,
                  r.sender,
                  <small>{until(r.expiresAt)} 前有效</small>,
                  <>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        run(() => actRequest(r.requestId, "accept", r.version))
                      }
                    >
                      同意
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(() => actRequest(r.requestId, "reject", r.version))
                      }
                    >
                      婉拒
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        setConfirm({
                          name: `屏蔽 ${r.sender.displayName}？对方将不能再加你或邀请你。`,
                          run: async () => {
                            await call("/blocks", {
                              friendCode: r.sender.friendCode,
                            });
                          },
                        })
                      }
                    >
                      屏蔽
                    </button>
                  </>,
                ),
              )}
            </section>
          )}
          {(sentInvites.length > 0 || sentRequests.length > 0) && (
            <section>
              <h2>我发出的</h2>
              {sentInvites.map((i) =>
                card(
                  i.invitationId,
                  i.recipient,
                  <small>入座邀请，{until(i.expiresAt)} 前有效</small>,
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() => actInvite(i.invitationId, "cancel", i.version))
                    }
                  >
                    撤回
                  </button>,
                ),
              )}
              {sentRequests.map((r) =>
                card(
                  r.requestId,
                  r.recipient,
                  <small>好友申请，{until(r.expiresAt)} 前有效</small>,
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() => actRequest(r.requestId, "cancel", r.version))
                    }
                  >
                    撤回
                  </button>,
                ),
              )}
            </section>
          )}
        </>
      )}
      {tab === "blocks" && (
        <section>
          <button className="text-button" onClick={() => setTab("friends")}>
            返回好友
          </button>
          <h2>已屏蔽的人</h2>
          <p className="muted">解除屏蔽不会恢复原来的好友关系。</p>
          {blocks.map((b) =>
            card(
              b.friendCode,
              b,
              null,
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call("/blocks/" + b.friendCode, {}, "DELETE");
                    await loadBlocks();
                  })
                }
              >
                解除屏蔽
              </button>,
            ),
          )}
          {!blocks.length && <p>没有屏蔽任何人。</p>}
          {next && (
            <button disabled={busy} onClick={() => run(() => loadBlocks(true))}>
              更多
            </button>
          )}
        </section>
      )}
      {confirm && (
        <section
          className="social-confirm"
          role="alertdialog"
          aria-label="确认"
        >
          <p>{confirm.name}</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await confirm.run();
                setConfirm(null);
                setMessage("已完成");
              })
            }
          >
            确定
          </button>
          <button onClick={() => setConfirm(null)}>取消</button>
        </section>
      )}
    </main>
  );
}
