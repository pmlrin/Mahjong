import nodemailer from "nodemailer";
import type { AuthService } from "./service.ts";
import type { AuthConfig } from "./config.ts";
import { mailConfigured } from "./config.ts";
import { ProviderBudget } from "./provider-budget.ts";
import { digest } from "./crypto.ts";
import { unseal, mac } from "./crypto.ts";
interface MailJob {
  job_id: string;
  challenge_id: string;
  purpose: string;
  ciphertext: string;
  masked_recipient: string;
  expires_at: number | string;
  attempts: number;
}
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface MailResult {
  accepted: boolean;
  providerId?: string;
}
export interface MailTransport {
  send: (message: MailMessage) => Promise<MailResult>;
  close?: () => void;
}
export function smtpTransport(
  config: AuthConfig,
  testCA?: string,
): MailTransport {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(testCA ? { ca: testCA } : {}),
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    send: async (message) => {
      const info = await transport.sendMail({
        from: { name: config.fromName, address: config.fromAddress },
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { "X-Mailer": "Ichitaku transactional verification" },
        envelope: { from: config.fromAddress, to: [message.to] },
      });
      return {
        accepted: info.accepted?.length === 1,
        providerId: String(info.messageId ?? "").slice(0, 160),
      };
    },
    close: () => transport.close(),
  };
}
export function mailError(error: unknown): {
  category: string;
  retry: boolean;
} {
  const e = error as { code?: string; responseCode?: number };
  if (e.code === "EAUTH") return { category: "AUTHENTICATION", retry: false };
  if (
    e.code === "ECONFIG" ||
    e.code === "EENVELOPE" ||
    e.code === "ERR_CRYPTO_INVALID_AUTH_TAG"
  )
    return { category: "CONFIGURATION_OR_RECIPIENT", retry: false };
  if (e.responseCode && e.responseCode >= 500)
    return { category: "PERMANENT_REJECTION", retry: false };
  if (e.responseCode && e.responseCode >= 400)
    return { category: "TEMPORARY_REJECTION", retry: true };
  if (
    [
      "ETIMEDOUT",
      "ECONNECTION",
      "ECONNRESET",
      "ECONNREFUSED",
      "ESOCKET",
      "EDNS",
      "EAI_AGAIN",
    ].includes(e.code ?? "")
  )
    return { category: "TEMPORARY_NETWORK", retry: true };
  return { category: "UNCONFIRMED_RESULT", retry: true };
}
export class MailQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private providerBudget: ProviderBudget | null = null;
  constructor(
    readonly auth: AuthService,
    readonly transport: MailTransport = smtpTransport(auth.config),
    readonly audit: (value: Record<string, unknown>) => void = (value) =>
      console.log(JSON.stringify(value)),
  ) {}
  start() {
    if (!mailConfigured(this.auth.config)) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.audit({ event: "MAIL_QUEUE_FAILURE", category: "DATABASE" }),
      );
    }, 500);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopped || this.pending) return this.pending ?? Promise.resolve();
    this.pending = this.process().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async process() {
    const now = this.auth.now(),
      env = this.auth.config.environment;
    const job = await this.auth.store.transaction(async (tx) => {
      await tx.query(
        "UPDATE auth_mail_jobs SET status='EXPIRED',ciphertext=NULL,lease_until=NULL WHERE environment=? AND status IN ('QUEUED','SENDING') AND (expires_at<=? OR challenge_id IN(SELECT challenge_id FROM auth_challenges WHERE state<>'PENDING'))",
        [env, now],
      );
      await tx.query(
        "UPDATE auth_mail_jobs SET status='FAILED',ciphertext=NULL,last_error='ATTEMPTS_EXHAUSTED',lease_until=NULL WHERE environment=? AND status='SENDING' AND lease_until<=? AND attempts>=3",
        [env, now],
      );
      await tx.query(
        "UPDATE auth_mail_jobs SET status='QUEUED',lease_until=NULL,next_attempt_at=? WHERE environment=? AND status='SENDING' AND lease_until<=? AND attempts<3",
        [now, env, now],
      );
      const job = await tx.one(
        "SELECT * FROM auth_mail_jobs WHERE environment=? AND status='QUEUED' AND next_attempt_at<=? ORDER BY created_at,job_id LIMIT 1",
        [env, now],
      );
      if (!job) return null;
      if (!mailConfigured(this.auth.config)) {
        await tx.query(
          "UPDATE auth_mail_jobs SET status='FAILED',ciphertext=NULL,last_error='CONFIGURATION' WHERE job_id=?",
          [job.job_id],
        );
        return null;
      }
      if (this.auth.config.providerBudgetPath) {
        try {
          this.providerBudget ??= new ProviderBudget(
            this.auth.config.providerBudgetPath,
            digest(this.auth.config.smtpUser),
          );
          const reserved = this.providerBudget.reserve(
            now,
            this.auth.config.providerDailyLimit ?? 100,
          );
          if (reserved === "BUSY") {
            await tx.query(
              "UPDATE auth_mail_jobs SET next_attempt_at=? WHERE job_id=?",
              [now + 1000, job.job_id],
            );
            return null;
          }
          if (reserved === "EXHAUSTED") {
            await tx.query(
              "UPDATE auth_mail_jobs SET status='FAILED',ciphertext=NULL,last_error='PROVIDER_DAILY_BUDGET' WHERE job_id=?",
              [job.job_id],
            );
            return null;
          }
        } catch {
          this.auth.mailHealthy = false;
          await tx.query(
            "UPDATE auth_mail_jobs SET status='FAILED',ciphertext=NULL,last_error='BUDGET_CONFIGURATION' WHERE job_id=?",
            [job.job_id],
          );
          return null;
        }
      }
      const key = mac(this.auth.config.requestSecret, env, "smtp-day", "all");
      if (
        !(await this.auth.limit(
          tx,
          key,
          86400000,
          this.auth.config.mailDailyLimit,
          true,
        ))
      ) {
        await tx.query(
          "UPDATE auth_mail_jobs SET status='FAILED',ciphertext=NULL,last_error='DAILY_BUDGET' WHERE job_id=?",
          [job.job_id],
        );
        return null;
      }
      await tx.query(
        "UPDATE auth_mail_jobs SET status='SENDING',attempts=attempts+1,lease_until=? WHERE job_id=? AND status='QUEUED'",
        [now + 60000, job.job_id],
      );
      return { ...job, attempts: Number(job.attempts) + 1 } as MailJob;
    });
    if (!job) return;
    let result: MailResult | undefined,
      failure: { category: string; retry: boolean } | undefined;
    try {
      const aad = [env, job.challenge_id, job.purpose, job.job_id].join(":");
      let message: MailMessage;
      try {
        message = unseal<MailMessage>(
          this.auth.config.encryptionKey,
          job.ciphertext,
          aad,
        );
      } catch {
        throw Object.assign(new Error("Outbox encryption configuration"), {
          code: "ECONFIG",
        });
      }
      // Recheck the configured allowlist even for jobs persisted under an earlier configuration.
      if (
        env === "preview" &&
        !this.auth.config.allowlist.has(message.to.toLowerCase())
      )
        failure = { category: "PREVIEW_ALLOWLIST", retry: false };
      else result = await this.transport.send(message);
      if (result && !result.accepted)
        failure = { category: "PERMANENT_REJECTION", retry: false };
    } catch (error) {
      failure = mailError(error);
    }
    const finalNow = this.auth.now();
    const next = finalNow + (job.attempts === 1 ? 5000 : 15000),
      retry =
        !!failure?.retry && job.attempts < 3 && next < Number(job.expires_at);
    await this.auth.store.transaction(async (tx) => {
      const current = await tx.one(
        "SELECT state,expires_at FROM auth_challenges WHERE challenge_id=?",
        [job.challenge_id],
      );
      const expired =
        !current ||
        current.state !== "PENDING" ||
        Number(current.expires_at) <= finalNow;
      const status = expired
        ? "EXPIRED"
        : failure
          ? retry
            ? "QUEUED"
            : "FAILED"
          : "ACCEPTED";
      await tx.query(
        "UPDATE auth_mail_jobs SET status=?,ciphertext=CASE WHEN ?=1 THEN ciphertext ELSE NULL END,next_attempt_at=?,lease_until=NULL,last_error=?,provider_id=? WHERE job_id=?",
        [
          status,
          status === "QUEUED" ? 1 : 0,
          next,
          failure?.category ?? null,
          result?.providerId ?? null,
          job.job_id,
        ],
      );
      await tx.query(
        "INSERT INTO auth_audit(audit_id,event,subject_id,environment,at,details) VALUES(?,?,?,?,?,?)",
        [
          crypto.randomUUID(),
          "MAIL_" + status,
          null,
          env,
          finalNow,
          JSON.stringify({
            jobId: job.job_id,
            purpose: job.purpose,
            recipient: job.masked_recipient,
            attempts: job.attempts,
            error: failure?.category ?? null,
          }),
        ],
      );
      this.audit({
        event: "MAIL_" + status,
        jobId: job.job_id,
        environment: env,
        purpose: job.purpose,
        recipient: job.masked_recipient,
        attempts: job.attempts,
        error: failure?.category ?? null,
      });
    });
    if (
      failure &&
      ["AUTHENTICATION", "CONFIGURATION_OR_RECIPIENT"].includes(
        failure.category,
      )
    )
      this.auth.mailHealthy = false;
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    this.transport.close?.();
    this.providerBudget?.close();
  }
}
