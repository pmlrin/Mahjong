import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { AvatarUpload } from "./avatar-upload";
import type { SocialProfile, SocialCapabilities } from "../../shared/social";
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
            好友码 <code>{profile.friendCode.match(/.{4}/g)?.join("-")}</code>{" "}
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
                onClick={() => {
                  setEditing((v) => !v);
                  setUploading(false);
                }}
              >
                改名字或头像
              </button>
            )}
            {capabilities.profileEditing && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setUploading((v) => !v);
                  setEditing(false);
                }}
              >
                上传照片做头像
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
                  setMessage("已保存。过去的牌谱里仍是当时的样子。");
                });
              }}
            >
              <label>
                名字
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="nickname"
                />
              </label>
              <p className="muted">
                名字每 24 小时可改一次；在房间或对局中时暂不能改。
              </p>
              <div className="avatar-grid" role="group" aria-label="选一个头像">
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
                保存
              </button>
            </form>
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
                setMessage("头像已换好");
              }}
            />
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
            除了这台，其他设备上的登录都会失效；那边若正在打牌，会转为 AI 托管。
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
