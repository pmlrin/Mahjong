-- Existing identities and frozen match avatars are unchanged.
CREATE TABLE IF NOT EXISTS avatar_assets (
  avatar_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_accounts(user_id),
  sha256 TEXT NOT NULL,
  png_base64 TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, sha256)
);
CREATE INDEX IF NOT EXISTS avatar_asset_owner ON avatar_assets(user_id, created_at);
