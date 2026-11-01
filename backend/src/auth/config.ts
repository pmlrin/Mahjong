import { resolve, dirname } from "node:path";
export interface AuthConfig {
  enabled: boolean;
  emailEnabled: boolean;
  environment: "preview" | "production";
  requestSecret: string;
  otpSecret: string;
  encryptionKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromAddress: string;
  applicationURL: string;
  allowlist: Set<string>;
  mailDailyLimit: number;
  passwordConcurrency: number;
  providerBudgetPath?: string;
  providerDailyLimit?: number;
}
export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const preview =
    env.MAIL_ENVIRONMENT === "preview" ||
    (env.MAIL_ENVIRONMENT !== "production" &&
      env.SESSION_COOKIE_PATH === "/preview");
  return {
    enabled: env.AUTH_ENABLED === "true" || env.AUTH_ENABLED === "1",
    emailEnabled:
      env.EMAIL_VERIFICATION_ENABLED === "true" ||
      env.EMAIL_VERIFICATION_ENABLED === "1",
    environment: preview ? "preview" : "production",
    requestSecret: env.SESSION_SECRET ?? "",
    otpSecret: env.OTP_HMAC_SECRET ?? "",
    encryptionKey: env.MAIL_OUTBOX_ENCRYPTION_KEY ?? "",
    smtpHost: env.SMTP_HOST ?? "smtpdm.aliyun.com",
    smtpPort: Number(env.SMTP_PORT ?? 465),
    smtpSecure:
      env.SMTP_SECURE === undefined ||
      env.SMTP_SECURE === "true" ||
      env.SMTP_SECURE === "1",
    smtpUser: env.SMTP_USER ?? "noreply@notify.yangjm.cn",
    smtpPassword: env.SMTP_PASSWORD ?? "",
    fromName: env.MAIL_FROM_NAME ?? "一桌麻将",
    fromAddress: env.MAIL_FROM_ADDRESS ?? "noreply@notify.yangjm.cn",
    applicationURL:
      (env.PUBLIC_ORIGIN ?? "http://127.0.0.1:3000") +
      (preview ? "/preview/" : "/"),
    allowlist: new Set(
      (env.MAIL_TEST_ALLOWLIST ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    mailDailyLimit: Math.min(
      10000,
      Math.max(1, Number(env.MAIL_DAILY_ATTEMPT_LIMIT ?? 100) || 100),
    ),
    passwordConcurrency: 2,
    providerBudgetPath:
      env.MAIL_SHARED_BUDGET_PATH ??
      (env.NODE_ENV === "production"
        ? "/opt/mahjong/mail-budget/provider.sqlite"
        : resolve(
            dirname(env.SQLITE_PATH ?? "data/mahjong.sqlite"),
            "provider-budget.sqlite",
          )),
    providerDailyLimit: Math.min(
      10000,
      Math.max(1, Number(env.MAIL_PROVIDER_DAILY_ATTEMPT_LIMIT ?? 100) || 100),
    ),
  };
}
export function mailConfigured(c: AuthConfig) {
  return (
    c.enabled &&
    c.emailEnabled &&
    c.requestSecret.length >= 32 &&
    c.otpSecret.length >= 32 &&
    c.otpSecret !== c.requestSecret &&
    c.encryptionKey !== c.otpSecret &&
    c.encryptionKey !== c.requestSecret &&
    Buffer.from(c.encryptionKey, "base64").length === 32 &&
    c.smtpHost === "smtpdm.aliyun.com" &&
    c.smtpPort === 465 &&
    c.smtpSecure &&
    !!c.smtpPassword &&
    c.smtpUser === "noreply@notify.yangjm.cn" &&
    c.fromAddress === c.smtpUser &&
    (c.environment !== "preview" || c.allowlist.size > 0)
  );
}
