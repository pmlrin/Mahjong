import React, { useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { api } from "./api";
import type { Room } from "../../shared/types";
import type { SocialPerson, SocialSnapshot } from "../../shared/social";
const status = {
  WAITING: "等待开局",
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
}: {
  snapshot: SocialSnapshot | null;
  refresh: () => Promise<void>;
  stale: boolean;
  error: string;
  room: Room | null;
  onJoined: (roomId: string) => Promise<void>;
  onBack: () => void;
  invitesEnabled: boolean;
}) {
  const [tab, setTab] = useState<
      "friends" | "requests" | "invitations" | "blocks"
    >("friends"),
    [filter, setFilter] = useState(""),
    [lookupCode, setCode] = useState(""),
    [found, setFound] = useState<
      (SocialPerson & { relationship: string }) | null
    >(null),
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
  React.useEffect(() => setFound(null), [snapshot?.revision]);
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
    setMessage("申请已处理");
  }
  async function actInvite(id: string, action: string, version: number) {
    const result = await call("/room-invitations/" + id + "/" + action, {
      expectedVersion: version,
    });
    if (action === "accept") await onJoined(result.roomId);
    else setMessage("邀请已处理");
  }
  return (
    <main className="social-page">
      <button className="text-button" onClick={onBack}>
        ← 返回牌桌或首页
      </button>
      <h1>好友与组局</h1>
      <p>好友码用于添加好友，六位房间邀请码用于入房，两者不能混用。</p>
      {stale && (
        <p className="account-notice">
          连接中断或同步暂不可用，在线状态可能过时；恢复后自动刷新。
        </p>
      )}
      {(error || syncError) && (
        <p role="alert" className="account-error">
          {error || syncError}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <nav className="social-tabs">
        {[
          ["friends", "好友"],
          ["requests", "好友申请"],
          ["invitations", "房间邀请"],
          ["blocks", "已屏蔽账号"],
        ]
          .filter(([id]) => id !== "invitations" || invitesEnabled)
          .map(([id, name]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id as typeof tab);
                if (id === "blocks") void run(() => loadBlocks());
              }}
            >
              {name}
              {id === "requests" && snapshot?.counts.requests
                ? ` (${snapshot.counts.requests})`
                : id === "invitations" && snapshot?.counts.invitations
                  ? ` (${snapshot.counts.invitations})`
                  : ""}
            </button>
          ))}
        <button disabled={busy} onClick={() => run(refresh)}>
          刷新
        </button>
      </nav>
      {tab === "friends" && (
        <>
          <form
            className="friend-lookup"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setFound(null);
                const requestedRevision = revision.current;
                const result = await call("/friends/lookup", {
                  friendCode: lookupCode,
                });
                if (live.current && requestedRevision === revision.current) setFound(result);
              });
            }}
          >
            <label>
              完整12位好友码
              <input
                value={lookupCode}
                onChange={(e) => {
                  setCode(e.target.value);
                  setFound(null);
                }}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="off"
              />
            </label>
            <button className="secondary" disabled={busy}>
              精确查找
            </button>
          </form>
          {found && (
            <article className="social-card">
              {person(found)}
              <span>
                {found.relationship === "SELF"
                  ? "这是你的账号"
                  : found.relationship === "FRIEND"
                    ? "已是好友"
                    : found.relationship === "INCOMING"
                      ? "对方已发来申请，请到申请页明确同意"
                      : found.relationship === "OUTGOING"
                        ? "申请已发送"
                        : "核对资料后添加"}
              </span>
              {found.relationship === "NONE" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await call("/friend-requests", {
                        friendCode: found.friendCode,
                      });
                      setFound({ ...found, relationship: "OUTGOING" });
                      setMessage("申请已发送，有效期7天");
                    })
                  }
                >
                  发送好友申请
                </button>
              )}
            </article>
          )}
          <label>
            筛选我的好友
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="仅筛选已加载的好友昵称"
            />
          </label>
          {!snapshot ? (
            <p>正在同步好友…</p>
          ) : !snapshot.friends.length ? (
            <p>还没有好友，分享你的好友码或输入朋友的好友码添加。</p>
          ) : (
            snapshot.friends
              .filter((f) =>
                f.displayName
                  .normalize("NFC")
                  .toLocaleLowerCase()
                  .includes(filter.normalize("NFC").toLocaleLowerCase()),
              )
              .map((f) => (
                <article className="social-card" key={f.friendCode}>
                  {person(f)}
                  <span>{status[f.status]}</span>
                  <div className="social-actions">
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
                            setMessage("邀请已发送，有效期5分钟；未预留座位");
                          })
                        }
                      >
                        邀请入房
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={() =>
                        setConfirm({
                          name:
                            "删除与 " +
                            f.displayName +
                            " 的双向好友关系，并取消双方待处理邀请？不会踢出同桌玩家。",
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
                      删除
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        setConfirm({
                          name:
                            "屏蔽 " +
                            f.displayName +
                            " 并删除好友、取消申请和邀请？仍可通过房间邀请码同桌。",
                          run: async () => {
                            await call("/blocks", { friendCode: f.friendCode });
                          },
                        })
                      }
                    >
                      屏蔽
                    </button>
                  </div>
                </article>
              ))
          )}
          {room && (
            <p>
              邀请不占座、不自动准备。只有真实空槽可接收，AI占位请先由房主移除。
            </p>
          )}
        </>
      )}
      {tab === "requests" && (
        <>
          {["received", "sent"].map((direction) => (
            <section key={direction}>
              <h2>{direction === "received" ? "收到的申请" : "发出的申请"}</h2>
              {(direction === "received"
                ? snapshot?.receivedRequests
                : snapshot?.sentRequests
              )?.map((r) => (
                <article className="social-card" key={r.requestId}>
                  {person(direction === "received" ? r.sender : r.recipient)}
                  <small>截止：{new Date(r.expiresAt).toLocaleString()}</small>
                  <div className="social-actions">
                    {direction === "received" ? (
                      <>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              actRequest(r.requestId, "accept", r.version),
                            )
                          }
                        >
                          同意
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              actRequest(r.requestId, "reject", r.version),
                            )
                          }
                        >
                          拒绝
                        </button>
                        <button
                          onClick={() =>
                            setConfirm({
                              name: "屏蔽该账号并使申请失效？屏蔽不禁止邀请码同桌。",
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
                      </>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            actRequest(r.requestId, "cancel", r.version),
                          )
                        }
                      >
                        撤回
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {!(
                direction === "received"
                  ? snapshot?.receivedRequests
                  : snapshot?.sentRequests
              )?.length && <p>暂无待处理申请</p>}
            </section>
          ))}
        </>
      )}
      {tab === "invitations" && (
        <>
          {["received", "sent"].map((direction) => (
            <section key={direction}>
              <h2>{direction === "received" ? "收到的邀请" : "发出的邀请"}</h2>
              {(direction === "received"
                ? snapshot?.receivedInvitations
                : snapshot?.sentInvitations
              )?.map((i) => (
                <article className="social-card" key={i.invitationId}>
                  {person(direction === "received" ? i.sender : i.recipient)}
                  <p>
                    {i.format === "HANCHAN" ? "半庄战" : "东风战"} · 当前{" "}
                    {i.occupants}/4 人 · 截止{" "}
                    {new Date(i.expiresAt).toLocaleTimeString()}
                  </p>
                  <div className="social-actions">
                    {direction === "received" ? (
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
                          接受并加入等待厅
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              actInvite(i.invitationId, "decline", i.version),
                            )
                          }
                        >
                          拒绝
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            actInvite(i.invitationId, "cancel", i.version),
                          )
                        }
                      >
                        取消邀请
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {!(
                direction === "received"
                  ? snapshot?.receivedInvitations
                  : snapshot?.sentInvitations
              )?.length && <p>暂无待处理邀请</p>}
            </section>
          ))}
        </>
      )}
      {tab === "blocks" && (
        <>
          <p>
            屏蔽仅停止站内社交，不禁止通过已有房间邀请码同桌。解除不会恢复好友或旧申请，重新添加仍受24小时冷却。
          </p>
          {blocks.map((b) => (
            <article className="social-card" key={b.friendCode}>
              {person(b)}
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
              </button>
            </article>
          ))}
          {!blocks.length && <p>暂无屏蔽账号</p>}
          {next && (
            <button disabled={busy} onClick={() => run(() => loadBlocks(true))}>
              加载更多
            </button>
          )}
        </>
      )}
      {confirm && (
        <section
          className="social-confirm"
          role="alertdialog"
          aria-label="确认关系变更"
        >
          <p>{confirm.name}</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await confirm.run();
                setConfirm(null);
                setMessage("已处理");
              })
            }
          >
            确认
          </button>
          <button onClick={() => setConfirm(null)}>取消</button>
        </section>
      )}
    </main>
  );
}
