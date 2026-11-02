import { deviceClass } from "../../../shared/social.ts";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AuthService } from "./service.ts";
import {
  AuthError,
  type Identity,
  type AuthContext,
  type AuthReply,
} from "./types.ts";
interface Dependencies {
  app: Express;
  auth: AuthService;
  user: (req: Request) => Identity;
  rawSessionHash: (req: Request) => string | null;
  cookieName: string;
  cookieOptions: () => any;
  release: (req: Request, res: Response) => Promise<unknown>;
  errorData: (error: unknown) => unknown;
}
export function mountAuthRoutes(d: Dependencies) {
  const flow = z.uuid(),
    text = z.string().max(256),
    grant = z.string().min(32).max(256),
    challenge = z.uuid();
  const ctx = (req: Request, flowId: string): AuthContext => ({
    device: deviceClass(req.headers["user-agent"] ?? ""),
    tokenHash: d.rawSessionHash(req),
    flowId,
    ip: req.ip ?? "unknown",
    requestId: z.uuid().parse(req.headers["idempotency-key"]),
  });
  const post = <T>(
    path: string,
    schema: z.ZodType<T>,
    fn: (body: T, req: Request) => Promise<AuthReply>,
  ) => {
    d.app.post("/api/v2/auth/" + path, (req, res) => {
      Promise.resolve()
        .then(() => {
          z.uuid().parse(req.headers["idempotency-key"]);
          return fn(schema.parse(req.body), req);
        })
        .then((result) => {
          if (result.token)
            res.cookie(d.cookieName, result.token, d.cookieOptions());
          if (result.clearCookie) {
            const options = d.cookieOptions();
            delete options.maxAge;
            res.clearCookie(d.cookieName, options);
          }
          res.json({ data: { ...result.data, serverTime: d.auth.now() } });
        })
        .catch((error) => {
          res
            .status(
              error instanceof AuthError
                ? error.status
                : error instanceof z.ZodError
                  ? 400
                  : 503,
            )
            .json({ error: d.errorData(error) });
        });
    });
  };
  for (const [prefix, purpose] of [
    ["register", "REGISTER"],
    ["password-reset", "RESET_PASSWORD"],
  ] as const) {
    post(
      prefix + "/code",
      z.object({ email: z.string().max(254), flowId: flow }).strict(),
      (p, req) => d.auth.requestCode(purpose, p.email, ctx(req, p.flowId)),
    );
    post(
      prefix + "/verify",
      z
        .object({
          challengeId: challenge,
          code: z.string().regex(/^\d{6}$/),
          flowId: flow,
        })
        .strict(),
      (p, req) =>
        d.auth.verify(purpose, p.challengeId, p.code, ctx(req, p.flowId)),
    );
    post(
      prefix + "/complete",
      z
        .object({ grant, password: text, confirmation: text, flowId: flow })
        .strict(),
      (p, req) =>
        d.auth.complete(
          purpose,
          p.grant,
          p.password,
          p.confirmation,
          ctx(req, p.flowId),
        ),
    );
  }
  post(
    "login",
    z
      .object({
        email: z.string().max(254),
        password: text,
        confirmSwitchGuest: z.boolean().default(false),
        flowId: flow,
      })
      .strict(),
    (p, req) =>
      d.auth.login(
        p.email,
        p.password,
        p.confirmSwitchGuest,
        ctx(req, p.flowId),
      ),
  );
  post("logout", z.object({ flowId: flow }).strict(), (p, req) =>
    d.auth.logout(ctx(req, p.flowId)),
  );
  post(
    "password/change",
    z
      .object({
        currentPassword: text,
        password: text,
        confirmation: text,
        flowId: flow,
      })
      .strict(),
    (p, req) =>
      d.auth.changePassword(
        p.currentPassword,
        p.password,
        p.confirmation,
        ctx(req, p.flowId),
      ),
  );
  d.app.post("/api/v2/auth/release-control", (req, res) => {
    Promise.resolve()
      .then(() => {
        z.object({}).strict().parse(req.body);
        return d.release(req, res);
      })
      .catch((error) =>
        res
          .status(error instanceof AuthError ? error.status : 400)
          .json({ error: d.errorData(error) }),
      );
  });
}
