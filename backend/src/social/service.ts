import { randomUUID, createHash } from "node:crypto";
import { normalizeAvatar } from "./avatar-image.ts";
import type { Store } from "../store.ts";
import type { Sql } from "../sql.ts";
import { AuthService } from "../auth/service.ts";
import { AuthError, type Identity } from "../auth/types.ts";
import { mac } from "../auth/crypto.ts";
import {
  AVATARS,
  DEFAULT_AVATAR,
  friendCodeSchema,
  profileUpdateSchema,
  uploadedAvatarSchema,
  type SocialCapabilities,
  type SocialProfile,
  type SocialSnapshot,
  type PresenceStatus,
  type FriendRequest,
  type RoomInvitation,
} from "../../../shared/social.ts";
import type { Room, Member } from "../../../shared/types.ts";
const MIN = 60000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const pair = (a: string, b: string) => [a, b].sort().join(":");
function error(code: string, message: string, status = 409): never {
  throw new AuthError(code, message, status);
}
const parseJSON = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
const canonical = (v: any): string =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? "[" + v.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}"
    : JSON.stringify(v);
export interface SocialContext {
  tokenHash: string | null;
  requestId: string;
  ip: string;
}
interface Hooks {
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  roomChanged: (room: Room) => void;
  reloadRooms: () => Promise<void>;
  connected: (userId: string) => boolean;
  notify: (
    userId: string,
    data: {
      revision: number;
      categories: string[];
      presenceEpoch: string;
      presenceSeq: number;
    },
  ) => void;
}
interface Work {
  changed: Set<string>;
  rooms: Room[];
  authChanged: boolean;
}
type Reply = {
  data?: any;
  error?: {
    code: string;
    message: string;
    status: number;
    retryAfter?: number;
  };
};
export class SocialService {
  readonly presenceEpoch = randomUUID();
  presenceSeq = 0;
  private connections = new Map<string, { userId: string; hash: string }>();
  private grace = new Map<string, { until: number; hashes: string[] }>();
  private touches = new Map<string, number>();
  private roomNotifications = new Set<string>();
  readonly limits = {
    friends: 200,
    pendingRequests: 50,
    pendingInvitations: 20,
    blocks: 500,
    profileWrites: 10,
    lookupMinute: 20,
    lookupDay: 200,
    lookupIpMinute: 100,
    requestHour: 10,
    requestDay: 30,
    inviteHour: 30,
    stateMinute: 60,
    passwordAccount: 5,
    passwordIp: 20,
  };
  constructor(
    readonly store: Store,
    readonly auth: AuthService,
    readonly hooks: Hooks,
    readonly now = Date.now,
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const k of Object.keys(this.limits) as (keyof typeof this.limits)[]) {
      const n = Number(
        env[
          "SOCIAL_LIMIT_" + k.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase()
        ],
      );
      if (Number.isInteger(n) && n > 0)
        this.limits[k] = Math.min(n, this.limits[k]);
    }
  }
  capabilities(): SocialCapabilities {
    const on = (k: string) => this.env[k] !== "false" && this.env[k] !== "0";
    return {
      profileEditing: on("PROFILE_EDITING_ENABLED"),
      sessionManagement: on("SESSION_MANAGEMENT_ENABLED"),
      friends: on("FRIENDS_ENABLED"),
      friendInvitations:
        on("FRIENDS_ENABLED") && on("FRIEND_INVITATIONS_ENABLED"),
      socialSchemaVersion: 1,
      limits: { ...this.limits },
    };
  }
  private enabled(name: keyof SocialCapabilities) {
    if (!this.capabilities()[name])
      error("FEATURE_DISABLED", "暂不可用", 503);
  }
  private async actor(tx: Sql, ctx: Pick<SocialContext, "tokenHash">) {
    const identity = this.auth.resolveHash(ctx.tokenHash);
    if (!identity) error("UNAUTHENTICATED", "登录状态已失效，请重新登录", 401);
    if (identity.kind !== "ACCOUNT")
      error("ACCOUNT_REQUIRED", "请先注册或登录账号", 403);
    const row = await tx.one(
      "SELECT s.user_id FROM auth_sessions s JOIN auth_accounts a ON a.user_id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.auth_version=a.auth_version AND s.environment=?",
      [ctx.tokenHash, this.now(), this.auth.config.environment],
    );
    if (!row) error("UNAUTHENTICATED", "登录状态已失效，请重新登录", 401);
    return identity;
  }
  private async room(tx: Sql, id: string): Promise<Room | null> {
    const r = await tx.one(
      "SELECT payload FROM documents WHERE kind='room' AND id=?",
      [id],
    );
    return r ? parseJSON(r.payload) : null;
  }
  private async occupied(tx: Sql, userId: string): Promise<Room | null> {
    for (const row of await tx.rows(
      "SELECT payload FROM documents WHERE kind='room' AND CAST(payload AS TEXT) LIKE ?",
      ["%" + userId + "%"],
    )) {
      const r: Room = parseJSON(row.payload);
      if (
        ["WAITING", "PLAYING"].includes(r.status) &&
        r.slots.some((m) => m?.userId === userId)
      )
        return r;
    }
    return null;
  }
  private async blocked(tx: Sql, a: string, b: string) {
    return !!(await tx.one(
      "SELECT blocker_id FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)",
      [a, b, b, a],
    ));
  }
  private async friends(tx: Sql, a: string, b: string) {
    return (
      a !== b &&
      !(await this.blocked(tx, a, b)) &&
      !!(await tx.one("SELECT pair_key FROM friendships WHERE pair_key=?", [
        pair(a, b),
      ]))
    );
  }
  private async person(tx: Sql, userId: string) {
    const p = await tx.one(
      "SELECT p.friend_code,p.avatar_id,u.display_name FROM social_profiles p JOIN auth_users u ON u.user_id=p.user_id WHERE p.user_id=?",
      [userId],
    );
    if (!p) return error("NOT_FOUND", "未找到可添加的账号", 404);
    return {
      friendCode: p.friend_code,
      displayName: p.display_name,
      avatarId: p.avatar_id,
    };
  }
  private async target(
    tx: Sql,
    code: string,
    actor: string,
    allowBlocked = false,
  ) {
    const r = await tx.one(
      "SELECT user_id FROM social_profiles WHERE friend_code=?",
      [
        (() => {
          const parsed = friendCodeSchema.safeParse(code);
          if (!parsed.success)
            error("INVALID_FRIEND_CODE", "请输入完整的 12 位好友码", 400);
          return parsed.data;
        })(),
      ],
    );
    if (!r || (!allowBlocked && (await this.blocked(tx, actor, r.user_id))))
      return error("NOT_FOUND", "未找到可添加的账号", 404);
    return String(r.user_id);
  }
  private async limit(
    tx: Sql,
    key: string,
    window: number,
    max: number,
    increment = true,
  ) {
    const bucket = mac(
      this.auth.config.requestSecret,
      this.auth.config.environment,
      "social-limit",
      key,
    );
    const r = await tx.one(
      "SELECT COUNT(*) AS n,MIN(at) AS first FROM social_limits WHERE bucket=? AND at>?",
      [bucket, this.now() - window],
    );
    if (Number(r?.n) >= max) {
      const e = new AuthError(
        "SOCIAL_RATE_LIMITED",
        "操作较多，请稍后重试",
        429,
      );
      Object.assign(e, {
        retryAfter: Math.max(
          1,
          Math.ceil((Number(r!.first) + window - this.now()) / 1000),
        ),
      });
      throw e;
    }
    if (increment)
      await tx.query(
        "INSERT INTO social_limits(bucket,entry_id,at) VALUES(?,?,?)",
        [bucket, randomUUID(), this.now()],
      );
  }
  private async count(
    tx: Sql,
    table: string,
    userId: string,
    col = "sender_id",
  ) {
    const r = await tx.one(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${col}=? AND state='PENDING'`,
      [userId],
    );
    return Number(r?.n ?? 0);
  }
  private async friendCount(tx: Sql, id: string) {
    return Number(
      (
        await tx.one(
          "SELECT COUNT(*) AS n FROM friendships WHERE low_id=? OR high_id=?",
          [id, id],
        )
      )?.n ?? 0,
    );
  }
  private async cooldown(tx: Sql, key: string, until?: number) {
    if (until !== undefined) {
      await tx.query(
        "INSERT INTO social_cooldowns(scope,until_at) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET until_at=excluded.until_at",
        [key, until],
      );
      return;
    }
    const r = await tx.one(
      "SELECT until_at FROM social_cooldowns WHERE scope=?",
      [key],
    );
    if (r && Number(r.until_at) > this.now())
      error("SOCIAL_COOLDOWN", "请过一会儿再试");
  }
  private async finish(
    tx: Sql,
    table: string,
    column: string,
    id: string,
    state: string,
    work: Work,
  ) {
    const row = await tx.one(`SELECT * FROM ${table} WHERE ${column}=?`, [id]);
    if (!row || row.state !== "PENDING") return;
    await tx.query(
      `UPDATE ${table} SET state=?,version=version+1 WHERE ${column}=?`,
      [state, id],
    );
    work.changed.add(row.sender_id);
    work.changed.add(row.recipient_id);
  }
  private async expire(tx: Sql, work: Work, userId: string) {
    for (const [table, column] of [
      ["friend_requests", "request_id"],
      ["room_invitations", "invitation_id"],
    ])
      for (const r of await tx.rows(
        `SELECT ${column} FROM ${table} WHERE state='PENDING' AND expires_at<=? AND (sender_id=? OR recipient_id=?) LIMIT 100`,
        [this.now(), userId, userId],
      ))
        await this.finish(tx, table, column, r[column], "EXPIRED", work);
  }
  async reconcileRoom(tx: Sql, room: Room) {
    const work: Work = { changed: new Set(), rooms: [], authChanged: false };
    for (const i of await tx.rows(
      "SELECT * FROM room_invitations WHERE room_id=? AND state='PENDING'",
      [room.roomId],
    ))
      if (
        room.status !== "WAITING" ||
        room.hostUserId !== i.sender_id ||
        room.lobbyGeneration !== Number(i.lobby_generation) ||
        !room.slots.some((m) => m?.userId === i.sender_id)
      )
        await this.finish(
          tx,
          "room_invitations",
          "invitation_id",
          i.invitation_id,
          "INVALIDATED",
          work,
        );
    for (const user of work.changed) {
      await this.bump(tx, user);
      this.roomNotifications.add(user);
    }
  }
  private async bump(tx: Sql, id: string) {
    await tx.query(
      "UPDATE social_user_state SET revision=revision+1 WHERE user_id=?",
      [id],
    );
  }
  private failure(e: AuthError): Reply {
    return {
      error: {
        code: e.code,
        message: e.message,
        status: e.status,
        ...((e as any).retryAfter ? { retryAfter: (e as any).retryAfter } : {}),
      },
    };
  }
  private unwrap(r: Reply) {
    if (r.error) {
      const e = new AuthError(r.error.code, r.error.message, r.error.status);
      Object.assign(e, { retryAfter: r.error.retryAfter });
      throw e;
    }
    return r.data;
  }
  async publish(userIds?: Iterable<string>, category = "DATA") {
    const ids = userIds
      ? [...new Set(userIds)]
      : [...new Set([...this.connections.values()].map((c) => c.userId))];
    for (const id of ids)
      try {
        const row = await this.store.transaction((tx) =>
          tx.one("SELECT revision FROM social_user_state WHERE user_id=?", [
            id,
          ]),
        );
        if (row)
          this.hooks.notify(id, {
            revision: Number(row.revision),
            categories: [category],
            presenceEpoch: this.presenceEpoch,
            presenceSeq: this.presenceSeq,
          });
      } catch {
        /* snapshots recover notification failure */
      }
  }
  private scope(ctx: SocialContext, name: string, user: string) {
    return mac(
      this.auth.config.requestSecret,
      this.auth.config.environment,
      name,
      user,
      name.startsWith("DEVICE_") ? ctx.tokenHash : "",
    );
  }
  private hash(name: string, payload: unknown) {
    return mac(
      this.auth.config.requestSecret,
      this.auth.config.environment,
      name,
      canonical(payload),
    );
  }
  async mutate(
    ctx: SocialContext,
    name: string,
    payload: unknown,
    fn: (tx: Sql, s: Identity, w: Work) => Promise<any>,
  ) {
    return this.hooks.serialize(async () => {
      const work: Work = { changed: new Set(), rooms: [], authChanged: false };
      let result: Reply;
      try {
        result = await this.store.transaction(async (tx) => {
          const s = await this.actor(tx, ctx),
            scope = this.scope(ctx, name, s.userId),
            hash = this.hash(name, payload);
          const prior = await tx.one(
            "SELECT payload_hmac,result FROM social_receipts WHERE scope=? AND request_id=?",
            [scope, ctx.requestId],
          );
          if (prior) {
            if (prior.payload_hmac !== hash)
              return this.failure(
                new AuthError(
                  "REQUEST_ID_CONFLICT",
                  "这项操作已经提交过了",
                  409,
                ),
              );
            return parseJSON(prior.result);
          }
          await this.expire(tx, work, s.userId);
          let reply: Reply;
          try {
            if (name === "LOOKUP") {
              this.enabled("friends");
              await this.limit(
                tx,
                "lookup-minute:" + s.userId,
                MIN,
                this.limits.lookupMinute,
              );
              await this.limit(
                tx,
                "lookup-day:" + s.userId,
                DAY,
                this.limits.lookupDay,
              );
              await this.limit(
                tx,
                "lookup-ip:" + ctx.ip,
                MIN,
                this.limits.lookupIpMinute,
              );
            } else if (name === "PROFILE_UPDATE" || name === "AVATAR_UPLOAD") {
              this.enabled("profileEditing");
              await this.limit(
                tx,
                "profile:" + s.userId,
                HOUR,
                this.limits.profileWrites,
              );
            } else if (!name.startsWith("DEVICE_")) {
              this.enabled(
                name.startsWith("INVITE_") ? "friendInvitations" : "friends",
              );
              if (!["REQUEST_SEND", "INVITE_SEND"].includes(name))
                await this.limit(
                  tx,
                  "state:" + s.userId,
                  MIN,
                  this.limits.stateMinute,
                );
            } else this.enabled("sessionManagement");
            const before = new Set(work.changed);
            await tx.query("SAVEPOINT social_action");
            try {
              const data = await fn(tx, s, work);
              reply = data?.error ? data : { data };
              await tx.query("RELEASE SAVEPOINT social_action");
            } catch (e) {
              await tx.query("ROLLBACK TO SAVEPOINT social_action");
              await tx.query("RELEASE SAVEPOINT social_action");
              work.changed = before;
              work.rooms = [];
              work.authChanged = false;
              if (e instanceof AuthError) reply = this.failure(e);
              else throw e;
            }
          } catch (e) {
            if (e instanceof AuthError) reply = this.failure(e);
            else throw e;
          }
          for (const id of work.changed) await this.bump(tx, id);
          await tx.query(
            "INSERT INTO social_receipts(scope,request_id,payload_hmac,result,created_at) VALUES(?,?,?,?,?)",
            [scope, ctx.requestId, hash, JSON.stringify(reply), this.now()],
          );
          await tx.query(
            "INSERT INTO social_audit(audit_id,event,actor_id,subject_id,at,result) VALUES(?,?,?,NULL,?,?)",
            [
              randomUUID(),
              name,
              s.userId,
              this.now(),
              reply.error?.code ?? "OK",
            ],
          );
          return reply;
        });
      } catch (e) {
        await this.auth.reloadAfterFailure();
        await this.hooks.reloadRooms();
        throw e;
      }
      if (work.authChanged) await this.auth.reloadAfterFailure();
      for (const r of work.rooms) this.hooks.roomChanged(r);
      if (work.changed.size) void this.publish(work.changed);
      return this.unwrap(result);
    });
  }
  async profile(ctx: SocialContext): Promise<SocialProfile> {
    return this.store.transaction(async (tx) => {
      const s = await this.actor(tx, ctx);
      const p = await tx.one("SELECT * FROM social_profiles WHERE user_id=?", [
        s.userId,
      ]);
      return {
        ...(await this.person(tx, s.userId)),
        profileVersion: Number(p!.profile_version),
        lastNicknameChangedAt:
          p!.last_nickname_changed_at === null
            ? null
            : Number(p!.last_nickname_changed_at),
        avatars: AVATARS,
        serverTime: this.now(),
      };
    });
  }
  async updateProfile(ctx: SocialContext, input: unknown) {
    const p = profileUpdateSchema.parse(input);
    return this.mutate(ctx, "PROFILE_UPDATE", p, (tx, s, w) =>
      this.writeProfile(tx, s, w, p),
    );
  }
  async uploadAvatar(
    ctx: SocialContext,
    input: Buffer,
    expectedProfileVersion: number,
  ) {
    const digest = createHash("sha256").update(input).digest("hex");
    return this.mutate(
      ctx,
      "AVATAR_UPLOAD",
      { digest, expectedProfileVersion },
      async (tx, s, w) => {
        this.enabled("profileEditing");
        if (await this.occupied(tx, s.userId))
          error(
            "PROFILE_CHANGE_IN_ROOM",
            "在房间或对局中时，暂不能换头像",
          );
        const old = await tx.one(
          "SELECT p.profile_version,u.display_name FROM social_profiles p JOIN auth_users u ON u.user_id=p.user_id WHERE p.user_id=?",
          [s.userId],
        );
        if (Number(old!.profile_version) !== expectedProfileVersion)
          error(
            "PROFILE_VERSION_CONFLICT",
            "资料已在其他设备修改，请刷新后重试",
          );
        await this.limit(tx, "avatar-hour:" + s.userId, HOUR, 5);
        await this.limit(tx, "avatar-day:" + s.userId, DAY, 20);
        const clean = normalizeAvatar(input),
          sha = createHash("sha256").update(clean).digest("hex");
        let asset = await tx.one(
          "SELECT avatar_id FROM avatar_assets WHERE user_id=? AND sha256=?",
          [s.userId, sha],
        );
        if (!asset) {
          const unused = await tx.rows(
            "SELECT a.avatar_id FROM avatar_assets a WHERE a.user_id=? AND a.created_at<? AND NOT EXISTS(SELECT 1 FROM social_profiles p WHERE p.avatar_id=a.avatar_id) AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.kind IN ('room','match') AND CAST(d.payload AS TEXT) LIKE '%' || a.avatar_id || '%') ORDER BY a.created_at LIMIT 8",
            [s.userId, this.now() - 7 * DAY],
          );
          for (const a of unused)
            await tx.query("DELETE FROM avatar_assets WHERE avatar_id=?", [
              a.avatar_id,
            ]);
          if (
            Number(
              (await tx.one(
                "SELECT COUNT(*) AS n FROM avatar_assets WHERE user_id=?",
                [s.userId],
              ))!.n,
            ) >= 64
          )
            error(
              "AVATAR_STORAGE_LIMIT",
              "已保存的头像达到上限，请先使用预设头像",
            );
          const id = "upload_" + randomUUID();
          await tx.query(
            "INSERT INTO avatar_assets(avatar_id,user_id,sha256,png_base64,created_at) VALUES(?,?,?,?,?)",
            [id, s.userId, sha, clean.toString("base64"), this.now()],
          );
          asset = { avatar_id: id };
        }
        const result = await this.writeProfile(tx, s, w, {
          displayName: old!.display_name,
          avatarId: asset.avatar_id,
          expectedProfileVersion,
        });
        return { ...result, avatarId: asset.avatar_id };
      },
    );
  }
  async avatarImage(id: string) {
    if (!uploadedAvatarSchema.safeParse(id).success)
      error("NOT_FOUND", "头像不存在", 404);
    const row = await this.store.transaction((tx) =>
      tx.one("SELECT png_base64,sha256 FROM avatar_assets WHERE avatar_id=?", [
        id,
      ]),
    );
    if (!row) error("NOT_FOUND", "头像不存在", 404);
    return {
      bytes: Buffer.from(row.png_base64, "base64"),
      sha256: String(row.sha256),
    };
  }
  private async writeProfile(
    tx: Sql,
    s: Identity,
    w: Work,
    p: {
      displayName: string;
      avatarId: string;
      expectedProfileVersion: number;
    },
  ) {
    if (await this.occupied(tx, s.userId))
      error(
        "PROFILE_CHANGE_IN_ROOM",
        "在房间或对局中时，暂不能改资料",
      );
    const old = await tx.one(
      "SELECT p.*,u.display_name FROM social_profiles p JOIN auth_users u ON u.user_id=p.user_id WHERE p.user_id=?",
      [s.userId],
    );
    if (Number(old!.profile_version) !== p.expectedProfileVersion)
      error("PROFILE_VERSION_CONFLICT", "资料已在其他设备修改，请刷新后重试");
    if (
      uploadedAvatarSchema.safeParse(p.avatarId).success &&
      !(await tx.one(
        "SELECT avatar_id FROM avatar_assets WHERE avatar_id=? AND user_id=?",
        [p.avatarId, s.userId],
      ))
    )
      error("INVALID_AVATAR", "只能使用本人上传的头像", 400);
    if (old!.display_name === p.displayName && old!.avatar_id === p.avatarId)
      return { updated: true, profileVersion: Number(old!.profile_version) };
    const renamed = old!.display_name !== p.displayName;
    if (
      renamed &&
      old!.last_nickname_changed_at !== null &&
      this.now() - Number(old!.last_nickname_changed_at) < DAY
    )
      error("NICKNAME_COOLDOWN", "名字每 24 小时只能改一次");
    await tx.query("UPDATE auth_users SET display_name=? WHERE user_id=?", [
      p.displayName,
      s.userId,
    ]);
    await tx.query(
      "UPDATE social_profiles SET avatar_id=?,profile_version=profile_version+1,last_nickname_changed_at=? WHERE user_id=?",
      [
        p.avatarId,
        renamed ? this.now() : old!.last_nickname_changed_at,
        s.userId,
      ],
    );
    w.authChanged = true;
    w.changed.add(s.userId);
    for (const r of await tx.rows(
      "SELECT low_id,high_id FROM friendships WHERE low_id=? OR high_id=?",
      [s.userId, s.userId],
    ))
      w.changed.add(r.low_id === s.userId ? r.high_id : r.low_id);
    for (const r of await tx.rows(
      "SELECT sender_id,recipient_id FROM friend_requests WHERE state='PENDING' AND (sender_id=? OR recipient_id=?)",
      [s.userId, s.userId],
    )) {
      if (!(await this.blocked(tx, r.sender_id, r.recipient_id))) {
        w.changed.add(r.sender_id);
        w.changed.add(r.recipient_id);
      }
    }
    return {
      updated: true,
      profileVersion: Number(old!.profile_version) + 1,
    };
  }
  async lookup(ctx: SocialContext, code: string) {
    return this.mutate(ctx, "LOOKUP", { friendCode: code }, async (tx, s) => {
      const id = await this.target(tx, code, s.userId);
      let relationship =
        id === s.userId
          ? "SELF"
          : (await this.friends(tx, s.userId, id))
            ? "FRIEND"
            : "NONE";
      if (relationship === "NONE") {
        const r = await tx.one(
          "SELECT sender_id FROM friend_requests WHERE pair_key=? AND state='PENDING'",
          [pair(s.userId, id)],
        );
        if (r)
          relationship = r.sender_id === s.userId ? "OUTGOING" : "INCOMING";
      }
      return { ...(await this.person(tx, id)), relationship };
    });
  }
  async sendRequest(ctx: SocialContext, code: string) {
    return this.mutate(
      ctx,
      "REQUEST_SEND",
      { friendCode: code },
      async (tx, s, w) => {
        const other = await this.target(tx, code, s.userId);
        await this.expire(tx, w, other);
        if (other === s.userId) error("SELF_NOT_ALLOWED", "这是你的账号");
        const key = pair(s.userId, other);
        if (await this.friends(tx, s.userId, other))
          return { alreadyFriends: true };
        const existing = await tx.one(
          "SELECT * FROM friend_requests WHERE pair_key=? AND state='PENDING'",
          [key],
        );
        if (existing) {
          // Both sides want it: adding someone who already asked you accepts their request.
          if (existing.recipient_id === s.userId) {
            await this.acceptPending(tx, existing, w);
            return {
              requestId: existing.request_id,
              state: "ACCEPTED",
              becameFriends: true,
              version: Number(existing.version) + 1,
            };
          }
          return {
            requestId: existing.request_id,
            state: "PENDING",
            incoming: false,
            version: Number(existing.version),
          };
        }
        await this.cooldown(tx, "pair:" + key);
        await this.cooldown(tx, "sender:" + key + ":" + s.userId);
        if (
          (await this.count(tx, "friend_requests", s.userId)) >=
            this.limits.pendingRequests ||
          (await this.count(tx, "friend_requests", other, "recipient_id")) >=
            this.limits.pendingRequests
        )
          error("REQUEST_LIMIT_REACHED", "待处理申请已达上限");
        if ((await this.friendCount(tx, s.userId)) >= this.limits.friends)
          error("FRIEND_LIMIT_REACHED", "好友数量已达上限");
        await this.limit(
          tx,
          "request-hour:" + s.userId,
          HOUR,
          this.limits.requestHour,
        );
        await this.limit(
          tx,
          "request-day:" + s.userId,
          DAY,
          this.limits.requestDay,
        );
        const id = randomUUID();
        await tx.query(
          "INSERT INTO friend_requests(request_id,pair_key,sender_id,recipient_id,state,created_at,expires_at,version) VALUES(?,?,?,?,'PENDING',?,?,1)",
          [id, key, s.userId, other, this.now(), this.now() + 7 * DAY],
        );
        w.changed.add(s.userId);
        w.changed.add(other);
        return { requestId: id, state: "PENDING", version: 1 };
      },
    );
  }
  async requestAction(
    ctx: SocialContext,
    id: string,
    action: "ACCEPTED" | "REJECTED" | "CANCELED",
    version: number,
  ) {
    return this.mutate(
      ctx,
      "REQUEST_" + action,
      { id, version },
      async (tx, s, w) => {
        const r = await tx.one(
          "SELECT * FROM friend_requests WHERE request_id=?",
          [id],
        );
        if (
          !r ||
          (action === "CANCELED" ? r.sender_id : r.recipient_id) !== s.userId
        )
          error("NOT_FOUND", "申请不存在", 404);
        if (r.state === action)
          return { requestId: id, state: action, version: Number(r.version) };
        if (r.state !== "PENDING" || Number(r.version) !== version)
          error("REQUEST_STATE_CONFLICT", "申请状态已变化，请刷新");
        if (await this.blocked(tx, r.sender_id, r.recipient_id))
          error("REQUEST_STATE_CONFLICT", "申请状态已变化，请刷新");
        if (action === "ACCEPTED") await this.acceptPending(tx, r, w);
        else {
          await this.cooldown(
            tx,
            "sender:" + r.pair_key + ":" + r.sender_id,
            this.now() + DAY,
          );
          await this.finish(tx, "friend_requests", "request_id", id, action, w);
        }
        return { requestId: id, state: action, version: version + 1 };
      },
    );
  }
  private async acceptPending(tx: Sql, r: any, w: Work) {
    if (
      (await this.friendCount(tx, r.sender_id)) >= this.limits.friends ||
      (await this.friendCount(tx, r.recipient_id)) >= this.limits.friends
    )
      error("FRIEND_LIMIT_REACHED", "双方任一好友数量已达上限");
    const [low, high] = [r.sender_id, r.recipient_id].sort();
    await tx.query(
      "INSERT INTO friendships(pair_key,low_id,high_id,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      [r.pair_key, low, high, this.now()],
    );
    await this.finish(
      tx,
      "friend_requests",
      "request_id",
      r.request_id,
      "ACCEPTED",
      w,
    );
  }
  /** Account players from your recent tables who are not yet friends: one tap to add. */
  async suggestions(ctx: SocialContext) {
    this.enabled("friends");
    return this.store.transaction(async (tx) => {
      const s = await this.actor(tx, ctx);
      const rows = await tx.rows(
        "SELECT o.user_id,MAX(o.finished_at) AS last_at FROM (SELECT match_id FROM history_members WHERE user_id=? ORDER BY finished_at DESC,match_id DESC LIMIT 30) m JOIN history_members o ON o.match_id=m.match_id JOIN social_profiles p ON p.user_id=o.user_id WHERE o.user_id<>? GROUP BY o.user_id ORDER BY last_at DESC LIMIT 40",
        [s.userId, s.userId],
      );
      const items = [];
      for (const r of rows) {
        const id = String(r.user_id);
        if (
          (await this.blocked(tx, s.userId, id)) ||
          (await tx.one("SELECT pair_key FROM friendships WHERE pair_key=?", [
            pair(s.userId, id),
          ]))
        )
          continue;
        const pending = await tx.one(
          "SELECT sender_id FROM friend_requests WHERE pair_key=? AND state='PENDING' AND expires_at>?",
          [pair(s.userId, id), this.now()],
        );
        items.push({
          ...(await this.person(tx, id)),
          relationship: !pending
            ? "NONE"
            : pending.sender_id === s.userId
              ? "OUTGOING"
              : "INCOMING",
          lastPlayedAt: Number(r.last_at),
        });
        if (items.length >= 12) break;
      }
      return { items };
    });
  }
  private async removePair(
    tx: Sql,
    a: string,
    b: string,
    w: Work,
    requests = false,
  ) {
    await tx.query("DELETE FROM friendships WHERE pair_key=?", [pair(a, b)]);
    for (const [table, col] of [
      ["room_invitations", "invitation_id"],
      ...(requests ? [["friend_requests", "request_id"]] : []),
    ])
      for (const r of await tx.rows(
        `SELECT ${col} FROM ${table} WHERE state='PENDING' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))`,
        [a, b, b, a],
      ))
        await this.finish(tx, table, col, r[col], "INVALIDATED", w);
    await this.cooldown(tx, "pair:" + pair(a, b), this.now() + DAY);
    w.changed.add(a);
    w.changed.add(b);
  }
  async deleteFriend(ctx: SocialContext, code: string) {
    return this.mutate(ctx, "FRIEND_DELETE", { code }, async (tx, s, w) => {
      const other = await this.target(tx, code, s.userId);
      if (other === s.userId) error("SELF_NOT_ALLOWED", "不能删除自己");
      if (await this.friends(tx, s.userId, other))
        await this.removePair(tx, s.userId, other, w);
      return { deleted: true };
    });
  }
  async block(ctx: SocialContext, code: string, remove = false) {
    return this.mutate(
      ctx,
      remove ? "BLOCK_REMOVE" : "BLOCK_ADD",
      { code },
      async (tx, s, w) => {
        const other = await this.target(tx, code, s.userId, true);
        if (other === s.userId) error("SELF_NOT_ALLOWED", "不能屏蔽自己");
        const old = await tx.one(
          "SELECT blocker_id FROM blocks WHERE blocker_id=? AND blocked_id=?",
          [s.userId, other],
        );
        if (remove) {
          if (old) {
            await tx.query(
              "DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?",
              [s.userId, other],
            );
            await this.cooldown(
              tx,
              "pair:" + pair(s.userId, other),
              this.now() + DAY,
            );
            w.changed.add(s.userId);
          }
        } else if (!old) {
          const n = await tx.one(
            "SELECT COUNT(*) AS n FROM blocks WHERE blocker_id=?",
            [s.userId],
          );
          if (Number(n!.n) >= this.limits.blocks)
            error("BLOCK_LIMIT_REACHED", "屏蔽数量已达上限");
          await tx.query(
            "INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)",
            [s.userId, other, this.now()],
          );
          await this.removePair(tx, s.userId, other, w, true);
        }
        return { blocked: !remove };
      },
    );
  }
  async blocks(ctx: SocialContext, cursor = "") {
    this.enabled("friends");
    return this.store.transaction(async (tx) => {
      const s = await this.actor(tx, ctx);
      const rows = await tx.rows(
        "SELECT b.blocked_id,p.friend_code FROM blocks b JOIN social_profiles p ON p.user_id=b.blocked_id WHERE b.blocker_id=? AND p.friend_code>? ORDER BY p.friend_code LIMIT 21",
        [s.userId, cursor],
      );
      return {
        items: await Promise.all(
          rows.slice(0, 20).map((r) => this.person(tx, r.blocked_id)),
        ),
        nextCursor: rows.length > 20 ? rows[19].friend_code : null,
      };
    });
  }
  private async validInvitation(tx: Sql, i: any) {
    const room = await this.room(tx, i.room_id);
    return room &&
      room.status === "WAITING" &&
      room.hostUserId === i.sender_id &&
      room.lobbyGeneration === Number(i.lobby_generation) &&
      room.slots.some((m) => m?.userId === i.sender_id) &&
      (await this.friends(tx, i.sender_id, i.recipient_id))
      ? room
      : null;
  }
  async invite(
    ctx: SocialContext,
    input: {
      recipientFriendCode: string;
      roomId: string;
      lobbyGeneration: number;
      expectedRoomVersion: number;
    },
  ) {
    return this.mutate(ctx, "INVITE_SEND", input, async (tx, s, w) => {
      const other = await this.target(tx, input.recipientFriendCode, s.userId);
      await this.expire(tx, w, other);
      if (!(await this.friends(tx, s.userId, other)))
        error("NOT_FOUND", "无法邀请该账号", 404);
      const room = await this.room(tx, input.roomId);
      if (
        !room ||
        room.hostUserId !== s.userId ||
        !room.slots.some((m) => m?.userId === s.userId)
      )
        error("NOT_FOUND", "房间不存在", 404);
      if (
        room.status !== "WAITING" ||
        room.lobbyGeneration !== input.lobbyGeneration
      )
        error("LOBBY_GENERATION_CONFLICT", "准备轮次已变化");
      if (room.roomVersion !== input.expectedRoomVersion)
        error("ROOM_VERSION_CONFLICT", "房间已更新，请刷新");
      if (!room.slots.includes(null))
        error("ROOM_FULL", "须先由房主腾出真实空位，AI不算空位");
      const old = await tx.one(
        "SELECT * FROM room_invitations WHERE sender_id=? AND recipient_id=? AND room_id=? AND lobby_generation=? AND state='PENDING'",
        [s.userId, other, room.roomId, room.lobbyGeneration],
      );
      if (old)
        return {
          invitationId: old.invitation_id,
          state: old.state,
          version: Number(old.version),
        };
      await this.cooldown(tx, "invite:" + s.userId + ":" + other);
      if (
        (await this.count(tx, "room_invitations", s.userId)) >=
          this.limits.pendingInvitations ||
        (await this.count(tx, "room_invitations", other, "recipient_id")) >=
          this.limits.pendingInvitations
      )
        error("INVITATION_LIMIT_REACHED", "待处理邀请已达上限");
      await this.limit(
        tx,
        "invite-hour:" + s.userId,
        HOUR,
        this.limits.inviteHour,
      );
      await this.cooldown(
        tx,
        "invite:" + s.userId + ":" + other,
        this.now() + MIN,
      );
      const id = randomUUID();
      await tx.query(
        "INSERT INTO room_invitations(invitation_id,sender_id,recipient_id,room_id,lobby_generation,state,created_at,expires_at,version) VALUES(?,?,?,?,?,'PENDING',?,?,1)",
        [
          id,
          s.userId,
          other,
          room.roomId,
          room.lobbyGeneration,
          this.now(),
          this.now() + 5 * MIN,
        ],
      );
      w.changed.add(s.userId);
      w.changed.add(other);
      return { invitationId: id, state: "PENDING", version: 1 };
    });
  }
  async invitationAction(
    ctx: SocialContext,
    id: string,
    action: "JOINED" | "DECLINED" | "CANCELED",
    version: number,
  ) {
    return this.mutate(
      ctx,
      "INVITE_" + action,
      { id, version },
      async (tx, s, w) => {
        const i = await tx.one(
          "SELECT * FROM room_invitations WHERE invitation_id=?",
          [id],
        );
        if (
          !i ||
          (action === "CANCELED" ? i.sender_id : i.recipient_id) !== s.userId
        )
          error("NOT_FOUND", "邀请不存在", 404);
        if (i.state === action)
          return {
            invitationId: id,
            state: action,
            version: Number(i.version),
            ...(action === "JOINED" ? { roomId: i.room_id } : {}),
          };
        if (i.state !== "PENDING" || Number(i.version) !== version)
          error("REQUEST_STATE_CONFLICT", "邀请状态已变化，请刷新");
        const room = await this.validInvitation(tx, i);
        if (!room) {
          await this.finish(
            tx,
            "room_invitations",
            "invitation_id",
            id,
            "INVALIDATED",
            w,
          );
          return this.failure(
            new AuthError("REQUEST_STATE_CONFLICT", "邀请已失效", 409),
          );
        }
        if (action === "JOINED") {
          const occupied = await this.occupied(tx, s.userId);
          if (occupied && occupied.roomId !== room.roomId)
            error("ALREADY_IN_ROOM", "你还有未结束的房间，请先自行处理");
          if (!room.slots.some((m) => m?.userId === s.userId)) {
            const slot = room.slots.indexOf(null);
            if (slot < 0) {
              await this.finish(
                tx,
                "room_invitations",
                "invitation_id",
                id,
                "INVALIDATED",
                w,
              );
              return this.failure(
                new AuthError("ROOM_FULL", "房间已满，请房主重新邀请", 409),
              );
            }
            const p = await this.person(tx, s.userId);
            const member: Member = {
              memberId: randomUUID(),
              userId: s.userId,
              displayName: p.displayName,
              avatarId: p.avatarId,
              participantKind: "HUMAN",
              ready: false,
              connected: this.hooks.connected(s.userId),
              botLevel: null,
            };
            room.slots[slot] = member;
            room.memberJoinOrder.push(member.memberId);
            for (const m of room.slots)
              if (m?.participantKind === "HUMAN") m.ready = false;
            room.roomVersion++;
            room.roomViewSeq++;
            await tx.query(
              "UPDATE documents SET payload=?,updated_at=" +
                (this.store.pool ? "CURRENT_TIMESTAMP" : "?") +
                " WHERE kind='room' AND id=?",
              this.store.pool
                ? [JSON.stringify(room), room.roomId]
                : [JSON.stringify(room), this.now(), room.roomId],
            );
            w.rooms.push(room);
          }
        }
        await this.finish(
          tx,
          "room_invitations",
          "invitation_id",
          id,
          action,
          w,
        );
        return {
          invitationId: id,
          state: action,
          version: version + 1,
          ...(action === "JOINED" ? { roomId: room.roomId } : {}),
        };
      },
    );
  }
  async snapshot(ctx: SocialContext): Promise<SocialSnapshot> {
    this.enabled("friends");
    return this.hooks.serialize(async () => {
      const changed = new Set<string>();
      const result = await this.store.transaction(async (tx) => {
        const s = await this.actor(tx, ctx),
          w: Work = { changed, rooms: [], authChanged: false };
        await this.expire(tx, w, s.userId);
        for (const i of await tx.rows(
          "SELECT * FROM room_invitations WHERE state='PENDING' AND (sender_id=? OR recipient_id=?)",
          [s.userId, s.userId],
        ))
          if (!(await this.validInvitation(tx, i)))
            await this.finish(
              tx,
              "room_invitations",
              "invitation_id",
              i.invitation_id,
              "INVALIDATED",
              w,
            );
        for (const id of changed) await this.bump(tx, id);
        const friends = [];
        for (const r of await tx.rows(
          "SELECT low_id,high_id FROM friendships WHERE low_id=? OR high_id=?",
          [s.userId, s.userId],
        )) {
          const id = r.low_id === s.userId ? r.high_id : r.low_id;
          if (!(await this.blocked(tx, s.userId, id)))
            friends.push({
              ...(await this.person(tx, id)),
              status: await this.presence(tx, id),
            });
        }
        const order = { WAITING: 0, ONLINE: 1, PLAYING: 2, OFFLINE: 3 };
        friends.sort(
          (a, b) =>
            order[a.status] - order[b.status] ||
            a.displayName
              .normalize("NFC")
              .localeCompare(b.displayName.normalize("NFC")) ||
            a.friendCode.localeCompare(b.friendCode),
        );
        const requests = await tx.rows(
          "SELECT * FROM friend_requests WHERE state='PENDING' AND (sender_id=? OR recipient_id=?) ORDER BY created_at,request_id",
          [s.userId, s.userId],
        );
        const receivedRequests: FriendRequest[] = [],
          sentRequests: FriendRequest[] = [];
        for (const r of requests) {
          if (await this.blocked(tx, r.sender_id, r.recipient_id)) continue;
          const item = {
            requestId: r.request_id,
            sender: await this.person(tx, r.sender_id),
            recipient: await this.person(tx, r.recipient_id),
            createdAt: Number(r.created_at),
            expiresAt: Number(r.expires_at),
            version: Number(r.version),
            state: r.state,
          };
          (r.recipient_id === s.userId ? receivedRequests : sentRequests).push(
            item,
          );
        }
        const receivedInvitations: RoomInvitation[] = [],
          sentInvitations: RoomInvitation[] = [];
        for (const i of await tx.rows(
          "SELECT * FROM room_invitations WHERE state='PENDING' AND (sender_id=? OR recipient_id=?) ORDER BY created_at,invitation_id",
          [s.userId, s.userId],
        )) {
          const room = await this.validInvitation(tx, i);
          if (!room) continue;
          const item = {
            invitationId: i.invitation_id,
            sender: await this.person(tx, i.sender_id),
            recipient: await this.person(tx, i.recipient_id),
            createdAt: Number(i.created_at),
            expiresAt: Number(i.expires_at),
            version: Number(i.version),
            state: i.state,
            format: room.config.format,
            occupants: room.slots.filter(Boolean).length,
          };
          (i.recipient_id === s.userId
            ? receivedInvitations
            : sentInvitations
          ).push(item);
        }
        const revision = Number(
          (
            await tx.one(
              "SELECT revision FROM social_user_state WHERE user_id=?",
              [s.userId],
            )
          )?.revision ?? 0,
        );
        return {
          friends,
          receivedRequests,
          sentRequests,
          receivedInvitations,
          sentInvitations,
          counts: {
            requests: receivedRequests.length,
            invitations: receivedInvitations.length,
            total: receivedRequests.length + receivedInvitations.length,
          },
          revision,
          serverTime: this.now(),
          presenceEpoch: this.presenceEpoch,
          presenceSeq: this.presenceSeq,
        };
      });
      if (changed.size) void this.publish(changed);
      return result;
    });
  }
  private active(userId: string) {
    return [...this.connections.values()].some(
      (c) => c.userId === userId && this.auth.resolveHash(c.hash),
    );
  }
  private async presence(tx: Sql, userId: string): Promise<PresenceStatus> {
    const grace = this.grace.get(userId),
      online =
        this.active(userId) ||
        (grace &&
          grace.until > this.now() &&
          grace.hashes.some((h) => !!this.auth.resolveHash(h)));
    if (!online) return "OFFLINE";
    const room = await this.occupied(tx, userId);
    return room?.status === "WAITING"
      ? "WAITING"
      : room?.status === "PLAYING"
        ? "PLAYING"
        : "ONLINE";
  }
  connect(connectionId: string, identity: Identity) {
    this.connections.set(connectionId, {
      userId: identity.userId,
      hash: identity.tokenHash,
    });
    this.grace.delete(identity.userId);
    this.presenceSeq++;
    void this.notifyRelated([identity.userId]);
  }
  disconnect(connectionId: string) {
    const c = this.connections.get(connectionId);
    if (!c) return;
    this.connections.delete(connectionId);
    if (!this.active(c.userId) && this.auth.resolveHash(c.hash))
      this.grace.set(c.userId, { until: this.now() + 30000, hashes: [c.hash] });
    this.presenceSeq++;
    void this.notifyRelated([c.userId]);
  }
  revoked() {
    const affected = new Set<string>();
    for (const [id, c] of this.connections)
      if (!this.auth.resolveHash(c.hash)) {
        this.connections.delete(id);
        affected.add(c.userId);
      }
    for (const [id, g] of this.grace)
      if (!g.hashes.some((h) => !!this.auth.resolveHash(h))) {
        this.grace.delete(id);
        affected.add(id);
      }
    if (affected.size) {
      this.presenceSeq++;
      void this.notifyRelated(affected);
    }
  }
  async presenceTick() {
    this.revoked();
    if (this.roomNotifications.size) {
      const changed = [...this.roomNotifications];
      this.roomNotifications.clear();
      void this.publish(changed);
    }
    const affected = new Set<string>();
    for (const [id, g] of this.grace)
      if (g.until <= this.now()) {
        this.grace.delete(id);
        affected.add(id);
      }
    if (affected.size) {
      this.presenceSeq++;
      void this.notifyRelated(affected);
    }
    for (const c of this.connections.values()) await this.touch(c.hash);
    let cleaned = 0;
    for (const hash of this.touches.keys())
      if (!this.auth.resolveHash(hash)) {
        this.touches.delete(hash);
        if (++cleaned >= 100) break;
      }
  }
  async notifyRelated(users: Iterable<string>) {
    const targets = new Set<string>();
    for (const id of new Set(users)) {
      targets.add(id);
      try {
        await this.store.transaction(async (tx) => {
          for (const r of await tx.rows(
            "SELECT low_id,high_id FROM friendships WHERE low_id=? OR high_id=?",
            [id, id],
          )) {
            const other = r.low_id === id ? r.high_id : r.low_id;
            if (!(await this.blocked(tx, id, other))) targets.add(other);
          }
        });
      } catch {}
    }
    await this.publish(targets, "PRESENCE");
  }
  roomPresenceChanged(room: Room) {
    this.presenceSeq++;
    void this.notifyRelated(
      room.slots.flatMap((m) => (m?.userId ? [m.userId] : [])),
    );
  }
  async touch(hash: string) {
    const s = this.auth.resolveHash(hash);
    if (
      s?.kind !== "ACCOUNT" ||
      this.now() - (this.touches.get(hash) ?? -Infinity) < MIN
    )
      return;
    this.touches.set(hash, this.now());
    await this.store.transaction((tx) =>
      tx.query("UPDATE social_sessions SET last_seen_at=? WHERE token_hash=?", [
        this.now(),
        hash,
      ]),
    );
  }
  async devices(ctx: SocialContext, cursor = "") {
    this.enabled("sessionManagement");
    return this.store.transaction(async (tx) => {
      const s = await this.actor(tx, ctx);
      const rows = await tx.rows(
        "SELECT d.*,s.expires_at FROM social_sessions d JOIN auth_sessions s ON s.token_hash=d.token_hash JOIN auth_accounts a ON a.user_id=s.user_id WHERE d.user_id=? AND d.session_id>? AND s.revoked_at IS NULL AND s.expires_at>? AND s.auth_version=a.auth_version AND s.environment=? ORDER BY d.session_id LIMIT 21",
        [s.userId, cursor, this.now(), this.auth.config.environment],
      );
      return {
        items: rows.slice(0, 20).map((r) => ({
          sessionId: r.session_id,
          current: r.token_hash === s.tokenHash,
          browser: r.browser,
          os: r.os,
          createdAt: r.created_at === null ? null : Number(r.created_at),
          expiresAt: Number(r.expires_at),
          lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
        })),
        nextCursor: rows.length > 20 ? rows[19].session_id : null,
        serverTime: this.now(),
      };
    });
  }
  async revokeDevices(
    ctx: SocialContext,
    password: string,
    sessionId: string | null,
    flowId: string,
  ) {
    this.enabled("sessionManagement");
    const payload = { sessionId, password, flowId },
      name = sessionId ? "DEVICE_REVOKE" : "DEVICE_OTHERS";
    const prepared = await this.store.transaction(async (tx) => {
      const s = await this.actor(tx, ctx);
      const prior = await tx.one(
        "SELECT payload_hmac,result FROM social_receipts WHERE scope=? AND request_id=?",
        [this.scope(ctx, name, s.userId), ctx.requestId],
      );
      if (prior) {
        if (prior.payload_hmac !== this.hash(name, payload))
          error("REQUEST_ID_CONFLICT", "这项操作已经提交过了");
        return { prior: parseJSON(prior.result) };
      }
      await this.limit(
        tx,
        "device-account:" + s.userId,
        15 * MIN,
        this.limits.passwordAccount,
        false,
      );
      await this.limit(
        tx,
        "device-ip:" + ctx.ip,
        15 * MIN,
        this.limits.passwordIp,
        false,
      );
      return {
        account: await tx.one(
          "SELECT password_hash,auth_version FROM auth_accounts WHERE user_id=?",
          [s.userId],
        ),
      };
    });
    if (prepared.prior) return this.unwrap(prepared.prior);
    const valid = await this.auth.passwords.verify(
      password,
      prepared.account!.password_hash,
    );
    return this.mutate(ctx, name, payload, async (tx, s, w) => {
      await this.limit(
        tx,
        "device-account:" + s.userId,
        15 * MIN,
        this.limits.passwordAccount,
        false,
      );
      await this.limit(
        tx,
        "device-ip:" + ctx.ip,
        15 * MIN,
        this.limits.passwordIp,
        false,
      );
      const a = await tx.one(
        "SELECT password_hash,auth_version FROM auth_accounts WHERE user_id=?",
        [s.userId],
      );
      if (
        !valid ||
        a!.password_hash !== prepared.account!.password_hash ||
        a!.auth_version !== prepared.account!.auth_version
      ) {
        await this.limit(
          tx,
          "device-account:" + s.userId,
          15 * MIN,
          this.limits.passwordAccount,
        );
        await this.limit(
          tx,
          "device-ip:" + ctx.ip,
          15 * MIN,
          this.limits.passwordIp,
        );
        return this.failure(
          new AuthError("PASSWORD_INVALID", "当前密码不正确或已变化", 401),
        );
      }
      let targets;
      if (sessionId) {
        const d = await tx.one(
          "SELECT * FROM social_sessions WHERE session_id=? AND user_id=?",
          [sessionId, s.userId],
        );
        if (!d) error("NOT_FOUND", "会话不存在", 404);
        if (d.token_hash === s.tokenHash)
          error("CURRENT_SESSION_NOT_ALLOWED", "当前会话请使用退出登录");
        targets = [d];
      } else
        targets = await tx.rows(
          "SELECT d.token_hash FROM social_sessions d JOIN auth_sessions s ON s.token_hash=d.token_hash WHERE d.user_id=? AND d.token_hash<>? AND s.revoked_at IS NULL AND s.expires_at>?",
          [s.userId, s.tokenHash, this.now()],
        );
      for (const d of targets) {
        await tx.query(
          "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
          [this.now(), d.token_hash],
        );
        const legacy = await tx.one(
          "SELECT payload FROM documents WHERE kind='session' AND id=?",
          [d.token_hash],
        );
        if (legacy) {
          const value = parseJSON(legacy.payload);
          value.expires = 0;
          await tx.query(
            "UPDATE documents SET payload=? WHERE kind='session' AND id=?",
            [JSON.stringify(value), d.token_hash],
          );
        }
      }
      w.authChanged = true;
      w.changed.add(s.userId);
      return { revoked: true };
    }).finally(() => this.revoked());
  }
  async cleanup(limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100)),
      before = this.now();
    return this.hooks.serialize(async () => {
      const changed = new Set<string>();
      await this.store.transaction(async (tx) => {
        // Expire inactive users' rows too; cleanup must share mutation ordering.
        for (const [table, id] of [
          ["friend_requests", "request_id"],
          ["room_invitations", "invitation_id"],
        ] as const) {
          const rows = await tx.rows(
            `SELECT ${id},sender_id,recipient_id FROM ${table} WHERE state='PENDING' AND expires_at<=? LIMIT ${n}`,
            [before],
          );
          for (const row of rows) {
            await tx.query(
              `UPDATE ${table} SET state='EXPIRED',version=version+1 WHERE ${id}=? AND state='PENDING'`,
              [row[id]],
            );
            for (const userId of [row.sender_id, row.recipient_id]) {
              await this.bump(tx, userId);
              changed.add(userId);
            }
          }
        }
        for (const [table, id, where, params] of [
          [
            "friend_requests",
            "request_id",
            "state<>'PENDING' AND expires_at<?",
            [before - 30 * DAY],
          ],
          [
            "room_invitations",
            "invitation_id",
            "state<>'PENDING' AND expires_at<?",
            [before - 30 * DAY],
          ],
          [
            "social_receipts",
            "request_id",
            "created_at<?",
            [before - 30 * DAY],
          ],
          ["social_audit", "audit_id", "at<?", [before - 90 * DAY]],
          ["social_limits", "entry_id", "at<?", [before - DAY]],
          ["social_cooldowns", "scope", "until_at<?", [before]],
        ] as const) {
          const rows = await tx.rows(
            `SELECT * FROM ${table} WHERE ${where} LIMIT ${n}`,
            [...params],
          );
          for (const row of rows)
            await tx.query(
              `DELETE FROM ${table} WHERE ${id}=?` +
                (table === "social_receipts" ? " AND scope=?" : ""),
              table === "social_receipts" ? [row[id], row.scope] : [row[id]],
            );
        }
        const stale = await tx.rows(
          `SELECT d.session_id FROM social_sessions d JOIN auth_sessions s ON s.token_hash=d.token_hash WHERE (s.revoked_at IS NOT NULL AND s.revoked_at<?) OR s.expires_at<? LIMIT ${n}`,
          [before - 30 * DAY, before - 30 * DAY],
        );
        for (const r of stale)
          await tx.query("DELETE FROM social_sessions WHERE session_id=?", [
            r.session_id,
          ]);
      });
      if (changed.size) await this.publish(changed);
    });
  }
}
