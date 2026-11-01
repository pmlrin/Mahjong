-- Additive account schema; shared semantics for PostgreSQL and SQLite.
-- Backfill requires backend/src/auth/migrate.ts; it preserves legacy user IDs.
CREATE TABLE IF NOT EXISTS auth_environment (singleton INTEGER PRIMARY KEY CHECK(singleton=1),environment TEXT NOT NULL CHECK(environment IN ('preview','production')));
CREATE TABLE IF NOT EXISTS auth_users (user_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('GUEST','ACCOUNT')),created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_accounts (user_id TEXT PRIMARY KEY REFERENCES auth_users(user_id),email_key TEXT NOT NULL UNIQUE,email_address TEXT NOT NULL,email_verified_at BIGINT NOT NULL,password_hash TEXT NOT NULL,auth_version INTEGER NOT NULL,updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(user_id),auth_version INTEGER NOT NULL,environment TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,revoked_at BIGINT);
CREATE INDEX IF NOT EXISTS auth_session_user ON auth_sessions(user_id,revoked_at,expires_at);
CREATE TABLE IF NOT EXISTS auth_challenges (challenge_id TEXT PRIMARY KEY,purpose TEXT NOT NULL,email_key TEXT NOT NULL,email_address TEXT NOT NULL,flow_hash TEXT NOT NULL,session_hash TEXT,subject_id TEXT,auth_version INTEGER,environment TEXT NOT NULL,code_hmac TEXT NOT NULL,state TEXT NOT NULL,failures INTEGER NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,verified_at BIGINT);
CREATE INDEX IF NOT EXISTS auth_challenge_email ON auth_challenges(environment,email_key,purpose,created_at DESC);
CREATE TABLE IF NOT EXISTS auth_grants (token_hash TEXT PRIMARY KEY,challenge_id TEXT NOT NULL REFERENCES auth_challenges(challenge_id),purpose TEXT NOT NULL,flow_hash TEXT NOT NULL,session_hash TEXT,subject_id TEXT,environment TEXT NOT NULL,expires_at BIGINT NOT NULL,state TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_grant_challenge ON auth_grants(challenge_id,state);
CREATE TABLE IF NOT EXISTS auth_mail_jobs (job_id TEXT PRIMARY KEY,challenge_id TEXT NOT NULL UNIQUE REFERENCES auth_challenges(challenge_id),purpose TEXT NOT NULL,environment TEXT NOT NULL,masked_recipient TEXT NOT NULL,ciphertext TEXT,status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at BIGINT NOT NULL,lease_until BIGINT,last_error TEXT,provider_id TEXT,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_mail_due ON auth_mail_jobs(status,next_attempt_at,expires_at);
CREATE TABLE IF NOT EXISTS auth_limits (bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_limit_expiry ON auth_limits(expires_at,bucket);
CREATE TABLE IF NOT EXISTS auth_receipts (scope TEXT NOT NULL,request_id TEXT NOT NULL,payload_hmac TEXT NOT NULL,result TEXT NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(scope,request_id));
CREATE TABLE IF NOT EXISTS auth_audit (audit_id TEXT PRIMARY KEY,event TEXT NOT NULL,subject_id TEXT,environment TEXT NOT NULL,at BIGINT NOT NULL,details TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_migrations (name TEXT PRIMARY KEY,applied_at BIGINT NOT NULL,details TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_migration_issues (user_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(user_id,reason));
