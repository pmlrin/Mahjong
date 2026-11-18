import { AccountTools } from "./account-tools";
import type { SocialCapabilities } from "../../shared/social";
import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { AuthClock } from "./auth-clock";
import type { CurrentUser, AuthCapabilities } from "../../shared/types";
export type AccountPage = "profile" | "register" | "login" | "reset" | "change";
export function AccountPanel({
  page,
  setPage,
  me,
  capabilities,
  needsRelease,
  onRelease,
  onIdentity,
  onCancel,
  socialCapabilities,
  onProfileUpdated,
}: {
  socialCapabilities?: Partial<SocialCapabilities>;
  onProfileUpdated?: () => Promise<void>;
  page: AccountPage;
  setPage: (p: AccountPage) => void;
  me: CurrentUser | null;
  capabilities: AuthCapabilities | null;
  needsRelease: boolean;
  onRelease: () => Promise<void>;
  onIdentity: (result: "changed" | "logout" | "loginRequired") => Promise<void>;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [currentPassword, setCurrentPassword] = useState(""),
    [stage, setStage] = useState<"email" | "code" | "password">("email"),
    [challengeId, setChallengeId] = useState(""),
    [grant, setGrant] = useState(""),
    [expiresAt, setExpiresAt] = useState(0),
    [resendAt, setResendAt] = useState(0),
    [now, setNow] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [confirmSwitch, setConfirmSwitch] = useState(false),
    [confirmGuestLogout, setConfirmGuestLogout] = useState(false),
    [existingAccount, setExistingAccount] = useState(false),
    [flowId] = useState(() => crypto.randomUUID());
  const pending = useRef(new Map<string, { body: string; id: string }>());
  const clock = useRef(new AuthClock());
  useEffect(() => {
    const timer = setInterval(() => setNow(clock.current.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function call<T = any>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const payload = { ...body, flowId },
      serialized = JSON.stringify(payload),
      old = pending.current.get(path),
      id = old?.body === serialized ? old.id : crypto.randomUUID();
    pending.current.set(path, { body: serialized, id });
    try {
      const result = await api<T>("/auth/" + path, "POST", payload, {
        "Idempotency-Key": id,
      });
      clock.current.sync((result as { serverTime?: number }).serverTime);
      setNow(clock.current.now());
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
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const locked = needsRelease && page !== "reset";
  const prefix = page === "reset" ? "password-reset" : "register",
    mailAllowed =
      page === "reset"
        ? capabilities?.passwordReset
        : capabilities?.registration;
  const countdown = Math.max(0, Math.ceil((resendAt - now) / 1000)),
    remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  async function send() {
    await run(async () => {
      const result = await call(prefix + "/code", { email });
      setChallengeId(result.challengeId);
      setExpiresAt(result.expiresAt);
      setResendAt(result.resendAt);
      setGrant("");
      setCode("");
      setStage("code");
      setMessage(result.message);
    });
  }
  async function verify() {
    await run(async () => {
      const result = await call(prefix + "/verify", { challengeId, code });
      setCode("");
      if (result.alreadyRegistered) {
        setExistingAccount(true);
        setGrant("");
        setMessage(result.message);
        setStage("email");
        return;
      }
      if (result.completed) {
        await onIdentity("loginRequired");
        return;
      }
      setGrant(result.grant);
      setExpiresAt(result.expiresAt);
      setStage("password");
      setMessage("邮箱已验证，请在五分钟内设好密码");
    });
  }
  function passwordsValid() {
    const length = Array.from(password).length;
    if (length < 12 || length > 128) throw Error("密码需要 12 到 128 个字符");
    if (password !== confirmation) throw Error("两次输入的密码不一样");
  }
  async function complete() {
    await run(async () => {
      passwordsValid();
      const result = await call(prefix + "/complete", {
        grant,
        password,
        confirmation,
      });
      setGrant("");
      setPassword("");
      setConfirmation("");
      if (page === "reset" || result.loginRequired)
        await onIdentity("loginRequired");
      else await onIdentity("changed");
    });
  }
  async function login() {
    await run(async () => {
      await call("login", {
        email,
        password,
        confirmSwitchGuest: confirmSwitch,
      });
      setPassword("");
      await onIdentity("changed");
    });
  }
  async function logout() {
    await run(async () => {
      await call("logout", {});
      setPassword("");
      setGrant("");
      await onIdentity("logout");
    });
  }
  async function change() {
    await run(async () => {
      passwordsValid();
      await call("password/change", {
        currentPassword,
        password,
        confirmation,
      });
      setCurrentPassword("");
      setPassword("");
      setConfirmation("");
      await onIdentity("changed");
    });
  }
  const pwdFields = (
    <>
      <label>
        新密码{" "}
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          maxLength={256}
        />
      </label>
      <small>至少 12 个字符。</small>
      <label>
        再输一次{" "}
        <input
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          required
          maxLength={256}
        />
      </label>
    </>
  );
  const title = {
    profile: "我的账号",
    register: "注册",
    login: "登录",
    reset: "找回密码",
    change: "修改密码",
  }[page];
  return (
    <main className="account-page">
      <button className="text-button" onClick={onCancel}>
        返回
      </button>
      <h1>{title}</h1>
      {capabilities?.environment === "preview" && (
        <p className="account-notice">
          这里是预览站，账号和战绩与正式站互不相通。
        </p>
      )}
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="account-notice">
          {message}
        </p>
      )}
      {locked && (
        <section className="account-release">
          <h2>先离开牌桌</h2>
          <p>
            进行中的对局会交给假想妖
            托管，座位和点数都保留；还没开局的话，会先离开房间。
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => run(onRelease)}
          >
            离开牌桌，继续
          </button>
          <button className="text-button" onClick={onCancel}>
            回到牌桌
          </button>
        </section>
      )}
      {page === "profile" ? (
        <section className="account-card">
          <h2>{me?.displayName ?? "尚未入座"}</h2>
          {me?.identityKind === "ACCOUNT" ? (
            <>
              <p>{me.maskedEmail}</p>
              <AccountTools
                key={me.userId}
                userId={me.userId}
                capabilities={socialCapabilities ?? {}}
                onUpdated={onProfileUpdated ?? (async () => {})}
              />
              <button className="secondary" onClick={() => setPage("change")}>
                修改密码
              </button>
              <button
                className="text-button"
                disabled={busy || locked}
                onClick={logout}
              >
                退出登录
              </button>
            </>
          ) : (
            <>
              <p>
                你现在是游客。注册后，换台设备也能接着打，已有战绩一并保留。
              </p>
              <button
                className="primary"
                disabled={!capabilities?.registration}
                onClick={() => setPage("register")}
              >
                注册
              </button>
              <button
                className="secondary"
                disabled={!capabilities?.passwordLogin}
                onClick={() => setPage("login")}
              >
                已有账号，登录
              </button>
              {me &&
                (!confirmGuestLogout ? (
                  <button
                    className="text-button"
                    onClick={() => setConfirmGuestLogout(true)}
                  >
                    退出游客
                  </button>
                ) : (
                  <div className="account-notice">
                    <p>游客退出后就找不回来了，连同战绩。不如先注册？</p>
                    <button
                      className="secondary"
                      disabled={busy || locked}
                      onClick={logout}
                    >
                      仍要退出
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setConfirmGuestLogout(false)}
                    >
                      算了
                    </button>
                  </div>
                ))}
            </>
          )}
          {!capabilities?.mailAvailable && (
            <p className="muted">
              注册暂未开放。游客照常可玩，已有账号也能登录。
            </p>
          )}
        </section>
      ) : page === "login" ? (
        <form
          className="account-card"
          onSubmit={(e) => {
            e.preventDefault();
            login();
          }}
        >
          <label>
            邮箱{" "}
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              required
            />
          </label>
          <label>
            密码{" "}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={256}
              required
            />
          </label>
          {me?.identityKind === "GUEST" && (
            <div className="account-notice">
              <label>
                <input
                  type="checkbox"
                  checked={confirmSwitch}
                  onChange={(e) => setConfirmSwitch(e.target.checked)}
                />
                我知道：登录后，当前游客和它的战绩就找不回来了。
              </label>
              <button
                type="button"
                className="text-button"
                disabled={!capabilities?.registration}
                onClick={() => setPage("register")}
              >
                先把这个游客注册成账号
              </button>
            </div>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              locked ||
              !capabilities?.passwordLogin ||
              (me?.identityKind === "GUEST" && !confirmSwitch)
            }
          >
            登录
          </button>
          <button
            type="button"
            className="text-button"
            disabled={!capabilities?.passwordReset}
            onClick={() => setPage("reset")}
          >
            忘记密码
          </button>
          <button type="button" className="text-button" onClick={onCancel}>
            取消
          </button>
        </form>
      ) : page === "change" ? (
        <form
          className="account-card"
          onSubmit={(e) => {
            e.preventDefault();
            change();
          }}
        >
          <p>改好后，其他设备需要重新登录。</p>
          <label>
            当前密码{" "}
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              maxLength={256}
              required
            />
          </label>
          {pwdFields}
          <button
            className="primary"
            disabled={busy || locked || me?.identityKind !== "ACCOUNT"}
          >
            修改密码
          </button>
        </form>
      ) : (
        <>
          {!mailAllowed ? (
            <section className="account-card">
              <p>
                {page === "reset" ? "找回密码" : "注册"}
                暂未开放，请稍后再来。
              </p>
              <button className="secondary" onClick={onCancel}>
                返回
              </button>
              {capabilities?.passwordLogin && (
                <button
                  className="text-button"
                  onClick={() => setPage("login")}
                >
                  已有账号，登录
                </button>
              )}
            </section>
          ) : page === "register" && !me ? (
            <form
              className="account-card"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api("/sessions/guest", "POST", {
                    displayName: name.trim(),
                  });
                  await onIdentity("changed");
                });
              }}
            >
              <p>先起个名字入座，再用邮箱完成注册。</p>
              <label>
                昵称{" "}
                <input
                  autoComplete="nickname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={16}
                  required
                />
              </label>
              <button className="primary" disabled={busy || !name.trim()}>
                入座
              </button>
            </form>
          ) : (
            <section className="account-card">
              {stage !== "password" ? (
                <>
                  <label>
                    邮箱{" "}
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={stage === "code"}
                      maxLength={254}
                    />
                  </label>
                  {capabilities?.previewRestricted && (
                    <p className="muted">预览站只给登记过的测试邮箱发信。</p>
                  )}
                  {existingAccount && (
                    <div className="account-shortcuts">
                      <button
                        className="secondary"
                        onClick={() => setPage("login")}
                      >
                        已有账号，登录
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setPage("reset")}
                      >
                        找回密码
                      </button>
                    </div>
                  )}
                  <button
                    className="secondary"
                    disabled={busy || countdown > 0 || !email}
                    onClick={send}
                  >
                    {countdown > 0
                      ? `${countdown} 秒后可重发`
                      : stage === "code"
                        ? "重新发送验证码"
                        : "发送验证码"}
                  </button>
                  {stage === "code" && (
                    <>
                      <label>
                        验证码{" "}
                        <input
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          value={code}
                          onChange={(e) =>
                            setCode(
                              e.target.value.replace(/\D/g, "").slice(0, 6),
                            )
                          }
                          maxLength={6}
                        />
                      </label>
                      <p className="muted">
                        {remaining > 0
                          ? `验证码 ${Math.ceil(remaining / 60)} 分钟内有效`
                          : "验证码过期了，请重新获取"}
                      </p>
                      <button
                        className="primary"
                        disabled={busy || code.length !== 6 || remaining === 0}
                        onClick={verify}
                      >
                        验证邮箱
                      </button>
                      <button
                        className="text-button"
                        onClick={() => {
                          setStage("email");
                          setCode("");
                          setGrant("");
                        }}
                      >
                        换个邮箱
                      </button>
                    </>
                  )}
                </>
              ) : (
                <>
                  <p>
                    {page === "register"
                      ? "邮箱已验证。设好密码，账号就建好了，游客战绩一并带上。"
                      : "邮箱已验证。设好新密码后，请重新登录。"}
                  </p>
                  {pwdFields}
                  <p className="muted">还剩 {remaining} 秒</p>
                  <button
                    className="primary"
                    disabled={busy || locked || remaining === 0}
                    onClick={complete}
                  >
                    {page === "register" ? "完成注册" : "设好新密码"}
                  </button>
                  {remaining === 0 && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setStage("email");
                        setGrant("");
                        setPassword("");
                        setConfirmation("");
                      }}
                    >
                      超时了，重新验证邮箱
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
