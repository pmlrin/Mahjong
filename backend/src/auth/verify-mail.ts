import nodemailer from "nodemailer";
import { authConfig, mailConfigured } from "./config.ts";
const c = authConfig();
if (!mailConfigured(c))
  throw Error("Mail configuration is incomplete; no SMTP connection attempted");
const transport = nodemailer.createTransport({
  host: c.smtpHost,
  port: 465,
  secure: true,
  auth: { user: c.smtpUser, pass: c.smtpPassword },
  tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 10000,
  logger: false,
  debug: false,
});
try {
  await transport.verify();
  console.log(
    JSON.stringify({
      smtpTLS: true,
      authenticated: true,
      emailSent: false,
      environment: c.environment,
      note: "Authentication only; actual receipt and registration/reset still require end-to-end verification",
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      smtpTLS: true,
      authenticated: false,
      emailSent: false,
      note: "Inspect restricted configuration and provider console; credentials and raw SMTP responses are not logged",
    }),
  );
  process.exitCode = 1;
} finally {
  transport.close();
}
