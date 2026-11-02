import type { Express, Request } from "express";
import express from "express";
import { z } from "zod";
import { AuthError } from "../auth/types.ts";
import type { SocialService, SocialContext } from "./service.ts";
import {
  profileUpdateSchema,
  friendInputSchema,
  friendCodeSchema,
  versionSchema,
  inviteInputSchema,
  deviceRevokeSchema,
  devicesRevokeSchema,
  AVATAR_MAX_UPLOAD_BYTES,
} from "../../../shared/social.ts";
export function mountSocialRoutes(
  app: Express,
  s: SocialService,
  hash: (r: Request) => string | null,
  errorData: (e: unknown) => any,
) {
  const ctx = (r: Request, modify = false): SocialContext => ({
    tokenHash: hash(r),
    ip: r.ip ?? "unknown",
    requestId: modify
      ? z.uuid().parse(r.headers["idempotency-key"])
      : crypto.randomUUID(),
  });
  function route<T>(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    schema: z.ZodType<T>,
    fn: (r: Request, p: T) => Promise<any>,
  ) {
    app[method]("/api/v2" + path, (req, res) => {
      res.set("Cache-Control", "no-store");
      Promise.resolve()
        .then(() => {
          if (method !== "get") z.uuid().parse(req.headers["idempotency-key"]);
          return fn(
            req,
            schema.parse(method === "get" ? req.query : (req.body ?? {})),
          );
        })
        .then((data) => res.json({ data }))
        .catch((e) => {
          const code =
            e instanceof AuthError
              ? e.status
              : e instanceof z.ZodError
                ? 400
                : 503;
          if ((e as any).retryAfter)
            res.set("Retry-After", String((e as any).retryAfter));
          res.status(code).json({
            error: {
              ...errorData(e),
              ...((e as any).retryAfter
                ? { retryAfter: (e as any).retryAfter }
                : {}),
            },
          });
        });
    });
  }
  const empty = z.object({}).strict(),
    page = z.object({ cursor: z.string().max(128).optional() }).strict();
  route("get", "/profile", empty, (r) => s.profile(ctx(r)));
  app.put(
    "/api/v2/profile/avatar",
    express.raw({ type: "image/png", limit: AVATAR_MAX_UPLOAD_BYTES }),
    (req, res) => {
      res.set("Cache-Control", "no-store");
      Promise.resolve()
        .then(() => {
          if (!req.is("image/png") || !Buffer.isBuffer(req.body))
            throw new AuthError(
              "UNSUPPORTED_AVATAR_TYPE",
              "请通过头像裁剪器上传 PNG 图片",
              415,
            );
          return s.uploadAvatar(
            ctx(req, true),
            req.body,
            z.coerce
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER)
              .parse(req.headers["x-profile-version"]),
          );
        })
        .then((data) => res.json({ data }))
        .catch((e) => {
          if ((e as any).retryAfter)
            res.set("Retry-After", String((e as any).retryAfter));
          res
            .status(
              e instanceof AuthError
                ? e.status
                : e instanceof z.ZodError
                  ? 400
                  : 503,
            )
            .json({
              error: {
                ...errorData(e),
                ...((e as any).retryAfter
                  ? { retryAfter: (e as any).retryAfter }
                  : {}),
              },
            });
        });
    },
  );
  app.get("/api/v2/avatars/:avatarId", (req, res) => {
    s.avatarImage(String(req.params.avatarId))
      .then((asset) => {
        res.set({
          "Content-Type": "image/png",
          "Content-Length": String(asset.bytes.length),
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          ETag: '"' + asset.sha256 + '"',
        });
        if (req.headers["if-none-match"] === '"' + asset.sha256 + '"')
          res.status(304).end();
        else res.send(asset.bytes);
      })
      .catch((e) =>
        res
          .status(e instanceof AuthError ? e.status : 503)
          .json({ error: errorData(e) }),
      );
  });
  route("patch", "/profile", profileUpdateSchema, (r, p) =>
    s.updateProfile(ctx(r, true), p),
  );
  route("get", "/auth/sessions", page, (r, p) => s.devices(ctx(r), p.cursor));
  route("post", "/auth/sessions/revoke", deviceRevokeSchema, (r, p) =>
    s.revokeDevices(ctx(r, true), p.currentPassword, p.sessionId, p.flowId),
  );
  route("post", "/auth/sessions/revoke-others", devicesRevokeSchema, (r, p) =>
    s.revokeDevices(ctx(r, true), p.currentPassword, null, p.flowId),
  );
  route("get", "/social/snapshot", empty, (r) => s.snapshot(ctx(r)));
  route(
    "post",
    "/friends/lookup",
    z.object({ friendCode: z.string().max(40) }).strict(),
    (r, p) => s.lookup(ctx(r, true), p.friendCode),
  );
  route("post", "/friend-requests", friendInputSchema, (r, p) =>
    s.sendRequest(ctx(r, true), p.friendCode),
  );
  for (const [path, state] of [
    ["accept", "ACCEPTED"],
    ["reject", "REJECTED"],
    ["cancel", "CANCELED"],
  ] as const)
    route(
      "post",
      "/friend-requests/:requestId/" + path,
      versionSchema,
      (r, p) =>
        s.requestAction(
          ctx(r, true),
          z.uuid().parse(r.params.requestId),
          state,
          p.expectedVersion,
        ),
    );
  route("delete", "/friends/:friendCode", empty, (r) =>
    s.deleteFriend(ctx(r, true), friendCodeSchema.parse(r.params.friendCode)),
  );
  route("get", "/blocks", page, (r, p) => s.blocks(ctx(r), p.cursor));
  route("post", "/blocks", friendInputSchema, (r, p) =>
    s.block(ctx(r, true), p.friendCode),
  );
  route("delete", "/blocks/:friendCode", empty, (r) =>
    s.block(ctx(r, true), friendCodeSchema.parse(r.params.friendCode), true),
  );
  route("post", "/room-invitations", inviteInputSchema, (r, p) =>
    s.invite(ctx(r, true), p),
  );
  for (const [path, state] of [
    ["accept", "JOINED"],
    ["decline", "DECLINED"],
    ["cancel", "CANCELED"],
  ] as const)
    route(
      "post",
      "/room-invitations/:invitationId/" + path,
      versionSchema,
      (r, p) =>
        s.invitationAction(
          ctx(r, true),
          z.uuid().parse(r.params.invitationId),
          state,
          p.expectedVersion,
        ),
    );
}
