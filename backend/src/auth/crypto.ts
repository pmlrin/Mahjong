import {
  argon2,
  randomBytes,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { AuthError } from "./types.ts";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const mac = (key: string, ...fields: unknown[]) =>
  createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
export const opaque = () => randomBytes(32).toString("base64url");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function email(value: string) {
  const address = value.trim();
  if (
    address.length > 254 ||
    !/^[\x21-\x7e]+$/.test(address) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      address,
    ) ||
    address.split("@")[0].length > 64 ||
    address.split("@")[0].startsWith(".") ||
    address.split("@")[0].endsWith(".") ||
    address.includes("..")
  )
    throw new AuthError("INVALID_EMAIL", "请输入常见格式的邮箱地址");
  return { address, key: address.toLowerCase() };
}
export function validatePassword(password: string, confirmation: string) {
  const length = Array.from(password).length;
  if (length < 12 || length > 128)
    throw new AuthError(
      "INVALID_PASSWORD",
      "密码须为 12～128 个字符，空格也会保留",
    );
  if (password !== confirmation)
    throw new AuthError("PASSWORD_MISMATCH", "两次输入的密码不一致");
}
export function seal(key: string, payload: unknown, aad: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  cipher.setAAD(Buffer.from(aad));
  const value = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), value]).toString("base64");
}
export function unseal<T>(key: string, value: string, aad: string): T {
  const b = Buffer.from(value, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      b.subarray(0, 12),
    );
  cipher.setAuthTag(b.subarray(12, 28));
  cipher.setAAD(Buffer.from(aad));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
  );
}
export class Passwords {
  active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    readonly concurrency = 2,
    readonly queueLimit = 32,
  ) {}
  private async run<T>(fn: () => Promise<T>) {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.queueLimit)
        throw new AuthError("AUTH_BUSY", "登录请求较多，请稍后重试", 429);
      await new Promise<void>((r) => this.waiting.push(r));
    } else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  private derive(
    password: string,
    salt: Buffer,
    memory = 19456,
    passes = 2,
    parallelism = 1,
  ) {
    return this.run(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          argon2(
            "argon2id",
            {
              message: Buffer.from(password, "utf8"),
              nonce: salt,
              memory,
              passes,
              parallelism,
              tagLength: 32,
            },
            (error, result) => (error ? reject(error) : resolve(result)),
          );
        }),
    );
  }
  async hash(password: string) {
    const salt = randomBytes(16),
      tag = await this.derive(password, salt);
    return `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString("base64").replace(/=+$/, "")}$${tag.toString("base64").replace(/=+$/, "")}`;
  }
  async verify(password: string, encoded: string) {
    const match =
      /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
        encoded,
      );
    if (!match) return false;
    const [, m, t, p, salt, expected] = match;
    const memory = Number(m),
      passes = Number(t),
      parallelism = Number(p);
    if (
      memory < 19456 ||
      memory > 65536 ||
      passes < 2 ||
      passes > 6 ||
      parallelism !== 1
    )
      return false;
    const actual = await this.derive(
      password,
      Buffer.from(salt, "base64"),
      memory,
      passes,
      parallelism,
    );
    const tag = Buffer.from(expected, "base64");
    return tag.length === actual.length && timingSafeEqual(tag, actual);
  }
  async dummy(password: string) {
    await this.derive(password, Buffer.from("auth-dummy-salt-v3"));
  }
}
export const maskEmail = (address: string) => {
  const [local, domain] = address.split("@");
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
};
