import { ensureSocialProfile } from "../social/schema.ts";
import { randomInt, randomUUID } from "node:crypto";
import type { Store } from "../store.ts";
import type { Sql } from "../sql.ts";
import { migrateAuth } from "./migration.ts";
import { mailConfigured, type AuthConfig } from "./config.ts";
import {
  Passwords,
  digest,
  mac,
  opaque,
  equal,
  email,
  validatePassword,
  maskEmail,
  seal,
} from "./crypto.ts";
import {
  AuthError,
  failed,
  type AuthReply,
  type AuthContext,
  type AuthHooks,
  type Profile,
  type Account,
  type AuthSession,
  type Identity,
  type Purpose,
} from "./types.ts";
const DAY = 86400000,
  MINUTE = 60000;
const profile = (r: any): Profile => ({
  userId: r.user_id,
  displayName: r.display_name,
  kind: r.kind,
  createdAt: Number(r.created_at),
});
const account = (r: any): Account => ({
  userId: r.user_id,
  emailKey: r.email_key,
  emailAddress: r.email_address,
  emailVerifiedAt: Number(r.email_verified_at),
  passwordHash: r.password_hash,
  authVersion: Number(r.auth_version),
  updatedAt: Number(r.updated_at),
});
const session = (r: any): AuthSession => ({
  tokenHash: r.token_hash,
  userId: r.user_id,
  authVersion: Number(r.auth_version),
  environment: r.environment,
  createdAt: Number(r.created_at),
  expires: Number(r.expires_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
});
interface Prior {
  payload_hmac: string;
  result: string;
}
interface Delta {
  userId: string;
  profile: Profile | null;
  account: Account | null;
  sessions: AuthSession[];
}
export class AuthService {
  readonly profiles = new Map<string, Profile>();
  readonly accounts = new Map<string, Account>();
  readonly sessions = new Map<string, AuthSession>();
  readonly passwords: Passwords;
  mailHealthy = true;
  failedClosed = false;
  constructor(
    readonly store: Store,
    readonly config: AuthConfig,
    readonly hooks: AuthHooks,
    readonly now: () => number = Date.now,
    private readonly generateCode: () => string = () =>
      String(randomInt(1000000)).padStart(6, "0"),
  ) {
    this.passwords = new Passwords(config.passwordConcurrency);
  }
  async initialize() {
    const migration = await migrateAuth(this.store, this.config, this.now());
    await this.store.transaction(async (tx) => {
      for (const r of await tx.rows("SELECT * FROM auth_users"))
        this.profiles.set(r.user_id, profile(r));
      for (const r of await tx.rows("SELECT * FROM auth_accounts"))
        this.accounts.set(r.user_id, account(r));
      for (const r of await tx.rows("SELECT * FROM auth_sessions"))
        this.sessions.set(r.token_hash, session(r));
    });
    return migration;
  }
  async reloadAfterFailure() {
    this.failedClosed = true;
    const before = [...this.sessions.keys()];
    try {
      const snapshot = await this.store.transaction(async (tx) => ({
        profiles: await tx.rows("SELECT * FROM auth_users"),
        accounts: await tx.rows("SELECT * FROM auth_accounts"),
        sessions: await tx.rows("SELECT * FROM auth_sessions"),
      }));
      this.profiles.clear();
      this.accounts.clear();
      this.sessions.clear();
      for (const r of snapshot.profiles)
        this.profiles.set(r.user_id, profile(r));
      for (const r of snapshot.accounts)
        this.accounts.set(r.user_id, account(r));
      for (const r of snapshot.sessions)
        this.sessions.set(r.token_hash, session(r));
      this.failedClosed = false;
      const revoked = before.filter((hash) => !this.resolveHash(hash));
      if (revoked.length) await this.hooks.invalidate(revoked);
    } catch {
      this.failedClosed = true;
    }
  }
  capabilities() {
    const login =
      !this.failedClosed &&
      this.config.requestSecret.length >= 32 &&
      (this.config.enabled || this.accounts.size > 0);
    const mail =
      !this.failedClosed && mailConfigured(this.config) && this.mailHealthy;
    return {
      enabled: this.config.enabled,
      passwordLogin: login,
      registration: mail,
      passwordReset: mail,
      mailAvailable: mail,
      previewRestricted: this.config.environment === "preview",
      environment: this.config.environment,
    };
  }
  resolveHash(hash: string | null): Identity | null {
    if (!hash || this.failedClosed) return null;
    const s = this.sessions.get(hash),
      p = s && this.profiles.get(s.userId),
      a = s && this.accounts.get(s.userId);
    if (
      !s ||
      !p ||
      s.environment !== this.config.environment ||
      s.revokedAt !== null ||
      s.expires <= this.now() ||
      s.authVersion !== (a?.authVersion ?? 0) ||
      (p.kind === "ACCOUNT" && !a)
    )
      return null;
    return {
      ...s,
      displayName: p.displayName,
      kind: p.kind,
      maskedEmail: a ? maskEmail(a.emailAddress) : null,
    };
  }
  resolveToken(token: string | null) {
    return this.resolveHash(token ? digest(token) : null);
  }
  private requireIdentity(ctx: AuthContext, kind?: "GUEST" | "ACCOUNT") {
    const s = this.resolveHash(ctx.tokenHash);
    if (!s)
      throw new AuthError(
        "UNAUTHENTICATED",
        "身份已失效，请重新登录或选择游客试玩",
        401,
      );
    if (kind && s.kind !== kind)
      throw new AuthError(
        "IDENTITY_MISMATCH",
        kind === "GUEST" ? "当前身份已是正式账号" : "请先登录正式账号",
        403,
      );
    return s;
  }
  private requireMail() {
    if (!mailConfigured(this.config) || !this.mailHealthy)
      throw new AuthError(
        "MAIL_UNAVAILABLE",
        "邮箱验证暂不可用，请稍后重试；游客试玩和密码登录仍可使用",
        503,
      );
  }
  private flow(ctx: AuthContext) {
    return mac(
      this.config.requestSecret,
      this.config.environment,
      "flow",
      ctx.flowId,
    );
  }
  private scope(name: string, ctx: AuthContext) {
    return mac(
      this.config.requestSecret,
      this.config.environment,
      name,
      ctx.tokenHash ?? this.flow(ctx),
    );
  }
  async bucket(tx: Sql, key: string, window: number) {
    return tx.one(
      "SELECT COALESCE(SUM(count),0) AS count,MIN(expires_at) AS expires_at FROM auth_limits WHERE bucket LIKE ? AND expires_at>?",
      [key + ":" + window + ":%", this.now()],
    );
  }
  private key(type: string, value: string) {
    return mac(this.config.requestSecret, this.config.environment, type, value);
  }
  async limit(
    tx: Sql,
    key: string,
    window: number,
    max: number,
    increment: boolean,
  ) {
    const old = await this.bucket(tx, key, window);
    if (Number(old?.count ?? 0) >= max) return false;
    if (increment)
      await tx.query(
        "INSERT INTO auth_limits(bucket,count,expires_at) VALUES(?,1,?)",
        [key + ":" + window + ":" + randomUUID(), this.now() + window],
      );
    return true;
  }
  async purgeExpiredLimits() {
    await this.store.transaction((tx) =>
      tx.query("DELETE FROM auth_limits WHERE expires_at<=?", [this.now()]),
    );
  }
  private async audit(
    tx: Sql,
    event: string,
    userId: string | null,
    details: Record<string, unknown> = {},
  ) {
    await tx.query(
      "INSERT INTO auth_audit(audit_id,event,subject_id,environment,at,details) VALUES(?,?,?,?,?,?)",
      [
        randomUUID(),
        event,
        userId,
        this.config.environment,
        this.now(),
        JSON.stringify(details),
      ],
    );
  }
  private async delta(tx: Sql, userId: string): Promise<Delta> {
    const p = await tx.one("SELECT * FROM auth_users WHERE user_id=?", [
        userId,
      ]),
      a = await tx.one("SELECT * FROM auth_accounts WHERE user_id=?", [userId]);
    return {
      userId,
      profile: p ? profile(p) : null,
      account: a ? account(a) : null,
      sessions: (
        await tx.rows("SELECT * FROM auth_sessions WHERE user_id=?", [userId])
      ).map(session),
    };
  }
  private applyDelta(d: Delta) {
    if (d.profile) this.profiles.set(d.userId, d.profile);
    if (d.account) this.accounts.set(d.userId, d.account);
    for (const [key, s] of this.sessions)
      if (s.userId === d.userId) this.sessions.delete(key);
    for (const s of d.sessions) this.sessions.set(s.tokenHash, s);
  }
  private async operation(
    name: string,
    ctx: AuthContext,
    payload: unknown,
    fn: (
      tx: Sql,
      prior: AuthReply | null,
      changed: Set<string>,
      invalidated: Set<string>,
    ) => Promise<AuthReply>,
    replay = false,
  ) {
    const scope = this.scope(name, ctx),
      hash = mac(
        this.config.requestSecret,
        this.config.environment,
        name,
        payload,
      );
    return this.hooks.serialize(async () => {
      const changed = new Set<string>(),
        invalidated = new Set<string>(),
        deltas: Delta[] = [];
      let result: AuthReply;
      try {
        result = await this.store.transaction(async (tx) => {
          const row = await tx.one<Prior>(
            "SELECT payload_hmac,result FROM auth_receipts WHERE scope=? AND request_id=?",
            [scope, ctx.requestId],
          );
          if (row && row.payload_hmac !== hash)
            return failed(
              "REQUEST_ID_CONFLICT",
              "同一请求编号的内容不能改变",
              409,
            );
          const prior = row ? (JSON.parse(row.result) as AuthReply) : null;
          if (prior && (prior.error || !replay))
            return {
              ...prior,
              ...(name === "REGISTER_COMPLETE"
                ? { data: { ...prior.data, loginRequired: true } }
                : {}),
            };
          const result = await fn(tx, prior, changed, invalidated);
          const safe: AuthReply = {
            data: result.data,
            ...(result.error ? { error: result.error } : {}),
          };
          await tx.query(
            "INSERT INTO auth_receipts(scope,request_id,payload_hmac,result,created_at) VALUES(?,?,?,?,?) ON CONFLICT(scope,request_id) DO UPDATE SET result=excluded.result",
            [scope, ctx.requestId, hash, JSON.stringify(safe), this.now()],
          );
          for (const userId of changed)
            deltas.push(await this.delta(tx, userId));
          return result;
        });
      } catch (error) {
        if (!(error instanceof AuthError)) await this.reloadAfterFailure();
        throw error;
      }
      for (const delta of deltas) this.applyDelta(delta);
      if (invalidated.size) await this.hooks.invalidate([...invalidated]);
      if (result.error)
        throw new AuthError(
          result.error.code,
          result.error.message,
          result.error.status,
        );
      return result;
    });
  }
  private async issueSession(
    tx: Sql,
    userId: string,
    version: number,
    device?: { browser: string; os: string },
  ) {
    const token = opaque(),
      hash = digest(token),
      now = this.now();
    await tx.query(
      "INSERT INTO auth_sessions(token_hash,user_id,auth_version,environment,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,NULL)",
      [hash, userId, version, this.config.environment, now, now + 30 * DAY],
    );
    await tx.query(
      "INSERT INTO social_sessions(session_id,token_hash,user_id,browser,os,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
      [
        randomUUID(),
        hash,
        userId,
        device?.browser ?? "UNKNOWN",
        device?.os ?? "UNKNOWN",
        now,
        now,
      ],
    );
    return { token, hash };
  }
  private async revoke(
    tx: Sql,
    userId: string,
    invalidated: Set<string>,
    only?: string,
  ) {
    const rows = await tx.rows(
      "SELECT token_hash FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL" +
        (only ? " AND token_hash=?" : ""),
      only ? [userId, only] : [userId],
    );
    for (const r of rows) {
      invalidated.add(r.token_hash);
      await tx.query(
        "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?",
        [this.now(), r.token_hash],
      );
      const legacy = await tx.one(
        "SELECT payload FROM documents WHERE kind='session' AND id=?",
        [r.token_hash],
      );
      if (legacy) {
        const value =
          typeof legacy.payload === "string"
            ? JSON.parse(legacy.payload)
            : legacy.payload;
        value.expires = 0;
        await tx.query(
          "UPDATE documents SET payload=? WHERE kind='session' AND id=?",
          [JSON.stringify(value), r.token_hash],
        );
      }
    }
  }
  async createGuest(displayName: string, requestId: string) {
    const token = mac(
        this.config.requestSecret,
        this.config.environment,
        "guest-session",
        requestId,
      ),
      hash = digest(token);
    return this.hooks.serialize(async () => {
      const existing = this.resolveHash(hash);
      if (existing) return { token, identity: existing };
      if (this.sessions.has(hash))
        throw new AuthError(
          "GUEST_RETRY_EXPIRED",
          "这次入座请求已结束，请重新点击游客试玩",
          409,
        );
      const userId = randomUUID();
      let delta: Delta;
      try {
        delta = await this.store.transaction(async (tx) => {
          await tx.query(
            "INSERT INTO auth_users(user_id,display_name,kind,created_at) VALUES(?,?,'GUEST',?)",
            [userId, displayName, this.now()],
          );
          await tx.query(
            "INSERT INTO auth_sessions(token_hash,user_id,auth_version,environment,created_at,expires_at,revoked_at) VALUES(?,?,0,?,?,?,NULL)",
            [
              hash,
              userId,
              this.config.environment,
              this.now(),
              this.now() + 30 * DAY,
            ],
          );
          return this.delta(tx, userId);
        });
      } catch (error) {
        await this.reloadAfterFailure();
        throw error;
      }
      this.applyDelta(delta);
      return { token, identity: this.resolveHash(hash)! };
    });
  }
  async requestCode(purpose: Purpose, addressInput: string, ctx: AuthContext) {
    this.requireMail();
    const target = email(addressInput);
    if (purpose === "REGISTER") this.requireIdentity(ctx, "GUEST");
    return this.operation(
      purpose + "_CODE",
      ctx,
      { email: target.key, flow: ctx.flowId },
      async (tx, _prior, changed) => {
        const s =
          purpose === "REGISTER" ? this.requireIdentity(ctx, "GUEST") : null;
        const cool = await tx.one(
          "SELECT created_at FROM auth_challenges WHERE environment=? AND email_key=? ORDER BY created_at DESC LIMIT 1",
          [this.config.environment, target.key],
        );
        if (cool && this.now() - Number(cool.created_at) < MINUTE)
          return failed("CODE_COOLDOWN", "请在上次申请 60 秒后再试", 429);
        const limits: [
          [string, number, number],
          [string, number, number],
          [string, number, number],
          [string, number, number],
        ] = [
          [this.key("send-email-hour", target.key), 60 * MINUTE, 5],
          [this.key("send-email-day", target.key), DAY, 20],
          [this.key("send-ip-hour", ctx.ip), 60 * MINUTE, 20],
          [this.key("send-ip-day", ctx.ip), DAY, 100],
        ];
        for (const [key, window, max] of limits)
          if (!(await this.limit(tx, key, window, max, false)))
            return failed("AUTH_RATE_LIMITED", "申请较频繁，请稍后再试", 429);
        const budget = await this.bucket(tx, this.key("smtp-day", "all"), DAY);
        if (Number(budget?.count ?? 0) >= this.config.mailDailyLimit)
          return failed(
            "MAIL_UNAVAILABLE",
            "邮件服务今日额度暂不可用，请稍后重试",
            503,
          );
        for (const [key, window, max] of limits)
          await this.limit(tx, key, window, max, true);
        const a = await tx.one(
          "SELECT * FROM auth_accounts WHERE email_key=?",
          [target.key],
        );
        await tx.query(
          "UPDATE auth_challenges SET state='INVALIDATED' WHERE environment=? AND email_key=? AND purpose=? AND state IN ('PENDING','VERIFIED')",
          [this.config.environment, target.key, purpose],
        );
        await tx.query(
          "UPDATE auth_grants SET state='INVALIDATED' WHERE challenge_id IN (SELECT challenge_id FROM auth_challenges WHERE environment=? AND email_key=? AND purpose=?) AND state='ACTIVE'",
          [this.config.environment, target.key, purpose],
        );
        await tx.query(
          "UPDATE auth_mail_jobs SET status='EXPIRED',ciphertext=NULL WHERE challenge_id IN (SELECT challenge_id FROM auth_challenges WHERE environment=? AND email_key=? AND purpose=? AND state='INVALIDATED') AND status='QUEUED'",
          [this.config.environment, target.key, purpose],
        );
        const challengeId = randomUUID(),
          code = this.generateCode(),
          expiresAt = this.now() + 10 * MINUTE;
        const subject = s?.userId ?? a?.user_id ?? null,
          version =
            purpose === "RESET_PASSWORD" ? (a?.auth_version ?? null) : null;
        await tx.query(
          "INSERT INTO auth_challenges(challenge_id,purpose,email_key,email_address,flow_hash,session_hash,subject_id,auth_version,environment,code_hmac,state,failures,created_at,expires_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',0,?,?,NULL)",
          [
            challengeId,
            purpose,
            target.key,
            target.address,
            this.flow(ctx),
            s?.tokenHash ?? null,
            subject,
            version,
            this.config.environment,
            mac(
              this.config.otpSecret,
              this.config.environment,
              purpose,
              challengeId,
              target.key,
              code,
            ),
            this.now(),
            expiresAt,
          ],
        );
        const allowed =
          this.config.environment !== "preview" ||
          this.config.allowlist.has(target.key);
        if (allowed && (purpose === "REGISTER" || a)) {
          const jobId = randomUUID(),
            aad = [this.config.environment, challengeId, purpose, jobId].join(
              ":",
            );
          const label = purpose === "REGISTER" ? "注册账号" : "找回密码",
            prefix =
              this.config.environment === "preview" ? "【预览环境】" : "";
          const message = {
            to: target.address,
            subject: `${prefix}一桌麻将 · ${label}验证码`,
            text: `一桌麻将${prefix}\n你正在${label}，验证码为 ${code}，自申请起十分钟内有效。仅用于 ${this.config.applicationURL} 。\n若非本人操作，请忽略此邮件。`,
            html: `<div lang="zh-CN"><h2>${prefix}一桌麻将 · ${label}</h2><p>验证码：<strong>${code}</strong></p><p>自申请起十分钟内有效，仅用于${this.config.environment === "preview" ? "预览页面" : "正式页面"}的本次${label}。若非本人操作，请忽略此邮件。</p></div>`,
          };
          await tx.query(
            "INSERT INTO auth_mail_jobs(job_id,challenge_id,purpose,environment,masked_recipient,ciphertext,status,attempts,next_attempt_at,lease_until,last_error,provider_id,created_at,expires_at) VALUES(?,?,?,?,?,?,'QUEUED',0,?,NULL,NULL,NULL,?,?)",
            [
              jobId,
              challengeId,
              purpose,
              this.config.environment,
              maskEmail(target.address),
              seal(this.config.encryptionKey, message, aad),
              this.now(),
              this.now(),
              expiresAt,
            ],
          );
        }
        await this.audit(tx, "CODE_REQUESTED", s?.userId ?? null, {
          purpose,
          email: maskEmail(target.address),
        });
        return {
          data: {
            challengeId,
            expiresAt,
            resendAt: this.now() + MINUTE,
            message:
              purpose === "REGISTER"
                ? this.config.environment === "preview"
                  ? "申请已受理，请查看邮箱；预览仅向已确认的测试邮箱发信"
                  : "申请已受理，请查看邮箱"
                : "若该邮箱已注册，将收到验证码",
          },
        };
      },
    );
  }
  async verify(
    purpose: Purpose,
    challengeId: string,
    code: string,
    ctx: AuthContext,
  ) {
    this.requireMail();
    return this.operation(
      purpose + "_VERIFY",
      ctx,
      { challengeId, code, flow: ctx.flowId },
      async (tx, prior) => {
        const c = await tx.one(
          "SELECT * FROM auth_challenges WHERE challenge_id=?",
          [challengeId],
        );
        const invalid = () =>
          failed("CODE_INVALID", "验证码不正确、已失效或不属于当前页面");
        if (
          !c ||
          c.environment !== this.config.environment ||
          c.purpose !== purpose ||
          c.flow_hash !== this.flow(ctx) ||
          (purpose === "REGISTER" && c.session_hash !== ctx.tokenHash)
        )
          return invalid();
        if (prior) {
          if (prior.data.alreadyRegistered) return prior;
          const completed = await tx.one(
            "SELECT token_hash FROM auth_grants WHERE challenge_id=? AND state='CONSUMED'",
            [challengeId],
          );
          if (completed)
            return { data: { completed: true, loginRequired: true } };
          if (
            c.state !== "VERIFIED" ||
            Number(c.verified_at) + 5 * MINUTE <= this.now()
          )
            return failed("GRANT_EXPIRED", "验证授权已到期，请重新申请验证码");
        } else {
          if (purpose === "REGISTER") this.requireIdentity(ctx, "GUEST");
          if (
            c.state !== "PENDING" ||
            Number(c.expires_at) <= this.now() ||
            Number(c.failures) >= 5
          )
            return invalid();
          const failureKey = this.key(
            "verify-failure",
            purpose + ":" + c.email_key,
          );
          if (!(await this.limit(tx, failureKey, 15 * MINUTE, 10, false)))
            return failed("AUTH_RATE_LIMITED", "验证尝试较多，请稍后重试", 429);
          const expected = mac(
            this.config.otpSecret,
            this.config.environment,
            purpose,
            challengeId,
            c.email_key,
            code,
          );
          if (
            !equal(expected, c.code_hmac) ||
            (purpose === "RESET_PASSWORD" && !c.subject_id)
          ) {
            await this.limit(tx, failureKey, 15 * MINUTE, 10, true);
            await tx.query(
              "UPDATE auth_challenges SET failures=failures+1,state=CASE WHEN failures+1>=5 THEN 'INVALIDATED' ELSE state END WHERE challenge_id=?",
              [challengeId],
            );
            return invalid();
          }
          if (purpose === "RESET_PASSWORD") {
            const current = await tx.one(
              "SELECT auth_version FROM auth_accounts WHERE user_id=?",
              [c.subject_id],
            );
            if (
              !current ||
              Number(current.auth_version) !== Number(c.auth_version)
            )
              return invalid();
          }
          await tx.query(
            "UPDATE auth_challenges SET state='VERIFIED',verified_at=? WHERE challenge_id=?",
            [this.now(), challengeId],
          );
          c.verified_at = this.now();
        }
        if (
          purpose === "REGISTER" &&
          (await tx.one("SELECT user_id FROM auth_accounts WHERE email_key=?", [
            c.email_key,
          ]))
        )
          return {
            data: {
              verified: true,
              alreadyRegistered: true,
              message: "该邮箱已有账号，请登录或找回密码",
            },
          };
        await tx.query(
          "UPDATE auth_grants SET state='INVALIDATED' WHERE challenge_id=? AND state='ACTIVE'",
          [challengeId],
        );
        const token = opaque(),
          expiresAt = Number(c.verified_at) + 5 * MINUTE;
        await tx.query(
          "INSERT INTO auth_grants(token_hash,challenge_id,purpose,flow_hash,session_hash,subject_id,environment,expires_at,state) VALUES(?,?,?,?,?,?,?,?,'ACTIVE')",
          [
            digest(token),
            challengeId,
            purpose,
            this.flow(ctx),
            c.session_hash,
            c.subject_id,
            this.config.environment,
            expiresAt,
          ],
        );
        // The opaque grant is returned only in memory; the receipt stores its digest.
        return {
          data: { verified: true, grantHash: digest(token), expiresAt },
          token,
        };
      },
      true,
    ).then((result) =>
      result.token
        ? {
            data: {
              verified: true,
              grant: result.token,
              expiresAt: result.data.expiresAt,
            },
          }
        : result,
    );
  }
  private async grant(
    tx: Sql,
    purpose: Purpose,
    token: string,
    ctx: AuthContext,
  ) {
    const g = await tx.one("SELECT * FROM auth_grants WHERE token_hash=?", [
      digest(token),
    ]);
    if (
      !g ||
      g.purpose !== purpose ||
      g.environment !== this.config.environment ||
      g.flow_hash !== this.flow(ctx) ||
      g.state !== "ACTIVE" ||
      Number(g.expires_at) <= this.now() ||
      (purpose === "REGISTER" && g.session_hash !== ctx.tokenHash)
    )
      return null;
    const c = await tx.one(
      "SELECT * FROM auth_challenges WHERE challenge_id=?",
      [g.challenge_id],
    );
    return c?.state === "VERIFIED" ? { g, c } : null;
  }
  async complete(
    purpose: Purpose,
    grant: string,
    password: string,
    confirmation: string,
    ctx: AuthContext,
  ) {
    validatePassword(password, confirmation);
    if (!this.config.enabled)
      throw new AuthError("AUTH_UNAVAILABLE", "注册与找回入口暂时关闭", 503);
    const name =
        purpose === "REGISTER" ? "REGISTER_COMPLETE" : "RESET_COMPLETE",
      payload = { grant, password, confirmation, flow: ctx.flowId };
    // Prove eligibility before reserving a password worker. Replays and random,
    // expired or cross-context grants must not become an anonymous hash workload.
    // The final write still rechecks the grant after the asynchronous hash.
    const preflight = await this.hooks.serialize(async () => {
      try {
        return await this.store.transaction(async (tx) => {
          const receipt = await tx.one(
            "SELECT request_id FROM auth_receipts WHERE scope=? AND request_id=?",
            [this.scope(name, ctx), ctx.requestId],
          );
          if (receipt) return "REPLAY" as const;
          const valid = await this.grant(tx, purpose, grant, ctx);
          if (!valid)
            return failed("GRANT_INVALID", "验证凭据已失效，请重新申请验证码");
          if (purpose === "REGISTER")
            this.hooks.assertReleased(this.requireIdentity(ctx, "GUEST"));
          else {
            const account = await tx.one(
              "SELECT auth_version FROM auth_accounts WHERE user_id=?",
              [valid.c.subject_id],
            );
            if (
              !account ||
              Number(account.auth_version) !== Number(valid.c.auth_version)
            )
              return failed("GRANT_INVALID", "密码状态已变化，请重新找回");
          }
          return null;
        });
      } catch (error) {
        if (!(error instanceof AuthError)) await this.reloadAfterFailure();
        throw error;
      }
    });
    if (preflight)
      return this.operation(name, ctx, payload, async () =>
        preflight === "REPLAY"
          ? failed("GRANT_INVALID", "验证凭据已失效，请重新申请验证码")
          : preflight,
      );
    const hash = await this.passwords.hash(password);
    return this.operation(
      name,
      ctx,
      payload,
      async (tx, _prior, changed, invalidated) => {
        const valid = await this.grant(tx, purpose, grant, ctx);
        if (!valid)
          return failed("GRANT_INVALID", "验证凭据已失效，请重新申请验证码");
        const { g, c } = valid;
        if (purpose === "REGISTER") {
          const s = this.requireIdentity(ctx, "GUEST");
          this.hooks.assertReleased(s);
          if (
            await tx.one(
              "SELECT user_id FROM auth_accounts WHERE email_key=?",
              [c.email_key],
            )
          )
            return failed(
              "EMAIL_ALREADY_REGISTERED",
              "该邮箱已有账号，请登录或找回密码",
              409,
            );
          if (
            await tx.one("SELECT user_id FROM auth_accounts WHERE user_id=?", [
              s.userId,
            ])
          )
            return failed(
              "IDENTITY_MISMATCH",
              "当前游客已升级，请直接登录",
              409,
            );
          await tx.query(
            "INSERT INTO auth_accounts(user_id,email_key,email_address,email_verified_at,password_hash,auth_version,updated_at) VALUES(?,?,?,?,?,1,?)",
            [
              s.userId,
              c.email_key,
              c.email_address,
              Number(c.verified_at),
              hash,
              this.now(),
            ],
          );
          await ensureSocialProfile(tx, s.userId);
          await tx.query(
            "UPDATE auth_users SET kind='ACCOUNT' WHERE user_id=?",
            [s.userId],
          );
          await tx.query(
            "UPDATE auth_grants SET state='CONSUMED' WHERE token_hash=? AND state='ACTIVE'",
            [g.token_hash],
          );
          await this.revoke(tx, s.userId, invalidated);
          const issued = await this.issueSession(tx, s.userId, 1, ctx.device);
          changed.add(s.userId);
          await this.audit(tx, "REGISTERED", s.userId, {
            email: maskEmail(c.email_address),
          });
          return {
            data: { completed: true, userId: s.userId },
            token: issued.token,
          };
        }
        const a = await tx.one("SELECT * FROM auth_accounts WHERE user_id=?", [
          c.subject_id,
        ]);
        if (!a || Number(a.auth_version) !== Number(c.auth_version))
          return failed("GRANT_INVALID", "密码状态已变化，请重新找回");
        await tx.query(
          "UPDATE auth_accounts SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE user_id=?",
          [hash, this.now(), a.user_id],
        );
        await tx.query(
          "UPDATE auth_grants SET state='CONSUMED' WHERE token_hash=? AND state='ACTIVE'",
          [g.token_hash],
        );
        await tx.query(
          "UPDATE auth_grants SET state='INVALIDATED' WHERE subject_id=? AND purpose='RESET_PASSWORD' AND state='ACTIVE'",
          [a.user_id],
        );
        await tx.query(
          "UPDATE auth_challenges SET state='INVALIDATED' WHERE subject_id=? AND purpose='RESET_PASSWORD' AND state IN ('PENDING','VERIFIED')",
          [a.user_id],
        );
        await this.revoke(tx, a.user_id, invalidated);
        changed.add(a.user_id);
        await this.audit(tx, "PASSWORD_RESET", a.user_id);
        return {
          data: {
            completed: true,
            loginRequired: true,
            message: "密码已重设，请重新登录",
          },
        };
      },
    );
  }
  private async loginLimits(
    tx: Sql,
    key: string,
    ip: string,
    increment: boolean,
  ) {
    const keys = [this.key("login-email", key), this.key("login-ip", ip)];
    for (const k of keys)
      if (!(await this.limit(tx, k, 15 * MINUTE, 10, false))) return false;
    if (increment)
      for (const k of keys) await this.limit(tx, k, 15 * MINUTE, 10, true);
    return true;
  }
  async login(
    addressInput: string,
    password: string,
    confirmSwitchGuest: boolean,
    ctx: AuthContext,
  ) {
    if (!this.capabilities().passwordLogin)
      throw new AuthError("AUTH_UNAVAILABLE", "密码登录暂不可用", 503);
    const target = email(addressInput),
      current = this.resolveHash(ctx.tokenHash);
    if (current?.kind === "ACCOUNT")
      throw new AuthError(
        "ACCOUNT_LOGOUT_REQUIRED",
        "请先明确退出当前账号，再登录",
        409,
      );
    if (current && !confirmSwitchGuest)
      throw new AuthError(
        "GUEST_SWITCH_CONFIRM",
        "本次登录不会合并当前游客记录，请确认或先注册这个游客",
        409,
      );
    const prepared = await this.store.transaction(async (tx) => {
      if (!(await this.loginLimits(tx, target.key, ctx.ip, false)))
        throw new AuthError(
          "AUTH_RATE_LIMITED",
          "登录尝试较多，请稍后重试",
          429,
        );
      return tx.one("SELECT * FROM auth_accounts WHERE email_key=?", [
        target.key,
      ]);
    });
    let valid = false;
    if (prepared)
      valid = await this.passwords.verify(password, prepared.password_hash);
    else await this.passwords.dummy(password);
    return this.operation(
      "LOGIN",
      ctx,
      { email: target.key, password, confirmSwitchGuest, flow: ctx.flowId },
      async (tx, prior, changed, invalidated) => {
        const s = this.resolveHash(ctx.tokenHash);
        if (s?.kind === "ACCOUNT")
          return failed("ACCOUNT_LOGOUT_REQUIRED", "请先退出当前账号", 409);
        if (s) this.hooks.assertReleased(s);
        if (!(await this.loginLimits(tx, target.key, ctx.ip, false)))
          return failed("AUTH_RATE_LIMITED", "登录尝试较多，请稍后重试", 429);
        const a = await tx.one(
          "SELECT * FROM auth_accounts WHERE email_key=?",
          [target.key],
        );
        if (
          !valid ||
          !a ||
          a.password_hash !== prepared?.password_hash ||
          Number(a.auth_version) !== Number(prepared?.auth_version)
        ) {
          await this.loginLimits(tx, target.key, ctx.ip, true);
          return failed("LOGIN_INVALID", "邮箱或密码不正确", 401);
        }
        if (s) {
          await this.revoke(tx, s.userId, invalidated, s.tokenHash);
          changed.add(s.userId);
        }
        if (prior?.data.sessionHash) {
          await tx.query(
            "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?",
            [this.now(), prior.data.sessionHash],
          );
          invalidated.add(prior.data.sessionHash);
        }
        const issued = await this.issueSession(
          tx,
          a.user_id,
          Number(a.auth_version),
          ctx.device,
        );
        changed.add(a.user_id);
        await this.audit(tx, "LOGGED_IN", a.user_id);
        return {
          data: {
            authenticated: true,
            userId: a.user_id,
            sessionHash: issued.hash,
          },
          token: issued.token,
        };
      },
      true,
    ).then((result) => ({
      ...result,
      data: { authenticated: true, userId: result.data.userId },
    }));
  }
  async logout(ctx: AuthContext) {
    return this.operation(
      "LOGOUT",
      ctx,
      {},
      async (tx, _prior, changed, invalidated) => {
        const s = this.requireIdentity(ctx);
        this.hooks.assertReleased(s);
        await this.revoke(tx, s.userId, invalidated, s.tokenHash);
        changed.add(s.userId);
        await this.audit(tx, "LOGGED_OUT", s.userId);
        return { data: { loggedOut: true }, clearCookie: true };
      },
    ).then((r) => ({ ...r, clearCookie: true }));
  }
  async changePassword(
    currentPassword: string,
    password: string,
    confirmation: string,
    ctx: AuthContext,
  ) {
    validatePassword(password, confirmation);
    const s = this.requireIdentity(ctx, "ACCOUNT"),
      prepared = this.accounts.get(s.userId)!;
    const allowed = await this.store.transaction((tx) =>
      this.loginLimits(tx, prepared.emailKey, ctx.ip, false),
    );
    if (!allowed)
      throw new AuthError("AUTH_RATE_LIMITED", "密码尝试较多，请稍后重试", 429);
    const valid = await this.passwords.verify(
        currentPassword,
        prepared.passwordHash,
      ),
      hash = valid ? await this.passwords.hash(password) : "";
    return this.operation(
      "PASSWORD_CHANGE",
      ctx,
      { currentPassword, password, confirmation, flow: ctx.flowId },
      async (tx, _prior, changed, invalidated) => {
        const who = this.requireIdentity(ctx, "ACCOUNT");
        this.hooks.assertReleased(who);
        if (!(await this.loginLimits(tx, prepared.emailKey, ctx.ip, false)))
          return failed("AUTH_RATE_LIMITED", "密码尝试较多，请稍后重试", 429);
        const a = await tx.one("SELECT * FROM auth_accounts WHERE user_id=?", [
          who.userId,
        ]);
        if (!valid || !a || a.password_hash !== prepared.passwordHash) {
          await this.loginLimits(tx, prepared.emailKey, ctx.ip, true);
          return failed("PASSWORD_INVALID", "当前密码不正确", 401);
        }
        await tx.query(
          "UPDATE auth_accounts SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE user_id=?",
          [hash, this.now(), who.userId],
        );
        await this.revoke(tx, who.userId, invalidated);
        await tx.query(
          "UPDATE auth_grants SET state='INVALIDATED' WHERE subject_id=? AND purpose='RESET_PASSWORD' AND state='ACTIVE'",
          [who.userId],
        );
        await tx.query(
          "UPDATE auth_challenges SET state='INVALIDATED' WHERE subject_id=? AND purpose='RESET_PASSWORD' AND state IN ('PENDING','VERIFIED')",
          [who.userId],
        );
        const issued = await this.issueSession(
          tx,
          who.userId,
          Number(a.auth_version) + 1,
          ctx.device,
        );
        changed.add(who.userId);
        await this.audit(tx, "PASSWORD_CHANGED", who.userId);
        return { data: { changed: true }, token: issued.token };
      },
    );
  }
}
