import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { AvatarUpload } from "./avatar-upload";
import type {
  SocialProfile,
  DeviceSession,
  SocialCapabilities,
} from "../../shared/social";
const time = (n: number | null) =>
  n === null ? "暂无记录" : new Date(n).toLocaleString();
export function AccountTools({
  userId,
  capabilities,
  onUpdated,
  onFriends,
}: {
  userId: string;
  capabilities: Partial<SocialCapabilities>;
  onUpdated: () => Promise<void>;
  onFriends: () => void;
}) {
  const [profile, setProfile] = useState<SocialProfile | null>(null),
    [name, setName] = useState(""),
    [avatar, setAvatar] = useState("bamboo"),
    [editing, setEditing] = useState(false),
    [uploading, setUploading] = useState(false),
    [devices, setDevices] = useState<DeviceSession[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [showDevices, setShowDevices] = useState(false),
    [target, setTarget] = useState<string | null | undefined>(),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const flowId = useRef(crypto.randomUUID());
  const live = useRef(true),
    pending = useRef(new Map<string, { body: string; id: string }>());
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [userId]);
  async function load() {
    try {
      const p = await api<SocialProfile>("/profile");
      if (!live.current) return;
      setProfile(p);
      setName(p.displayName);
      setAvatar(p.avatarId);
    } catch (e) {
      if (live.current) setError((e as Error).message);
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
      if (live.current) {
        setError((e as Error).message);
        if ((e as any).code === "PROFILE_VERSION_CONFLICT") await load();
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function call(path: string, body: any, method = "POST") {
    const serialized = JSON.stringify(body),
      old = pending.current.get(path),
      id = old?.body === serialized ? old.id : crypto.randomUUID();
    pending.current.set(path, { body: serialized, id });
    try {
      const r = await api(path, method, body, { "Idempotency-Key": id });
      pending.current.delete(path);
      return r;
    } catch (e) {
      if ((e as any).code) pending.current.delete(path);
      throw e;
    }
  }
  async function deviceList(more = false) {
    const data = await api<{
      items: DeviceSession[];
      nextCursor: string | null;
    }>(
      "/auth/sessions" +
        (more && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    );
    if (live.current) {
      setDevices((old) => (more ? [...old, ...data.items] : data.items));
      setCursor(data.nextCursor);
      setShowDevices(true);
    }
  }
  return (
    <section className="account-tools">
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {profile && (
        <>
          <div className="person-line">
            <Avatar id={profile.avatarId} />
            <strong>{profile.displayName}</strong>
          </div>
          <p>
            好友码：<code>{profile.friendCode.match(/.{4}/g)?.join("-")}</code>{" "}
            <button
              className="text-button"
              onClick={() =>
                run(async () => {
                  await navigator.clipboard.writeText(profile.friendCode);
                  setMessage("好友码已复制");
                })
              }
            >
              复制
            </button>
          </p>
          <div className="social-actions">
            {capabilities.profileEditing && (
              <button
                className="secondary"
                onClick={() => setEditing((v) => !v)}
              >
                编辑资料
              </button>
            )}
            {capabilities.sessionManagement && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => run(() => deviceList())}
              >
                登录设备
              </button>
            )}
            {capabilities.friends && (
              <button className="secondary" onClick={onFriends}>
                好友
              </button>
            )}
          </div>
          {editing && (
            <form
              className="profile-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await call(
                    "/profile",
                    {
                      displayName: name,
                      avatarId: avatar,
                      expectedProfileVersion: profile.profileVersion,
                    },
                    "PATCH",
                  );
                  if (!live.current) return;
                  await load();
                  await onUpdated();
                  setEditing(false);
                  setMessage("资料已保存，已结束比赛和旧牌谱保持原样");
                });
              }}
            >
              <label>
                昵称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                />
              </label>
              <p>
                昵称每24小时可修改一次；头像可单独更换。须先自行处理等待厅或对局占位。
              </p>
              <div
                className="avatar-grid"
                role="group"
                aria-label="选择预设头像"
              >
                {profile.avatars.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={avatar === a.id ? "selected" : ""}
                    aria-pressed={avatar === a.id}
                    onClick={() => setAvatar(a.id)}
                  >
                    <Avatar id={a.id} />
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
              <button className="primary" disabled={busy}>
                保存资料
              </button>
            </form>
          )}
          {capabilities.profileEditing && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setUploading((v) => !v);
                setEditing(false);
              }}
            >
              上传个人头像
            </button>
          )}
          {uploading && (
            <AvatarUpload
              version={profile.profileVersion}
              onRefresh={load}
              onCancel={() => setUploading(false)}
              onSaved={async () => {
                await load();
                if (!live.current) return;
                await onUpdated();
                setUploading(false);
                setMessage("头像已保存，旧比赛保留原头像");
              }}
            />
          )}
        </>
      )}
      {showDevices && (
        <section className="devices">
          <h3>登录设备</h3>
          <p>
            每条是一个有效登录会话，同一物理设备可有多条；设备名称仅作参考。
          </p>
          {devices.map((d) => (
            <article key={d.sessionId}>
              <strong>
                {d.browser} / {d.os} {d.current ? "· 当前会话" : ""}
              </strong>
              <small>
                创建：{time(d.createdAt)} · 到期：{time(d.expiresAt)}
                <br />
                最近活动：{time(d.lastSeenAt)}
              </small>
              {!d.current && (
                <button
                  className="text-button"
                  onClick={() => {
                    setTarget(d.sessionId);
                    setPassword("");
                  }}
                >
                  退出此会话
                </button>
              )}
            </article>
          ))}
          {cursor && (
            <button disabled={busy} onClick={() => run(() => deviceList(true))}>
              加载更多
            </button>
          )}
          <button
            className="secondary"
            onClick={() => {
              setTarget(null);
              setPassword("");
            }}
          >
            退出全部其他设备
          </button>
          {target !== undefined && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  try {
                    await call(
                      target === null
                        ? "/auth/sessions/revoke-others"
                        : "/auth/sessions/revoke",
                      {
                        ...(target ? { sessionId: target } : {}),
                        currentPassword: password,
                        flowId: flowId.current,
                      },
                    );
                    if (live.current) {
                      setTarget(undefined);
                      await deviceList();
                      setMessage("其他会话已退出，当前会话保留");
                    }
                  } finally {
                    setPassword("");
                  }
                });
              }}
            >
              <p>
                被退出会话将失去账号和出牌权限；正在控制的牌局按既有规则转托管。当前设备不会自动获得牌局控制。
              </p>
              <label>
                当前密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button className="primary" disabled={busy || !password}>
                确认退出
              </button>
              <button
                type="button"
                onClick={() => {
                  setTarget(undefined);
                  setPassword("");
                }}
              >
                取消
              </button>
            </form>
          )}
        </section>
      )}
    </section>
  );
}
