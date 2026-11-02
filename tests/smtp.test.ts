import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type TLSSocket } from "node:tls";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smtpTransport } from "../backend/src/auth/mail.ts";
import { authConfig } from "../backend/src/auth/config.ts";
test(
  "V3 SMTP TLS: real encrypted socket authenticates, accepts one message; untrusted certificate and bad password are refused",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mj-smtp-tls-")),
      cert = join(dir, "cert.pem"),
      key = join(dir, "key.pem");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const messages: string[] = [],
      sockets = new Set<TLSSocket>();
    let encryptedConnections = 0,
      authenticated = 0;
    const server = createServer(
      {
        key: readFileSync(key),
        cert: readFileSync(cert),
        minVersion: "TLSv1.2",
      },
      (socket) => {
        sockets.add(socket);
        encryptedConnections++;
        socket.on("close", () => sockets.delete(socket));
        let buffer = "",
          data = false,
          authenticatedHere = false;
        socket.write("220 localhost SMTP test\r\n");
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          while (true) {
            if (data) {
              const end = buffer.indexOf("\r\n.\r\n");
              if (end < 0) return;
              messages.push(buffer.slice(0, end));
              buffer = buffer.slice(end + 5);
              data = false;
              socket.write("250 2.0.0 test-message-id\r\n");
              continue;
            }
            const pos = buffer.indexOf("\r\n");
            if (pos < 0) return;
            const line = buffer.slice(0, pos);
            buffer = buffer.slice(pos + 2);
            if (/^EHLO /i.test(line))
              socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
            else if (/^AUTH PLAIN /i.test(line)) {
              const value = Buffer.from(line.slice(11), "base64").toString();
              authenticatedHere =
                value === "\0noreply@notify.yangjm.cn\0test-smtp-password";
              if (authenticatedHere) authenticated++;
              socket.write(
                authenticatedHere
                  ? "235 2.7.0 authenticated\r\n"
                  : "535 5.7.8 rejected\r\n",
              );
            } else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line))
              socket.write(
                authenticatedHere
                  ? "250 2.1.0 OK\r\n"
                  : "530 5.7.0 authentication required\r\n",
              );
            else if (line === "DATA") {
              data = true;
              socket.write("354 End with dot\r\n");
            } else if (line === "QUIT") {
              socket.end("221 bye\r\n");
              return;
            } else socket.write("250 OK\r\n");
          }
        });
      },
    );
    server.on("tlsClientError", () => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const config = {
      ...authConfig({}),
      smtpHost: "127.0.0.1",
      smtpPort: port,
      smtpPassword: "test-smtp-password",
    };
    const message = {
      to: "confirmed@example.com",
      subject: "预览环境 · SMTP 协议测试",
      text: "This is an isolated SMTP protocol test.",
      html: "<p>Isolated test</p>",
    };
    try {
      const untrusted = smtpTransport(config);
      await assert.rejects(untrusted.send(message));
      untrusted.close?.();
      const wrong = smtpTransport(
        { ...config, smtpPassword: "bad-password" },
        readFileSync(cert, "utf8"),
      );
      await assert.rejects(wrong.send(message));
      wrong.close?.();
      const trusted = smtpTransport(config, readFileSync(cert, "utf8"));
      const result = await trusted.send(message);
      assert.equal(result.accepted, true);
      trusted.close?.();
      assert.equal(messages.length, 1);
      assert.equal(authenticated, 1);
      assert(encryptedConnections >= 2);
      assert(!messages[0].includes("test-smtp-password"));
      assert(messages[0].includes("multipart/alternative"));
      writeFileSync(
        "reports/v41-smtp-protocol.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            transport: "Local TLS SMTP server with test CA",
            tls: true,
            certificateValidation: true,
            rejectsUntrustedCertificate: true,
            rejectsWrongPassword: true,
            acceptedMessages: 1,
            realDirectMail: false,
            realQQDelivery: false,
          },
          null,
          2,
        ),
      );
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
