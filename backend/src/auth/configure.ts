import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
const file = resolve(
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
      ".env.auth.local",
  ),
  environment = process.argv.includes("--production")
    ? "production"
    : "preview";
if (existsSync(file))
  throw Error("Refusing to overwrite existing authentication configuration");
if (!existsSync(dirname(file)))
  throw Error("Configuration parent directory must exist");
if (process.argv.includes("--server")) {
  if (!file.startsWith("/opt/mahjong/") || !basename(file).endsWith(".env"))
    throw Error(
      "Server configuration must be a new .env file under /opt/mahjong",
    );
} else {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", file], {
      stdio: "ignore",
    });
  } catch {
    throw Error("The actual secret file must match .gitignore before creation");
  }
}
let contents = readFileSync(".env.auth.example", "utf8")
  .replace("MAIL_ENVIRONMENT=preview", "MAIL_ENVIRONMENT=" + environment)
  .replace(
    "OTP_HMAC_SECRET=",
    "OTP_HMAC_SECRET=" + randomBytes(32).toString("base64url"),
  )
  .replace(
    "MAIL_OUTBOX_ENCRYPTION_KEY=",
    "MAIL_OUTBOX_ENCRYPTION_KEY=" + randomBytes(32).toString("base64"),
  );
if (process.env.MAIL_TEST_ALLOWLIST)
  contents = contents.replace(
    "MAIL_TEST_ALLOWLIST=",
    "MAIL_TEST_ALLOWLIST=" +
      process.env.MAIL_TEST_ALLOWLIST.split(",")
        .map((s) => s.trim())
        .join(","),
  );
const budget = process.argv.includes("--server")
  ? "/opt/mahjong/mail-budget/provider.sqlite"
  : resolve(dirname(file), "data/provider-budget.sqlite");
contents = contents.replace(
  "MAIL_SHARED_BUDGET_PATH=",
  "MAIL_SHARED_BUDGET_PATH=" + budget,
);
if (!process.env.SESSION_SECRET)
  contents +=
    "\n# Keep this secret stable across restarts. Existing server SESSION_SECRET should be reused.\nSESSION_SECRET=" +
    randomBytes(32).toString("base64url") +
    "\n";
writeFileSync(file, contents, { mode: 0o600, flag: "wx" });
chmodSync(file, 0o600);
console.log(
  "Created restricted authentication configuration. Fill SMTP_PASSWORD locally; no secrets were printed.",
);
