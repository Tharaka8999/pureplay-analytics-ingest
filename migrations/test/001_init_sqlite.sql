-- Pureplay Analytics Ingest — SQLite-compatible schema (used in tests only).
-- Key differences from Postgres version:
--   JSONB → TEXT, TIMESTAMPTZ → TEXT, DOUBLE PRECISION → REAL,
--   BIGSERIAL → INTEGER, now() → (datetime('now')), DEFAULT not needed for PK.

CREATE TABLE IF NOT EXISTS shots (
  canonical_shot_id    TEXT        PRIMARY KEY,
  vendor               TEXT        NOT NULL,
  vendor_shot_id       TEXT,
  idempotency_key      TEXT        NOT NULL,
  vendor_user_id       TEXT        NOT NULL,
  canonical_user_id    TEXT,
  captured_at_utc      TEXT        NOT NULL,
  captured_at_tz_offset_min INTEGER,
  received_at_utc      TEXT        NOT NULL,
  club_code            TEXT        NOT NULL,
  club_raw             TEXT        NOT NULL,
  ball_speed_mps       REAL        NOT NULL,
  club_head_speed_mps  REAL,
  launch_angle_deg     REAL        NOT NULL,
  spin_rpm             INTEGER,
  carry_m              REAL        NOT NULL,
  total_m              REAL,
  lateral_m            REAL        NOT NULL,
  device_id            TEXT,
  session_id           TEXT,
  content_hash         TEXT        NOT NULL,
  raw_payload          TEXT        NOT NULL,
  schema_version       INTEGER     NOT NULL DEFAULT 1,
  parser_version       TEXT        NOT NULL,
  duplicate_of         TEXT        REFERENCES shots(canonical_shot_id),
  created_at           TEXT        NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS shots_vendor_idempotency_key
  ON shots(vendor, idempotency_key);

CREATE INDEX IF NOT EXISTS shots_vendor_user_id_content_hash_captured
  ON shots(vendor_user_id, content_hash, captured_at_utc);

CREATE INDEX IF NOT EXISTS shots_canonical_user_id_captured
  ON shots(canonical_user_id, captured_at_utc);

CREATE INDEX IF NOT EXISTS shots_vendor_vendor_user_id_captured
  ON shots(vendor, vendor_user_id, captured_at_utc);

CREATE INDEX IF NOT EXISTS shots_vendor_user_id_club_captured
  ON shots(vendor_user_id, club_code, captured_at_utc);

CREATE TABLE IF NOT EXISTS user_identities (
  id                   INTEGER     PRIMARY KEY AUTOINCREMENT,
  vendor               TEXT        NOT NULL,
  vendor_user_id       TEXT        NOT NULL,
  canonical_user_id    TEXT        NOT NULL,
  created_at           TEXT        NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT        NOT NULL DEFAULT (datetime('now')),
  UNIQUE(vendor, vendor_user_id)
);

CREATE TABLE IF NOT EXISTS identity_merges (
  id                   INTEGER     PRIMARY KEY AUTOINCREMENT,
  from_canonical_user_id TEXT      NOT NULL,
  to_canonical_user_id   TEXT      NOT NULL,
  merged_at            TEXT        NOT NULL DEFAULT (datetime('now')),
  merged_by            TEXT
);

CREATE TABLE IF NOT EXISTS ingestion_failures (
  id                   INTEGER     PRIMARY KEY AUTOINCREMENT,
  vendor               TEXT        NOT NULL,
  received_at_utc      TEXT        NOT NULL,
  raw_body             TEXT        NOT NULL,
  http_status          INTEGER     NOT NULL,
  error_code           TEXT        NOT NULL,
  error_detail         TEXT,
  correlation_id       TEXT,
  created_at           TEXT        NOT NULL DEFAULT (datetime('now'))
)
