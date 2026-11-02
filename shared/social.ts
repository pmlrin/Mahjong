import { z } from "zod";
export const AVATARS = [
  { id: "bamboo", name: "青竹", symbol: "竹", color: "#386b54" },
  { id: "plum", name: "梅花", symbol: "梅", color: "#a55a64" },
  { id: "orchid", name: "幽兰", symbol: "兰", color: "#666796" },
  { id: "chrysanthemum", name: "秋菊", symbol: "菊", color: "#a57837" },
  { id: "pine", name: "松风", symbol: "松", color: "#356861" },
  { id: "moon", name: "明月", symbol: "月", color: "#656c83" },
  { id: "cloud", name: "流云", symbol: "云", color: "#5e8290" },
  { id: "mountain", name: "远山", symbol: "山", color: "#607053" },
  { id: "river", name: "清川", symbol: "川", color: "#467b9b" },
  { id: "snow", name: "初雪", symbol: "雪", color: "#7d899a" },
  { id: "sun", name: "朝日", symbol: "日", color: "#ae6546" },
  { id: "crane", name: "白鹤", symbol: "鹤", color: "#7d6862" },
] as const;
export const DEFAULT_AVATAR = "bamboo";
export type AvatarId = (typeof AVATARS)[number]["id"];
export const presetAvatarSchema = z.enum(
  AVATARS.map((a) => a.id) as [AvatarId, ...AvatarId[]],
);
export const uploadedAvatarSchema = z
  .string()
  .regex(
    /^upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const avatarSchema = z.union([presetAvatarSchema, uploadedAvatarSchema]);
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_UPLOAD_BYTES = 300 * 1024;
export const AVATAR_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const nicknameSchema = z
  .string()
  .max(256)
  .refine(
    (s) => !/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(s),
    "昵称不能含控制字符",
  )
  .transform((s) => s.trim().normalize("NFC"))
  .refine(
    (s) =>
      [...s].length >= 1 &&
      [...s].length <= 16 &&
      !/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(s),
    "昵称须为1至16个字符，不含换行、控制或方向控制符",
  );
export const friendCodeSchema = z
  .string()
  .max(40)
  .transform((s) =>
    s
      .trim()
      .replace(/-/g, "")
      .replace(/[a-z]/g, (c) => c.toUpperCase()),
  )
  .pipe(z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/));
export const profileUpdateSchema = z
  .object({
    displayName: nicknameSchema,
    avatarId: avatarSchema,
    expectedProfileVersion: z.number().int().positive(),
  })
  .strict();
export const versionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const friendInputSchema = z
  .object({ friendCode: friendCodeSchema })
  .strict();
export const inviteInputSchema = z
  .object({
    recipientFriendCode: friendCodeSchema,
    roomId: z.string().min(1).max(128),
    lobbyGeneration: z.number().int().positive(),
    expectedRoomVersion: z.number().int().positive(),
  })
  .strict();
export const deviceRevokeSchema = z
  .object({
    sessionId: z.uuid(),
    currentPassword: z.string().max(256),
    flowId: z.uuid(),
  })
  .strict();
export const devicesRevokeSchema = deviceRevokeSchema.omit({ sessionId: true });
export const deviceClass = (ua: string) => ({
  browser: /Edg\//.test(ua)
    ? "EDGE"
    : /Firefox\//.test(ua)
      ? "FIREFOX"
      : /Chrome\/|CriOS\//.test(ua)
        ? "CHROME"
        : /Safari\//.test(ua)
          ? "SAFARI"
          : "UNKNOWN",
  os: /Android/.test(ua)
    ? "ANDROID"
    : /iPhone|iPad|iPod/.test(ua)
      ? "IOS"
      : /Windows/.test(ua)
        ? "WINDOWS"
        : /Macintosh|Mac OS X/.test(ua)
          ? "MACOS"
          : /Linux/.test(ua)
            ? "LINUX"
            : "UNKNOWN",
});
export type PresenceStatus = "WAITING" | "ONLINE" | "PLAYING" | "OFFLINE";
export interface SocialProfile {
  friendCode: string;
  displayName: string;
  avatarId: string;
  profileVersion: number;
  lastNicknameChangedAt: number | null;
  serverTime: number;
  avatars: typeof AVATARS;
}
export interface SocialPerson {
  friendCode: string;
  displayName: string;
  avatarId: string;
}
export interface Friend extends SocialPerson {
  status: PresenceStatus;
}
export interface FriendRequest {
  requestId: string;
  sender: SocialPerson;
  recipient: SocialPerson;
  createdAt: number;
  expiresAt: number;
  version: number;
  state: string;
}
export interface RoomInvitation {
  invitationId: string;
  sender: SocialPerson;
  recipient: SocialPerson;
  format: "EAST_ONLY" | "HANCHAN";
  occupants: number;
  createdAt: number;
  expiresAt: number;
  version: number;
  state: string;
}
export interface SocialSnapshot {
  friends: Friend[];
  receivedRequests: FriendRequest[];
  sentRequests: FriendRequest[];
  receivedInvitations: RoomInvitation[];
  sentInvitations: RoomInvitation[];
  counts: { requests: number; invitations: number; total: number };
  revision: number;
  serverTime: number;
  presenceEpoch: string;
  presenceSeq: number;
}
export interface DeviceSession {
  sessionId: string;
  current: boolean;
  browser: string;
  os: string;
  createdAt: number | null;
  expiresAt: number;
  lastSeenAt: number | null;
}
export interface SocialCapabilities {
  profileEditing: boolean;
  sessionManagement: boolean;
  friends: boolean;
  friendInvitations: boolean;
  socialSchemaVersion: 1;
  limits: Record<string, number>;
}
