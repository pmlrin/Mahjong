import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { AvatarUpload } from "./avatar-upload";
import {
  friendLink,
  uploadedAvatarSchema,
  type SocialProfile,
  type SocialCapabilities,
} from "../../shared/social";
const DAY = 86_400_000;
export function AccountTools({
  userId,
  capabilities,
  onUpdated,
}: {
  userId: string;
  capabilities: Partial<SocialCapabilities>;
  onUpdated: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<SocialProfile | null>(null),
    [name, setName] = useState(""),
    [avatar, setAvatar] = useState("bamboo"),
    [editing, setEditing] = useState(false),
    [uploading, setUploading] = useState(false),
    [revoking, setRevoking] = useState(false),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [clockSkew, setClockSkew] = useState(0);
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
  /** `reset` drops unsaved edits; an avatar upload keeps a half-typed name. */
  async function load(reset = true) {
    try {
      const p = await api<SocialProfile>("/profile");
      if (!live.current) return;
      setProfile(p);
      setClockSkew(Date.now() - p.serverTime);
      if (reset) {
        setName(p.displayName);
        setAvatar(p.avatarId);
      }
    } catch (e) {
      if (live.current) setError((e as Error).message);
    }
  }
  function openEditor() {
    if (!profile) return;
    setName(profile.displayName);
    setAvatar(profile.avatarId);
    setError("");
    setMessage("");
    setUploading(false);
    setEditing(true);
    void load();
  }
  const renameUntil =
      profile?.lastNicknameChangedAt == null
        ? 0
        : profile.lastNicknameChangedAt + DAY + clockSkew,
    renameLocked = renameUntil > Date.now(),
    renameAt = new Date(renameUntil).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    changed =
      !!profile &&
      (name.trim() !== profile.displayName || avatar !== profile.avatarId);
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
          <div className="profile-head">
            <Avatar id={profile.avatarId} label="我的头像" />
            <div>
              <strong>{profile.displayName}</strong>
              <p>
                好友码{" "}
                <code>{profile.friendCode.match(/.{4}/g)?.join("-")}</code>{" "}
                <button
                  className="text-button"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(
                        friendLink(location.origin, profile.friendCode),
                      );
                      setMessage("好友链接已复制，朋友点开即可加你");
                    })
                  }
                >
                  复制链接
                </button>
              </p>
            </div>
          </div>
          <div className="social-actions">
            {capabilities.profileEditing && !editing && (
              <button className="secondary" onClick={openEditor}>
                编辑资料
              </button>
            )}
            {capabilities.sessionManagement && (
              <button
                className="secondary"
                onClick={() => {
                  setRevoking((v) => !v);
                  setPassword("");
                }}
              >
                退出其他设备
              </button>
            )}
          </div>
          {editing && uploading && (
            <AvatarUpload
              version={profile.profileVersion}
              onRefresh={() => load(false)}
              onCancel={() => setUploading(false)}
              onSaved={async (id) => {
                await load(false);
                if (!live.current) return;
                setAvatar(id);
                await onUpdated();
                setUploading(false);
                setMessage("头像已换好");
              }}
            />
          )}
          {editing && !uploading && (
            <form
              className="profile-editor"
              onSubmit={(e) => {
                e.preventDefault();
                if (!changed) return;
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
                  setMessage("已保存。过去的牌谱里仍是当时的样子。");
                });
              }}
            >
              <label>
                名字
                <input
                  value={name}
                  maxLength={32}
                  disabled={renameLocked}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                />
              </label>
              <p className="muted">
                {renameLocked
                  ? `名字每 24 小时可改一次，${renameAt} 之后可以再改。`
                  : `${[...name.trim()].length}/16 字。名字每 24 小时可改一次。`}
              </p>
              <div className="avatar-grid" role="group" aria-label="选一个头像">
                <button
                  type="button"
                  className="avatar-add"
                  onClick={() => {
                    setMessage("");
                    setUploading(true);
                  }}
                >
                  <span aria-hidden="true">＋</span>
                  <span>上传照片</span>
                </button>
                {[
                  ...(uploadedAvatarSchema.safeParse(profile.avatarId).success
                    ? [{ id: profile.avatarId, name: "我的照片" }]
                    : []),
                  ...profile.avatars,
                ].map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={avatar === a.id ? "selected" : ""}
                    aria-pressed={avatar === a.id}
                    onClick={() => setAvatar(a.id)}
                  >
                    <Avatar id={a.id} label="" />
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
              <p className="muted">在牌桌里时，资料要等离开后才能改。</p>
              <div className="actions">
                <button className="primary" disabled={busy || !changed}>
                  {busy ? "正在保存…" : "保存"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setName(profile.displayName);
                    setAvatar(profile.avatarId);
                  }}
                >
                  取消
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {revoking && (
        <form
          className="devices"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              try {
                await call("/auth/sessions/revoke-others", {
                  currentPassword: password,
                  flowId: flowId.current,
                });
                if (live.current) {
                  setRevoking(false);
                  setMessage("其他设备都已退出，这台照常");
                }
              } finally {
                setPassword("");
              }
            });
          }}
        >
          <p>
            除了这台，其他设备上的登录都会失效；那边若正在打牌，会交给假想妖托管。
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
            全部退出
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRevoking(false);
              setPassword("");
            }}
          >
            取消
          </button>
        </form>
      )}
    </section>
  );
}
