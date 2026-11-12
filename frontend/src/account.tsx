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
  onFriends,
}: {
  socialCapabilities?: Partial<SocialCapabilities>;
  onProfileUpdated?: () => Promise<void>;
  onFriends?: () => void;
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
      setMessage("邮箱已验证，请在五分钟内设置密码");
    });
  }
  function passwordsValid() {
    const length = Array.from(password).length;
    if (length < 12 || length > 128)
      throw Error("密码须为 12～128 个字符；空格不会自动删除");
    if (password !== confirmation) throw Error("两次输入的密码不一致");
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
      <small>12～128 个字符，支持粘贴密码，空格会按原值保留。</small>
      <label>
        确认新密码{" "}
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
    profile: "个人与账号",
    register: "注册账号",
    login: "邮箱密码登录",
    reset: "找回密码",
    change: "修改密码",
  }[page];
  return (
    <main className="account-page">
      <button className="text-button" onClick={onCancel}>
        返回牌桌或首页
      </button>
      <h1>{title}</h1>
      <p className="page-sub">把这一桌，留在自己名下</p>
      {capabilities?.environment === "preview" && (
        <p className="account-notice">
          当前为预览环境，账号和战绩与正式站分别保存。
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
          <h2>先退出当前牌桌控制</h2>
          <p>
            进行中的比赛会交给
            AI，座位、点数和已经提交的选择都会保留。若还在准备厅，会离开该准备位置。
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => run(onRelease)}
          >
            托管／离开准备厅并继续
          </button>
          <button className="text-button" onClick={onCancel}>
            取消，回到牌桌
          </button>
        </section>
      )}
      {page === "profile" ? (
        <section className="account-card">
          <h2>{me?.displayName ?? "欢迎入座"}</h2>
          {me?.identityKind === "ACCOUNT" ? (
            <>
              <p>正式账号：{me.maskedEmail}</p>
              <AccountTools
                key={me.userId}
                userId={me.userId}
                capabilities={socialCapabilities ?? {}}
                onUpdated={onProfileUpdated ?? (async () => {})}
                onFriends={onFriends ?? (() => {})}
              />
              <p>
                登录同一环境即可读取仍在保存期内的战绩；注册不会把牌谱延长为永久保存。
              </p>
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
              <p>游客身份，注册后可在其他浏览器登录。</p>
              <p>
                注册新账号将保留当前游客原来的比赛归属；登录已有账号不会合并游客记录。
              </p>
              <button
                className="primary"
                disabled={!capabilities?.registration}
                onClick={() => setPage("register")}
              >
                注册当前游客
              </button>
              <button
                className="secondary"
                disabled={!capabilities?.passwordLogin}
                onClick={() => setPage("login")}
              >
                登录已有账号
              </button>
              {me &&
                (!confirmGuestLogout ? (
                  <button
                    className="text-button"
                    onClick={() => setConfirmGuestLogout(true)}
                  >
                    退出游客身份
                  </button>
                ) : (
                  <div className="account-notice">
                    <p>
                      退出后，不承诺找回这个未注册游客的身份。可以先注册，或取消退出。
                    </p>
                    <button
                      className="secondary"
                      disabled={busy || locked}
                      onClick={logout}
                    >
                      确认退出当前游客
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setConfirmGuestLogout(false)}
                    >
                      取消退出
                    </button>
                  </div>
                ))}
            </>
          )}
          {!capabilities?.mailAvailable && (
            <p className="muted">
              邮箱验证暂未开放。游客试玩仍可使用，已有账号的密码登录独立保留。
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
                我知道：当前游客记录不会合并，切换后可能无法找回。
              </label>
              <button
                type="button"
                className="text-button"
                disabled={!capabilities?.registration}
                onClick={() => setPage("register")}
              >
                先注册当前游客，保留这份战绩
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
            取消身份切换
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
          <p>修改成功后，其他设备需要重新登录；本页将使用一个新的登录会话。</p>
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
            确认修改密码
          </button>
        </form>
      ) : (
        <>
          {!mailAllowed ? (
            <section className="account-card">
              <p>
                邮件验证尚未配置或暂时不可用，当前不能完成
                {page === "reset" ? "找回密码" : "注册"}
                。不会创建未经验证的账号。
              </p>
              <button className="secondary" onClick={onCancel}>
                返回游客试玩
              </button>
              {capabilities?.passwordLogin && (
                <button
                  className="text-button"
                  onClick={() => setPage("login")}
                >
                  使用已有账号密码登录
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
              <p>先为你建立游客身份，再验证邮箱。升级后保留同一个玩家 ID。</p>
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
                先以游客入座
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
                    <p className="muted">
                      预览仅向已确认的测试邮箱发送邮件。申请受理不等于邮件已经投递。
                    </p>
                  )}
                  {existingAccount && (
                    <div className="account-shortcuts">
                      <button
                        className="secondary"
                        onClick={() => setPage("login")}
                      >
                        登录已有账号
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
                        六位验证码{" "}
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
                          ? `本次验证码剩余 ${Math.ceil(remaining / 60)} 分钟`
                          : "验证码已过期，请重新申请"}
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
                        修改邮箱
                      </button>
                    </>
                  )}
                </>
              ) : (
                <>
                  <p>
                    邮箱已验证。新密码设置完成后
                    {page === "register"
                      ? "才创建正式账号，并保留当前游客战绩"
                      : "会退出全部旧会话，随后请重新登录"}
                    。
                  </p>
                  {pwdFields}
                  <p className="muted">本次设置授权剩余 {remaining} 秒</p>
                  <button
                    className="primary"
                    disabled={busy || locked || remaining === 0}
                    onClick={complete}
                  >
                    {page === "register"
                      ? "完成注册并保留游客战绩"
                      : "重设密码"}
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
                      授权已过期，重新验证邮箱
                    </button>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      <p className="account-footnote">
        验证码、完成凭据和密码不会出现在诊断信息或牌谱中。清除未注册游客的会话后，不能凭昵称找回。
      </p>
    </main>
  );
}
