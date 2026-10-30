-- PostgreSQL initial schema. Startup applies this CREATE TABLE idempotently.
-- kind: session / room / match / receipt / http / outbox
-- One logical writer holds PostgreSQL advisory lock 849273161.
CREATE TABLE IF NOT EXISTS documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
