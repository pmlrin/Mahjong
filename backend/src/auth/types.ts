export type Purpose = "REGISTER" | "RESET_PASSWORD";
export type IdentityKind = "GUEST" | "ACCOUNT";
export interface Profile {
  userId: string;
  displayName: string;
  kind: IdentityKind;
  createdAt: number;
}
export interface Account {
  userId: string;
  emailKey: string;
  emailAddress: string;
  emailVerifiedAt: number;
  passwordHash: string;
  authVersion: number;
  updatedAt: number;
}
export interface AuthSession {
  tokenHash: string;
  userId: string;
  authVersion: number;
  environment: string;
  createdAt: number;
  expires: number;
  revokedAt: number | null;
}
export interface Identity extends AuthSession {
  displayName: string;
  kind: IdentityKind;
  maskedEmail: string | null;
}
export interface AuthContext {
  device?: { browser: string; os: string };
  tokenHash: string | null;
  flowId: string;
  ip: string;
  requestId: string;
}
export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export interface Failure {
  code: string;
  message: string;
  status: number;
}
export interface AuthReply {
  data: Record<string, any>;
  token?: string;
  clearCookie?: boolean;
  error?: Failure;
}
export function failed(code: string, message: string, status = 400): AuthReply {
  return { data: {}, error: { code, message, status } };
}
export interface AuthHooks {
  serialize: <T>(fn: () => Promise<T>) => Promise<T>;
  assertReleased: (session: Identity) => void;
  invalidate: (hashes: string[]) => Promise<void>;
}
