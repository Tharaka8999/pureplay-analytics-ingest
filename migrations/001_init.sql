-- Pureplay Analytics Ingest — initial schema (PostgreSQL DDL)
-- Do not drop columns; use tombstone + migration pattern for removals.
-- All statements are idempotent (IF NOT EXISTS / DO...EXCEPTION) — safe to run on every startup.

-- ──────────────────────────────────────────────────────────────
-- ENUM TYPES
-- Constrained domains stored as 4-byte OIDs internally; type-safe,
-- self-documenting, and enforced by the DB without a CHECK constraint.
-- The DO/EXCEPTION pattern is the standard idempotent ENUM creation
-- for PostgreSQL (CREATE TYPE has no IF NOT EXISTS clause).
-- ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE vendor_enum AS ENUM ('trackpro', 'swingmetric', 'proswing');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE club_code_enum AS ENUM (
    'DR',
    '3W', '4W', '5W', '7W',
    '2H', '3H', '4H', '5H',
    '1I', '2I', '3I', '4I', '5I', '6I', '7I', '8I', '9I',
    'PW', 'GW', 'AW', 'SW', 'LW',
    'PT',
    'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────
-- SHOTS — normalised, one row per logical shot
-- Type rationale per column:
--   VARCHAR(n)       : variable-length string with a documented maximum
--   CHAR(64)         : SHA-256 hex — always exactly 64 chars (fixed-length)
--   vendor_enum      : 3-value constrained domain; DB rejects unknowns
--   club_code_enum   : 23-value constrained domain; DB rejects unknowns
--   DOUBLE PRECISION : IEEE 754 64-bit float — for physical measurements
--   INTEGER          : 32-bit integer — for whole-number counts (RPM)
--   SMALLINT         : 16-bit integer — for small-range integers (offsets, codes, versions)
--   TIMESTAMPTZ      : timestamp with timezone — always UTC in the DB
--   JSONB            : structured JSON — queryable, indexable, no manual stringify
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shots (
  -- Identity
  canonical_shot_id         VARCHAR(26)      PRIMARY KEY,        -- ULID: always 26 chars
  vendor                    vendor_enum      NOT NULL,            -- enum; DB rejects unknown vendors
  vendor_shot_id            VARCHAR(255),                         -- vendor's own shot ID (tp shot_uid, ps shot.id)
  idempotency_key           VARCHAR(600)     NOT NULL,            -- composite: sm|{255}|{255}|{13} ≤ 528 chars

  -- User
  vendor_user_id            VARCHAR(255)     NOT NULL,            -- vendor-scoped user identifier
  canonical_user_id         VARCHAR(26),                          -- ULID; NULL until identity resolved

  -- Time
  captured_at_utc           TIMESTAMPTZ      NOT NULL,
  captured_at_tz_offset_min SMALLINT,                            -- UTC offset in minutes; range −720..+840
  received_at_utc           TIMESTAMPTZ      NOT NULL,

  -- Club
  club_code                 club_code_enum   NOT NULL,            -- enum; DB rejects unknown codes
  club_raw                  VARCHAR(64)      NOT NULL,            -- raw vendor string; longest realistic: "pitching wedge"

  -- Measurements (SI units throughout; source units in raw_payload)
  ball_speed_mps            DOUBLE PRECISION NOT NULL
                              CHECK (ball_speed_mps >= 0 AND ball_speed_mps < 120),
  club_head_speed_mps       DOUBLE PRECISION
                              CHECK (club_head_speed_mps IS NULL
                                OR (club_head_speed_mps >= 0 AND club_head_speed_mps < 100)),
  launch_angle_deg          DOUBLE PRECISION NOT NULL
                              CHECK (launch_angle_deg BETWEEN -10 AND 70),
  spin_rpm                  INTEGER                               -- whole RPM; never fractional
                              CHECK (spin_rpm IS NULL
                                OR (spin_rpm >= 0 AND spin_rpm < 15000)),
  carry_m                   DOUBLE PRECISION NOT NULL
                              CHECK (carry_m >= 0 AND carry_m < 450),
  total_m                   DOUBLE PRECISION
                              CHECK (total_m IS NULL
                                OR (total_m >= 0 AND total_m < 500)),
  lateral_m                 DOUBLE PRECISION NOT NULL             -- right=+, left=− (TrackMan convention)
                              CHECK (lateral_m BETWEEN -200 AND 200),

  -- Provenance
  device_id                 VARCHAR(255),                         -- launch-monitor device identifier
  session_id                VARCHAR(255),                         -- vendor session identifier
  content_hash              CHAR(64)         NOT NULL,            -- SHA-256 hex; always exactly 64 chars

  -- Metadata
  raw_payload               JSONB            NOT NULL,            -- full vendor payload; NEVER expose to callers
  schema_version            SMALLINT         NOT NULL DEFAULT 1,  -- incremented on normalised-schema changes
  parser_version            VARCHAR(20)      NOT NULL,            -- semver; e.g. "1.0.0"
  duplicate_of              VARCHAR(26)      REFERENCES shots(canonical_shot_id),  -- soft-dedupe FK

  created_at                TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shots_vendor_idempotency_key
  ON shots (vendor, idempotency_key);

CREATE INDEX IF NOT EXISTS shots_vendor_user_id_content_hash_captured
  ON shots (vendor_user_id, content_hash, captured_at_utc);

CREATE INDEX IF NOT EXISTS shots_canonical_user_id_captured
  ON shots (canonical_user_id, captured_at_utc DESC)
  WHERE canonical_user_id IS NOT NULL;

-- Composite index for shots.service.ts queries filtering by canonical user + club code.
-- Covers the common "show me my driver shots in the last 30 days" access pattern.
CREATE INDEX IF NOT EXISTS shots_canonical_user_id_club_captured
  ON shots (canonical_user_id, club_code, captured_at_utc DESC)
  WHERE canonical_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shots_vendor_vendor_user_id_captured
  ON shots (vendor, vendor_user_id, captured_at_utc DESC);

CREATE INDEX IF NOT EXISTS shots_vendor_user_id_club_captured
  ON shots (vendor_user_id, club_code, captured_at_utc DESC);

-- ──────────────────────────────────────────────────────────────
-- USER_IDENTITIES — vendor ID → canonical user mapping
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_identities (
  id                 BIGSERIAL    PRIMARY KEY,
  vendor             vendor_enum  NOT NULL,                       -- enum; consistent with shots.vendor
  vendor_user_id     VARCHAR(255) NOT NULL,                       -- vendor-scoped user identifier
  canonical_user_id  VARCHAR(26)  NOT NULL,                       -- ULID
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (vendor, vendor_user_id)
);

-- Index for listByCanonicalUser: WHERE canonical_user_id = $1.
-- Without this the query is a full table scan; under load this exhausts the pool.
CREATE INDEX IF NOT EXISTS user_identities_canonical_user_id
  ON user_identities (canonical_user_id);

-- ──────────────────────────────────────────────────────────────
-- IDENTITY_MERGES — audit trail when canonical users are merged
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS identity_merges (
  id                       BIGSERIAL    PRIMARY KEY,
  from_canonical_user_id   VARCHAR(26)  NOT NULL,                 -- ULID of the losing canonical user
  to_canonical_user_id     VARCHAR(26)  NOT NULL,                 -- ULID of the winning canonical user
  merged_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  merged_by                VARCHAR(255)                           -- operator or service that performed the merge
);

-- ──────────────────────────────────────────────────────────────
-- INGESTION_FAILURES — rejected / clock-skewed payloads for ops review
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingestion_failures (
  id               BIGSERIAL    PRIMARY KEY,
  vendor           vendor_enum  NOT NULL,                         -- enum; consistent with shots.vendor
  received_at_utc  TIMESTAMPTZ  NOT NULL,
  raw_body         TEXT         NOT NULL,                         -- PII-redacted payload; unbounded (webhook bodies can be large)
  http_status      SMALLINT     NOT NULL,                         -- HTTP status code (100–599)
  error_code       VARCHAR(64)  NOT NULL,                         -- UPPER_SNAKE_CASE e.g. "CLOCK_SKEW_EXCESSIVE"
  error_detail     JSONB,                                         -- structured context; queryable
  correlation_id   VARCHAR(64),                                   -- UUID (36 chars) or ULID (26 chars)
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingestion_failures_vendor_received
  ON ingestion_failures (vendor, received_at_utc DESC);

-- ──────────────────────────────────────────────────────────────
-- OUTBOX_EVENTS — transactional outbox for shot.persisted events
-- Written atomically with the shot INSERT inside the same DB transaction.
-- Polled by OutboxPublisher every 5 seconds; published events are deleted.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbox_events (
  id              BIGSERIAL    PRIMARY KEY,
  event_type      VARCHAR(64)  NOT NULL,                         -- e.g. 'shot.persisted'
  payload         JSONB        NOT NULL,                         -- event data; queryable
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbox_events_created_at
  ON outbox_events (created_at ASC);

-- ──────────────────────────────────────────────────────────────
-- AUDIT_LOG — append-only record of privileged identity operations
-- Separate from application logs (pino) — immutable, queryable.
-- Required for SOC 2 CC6 / ISO 27001 A.8.15 audit evidence.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id               BIGSERIAL    PRIMARY KEY,
  action           VARCHAR(64)  NOT NULL,                        -- IDENTITY_LINK, IDENTITY_UNLINK, IDENTITY_LIST
  actor            VARCHAR(255) NOT NULL,                        -- service or operator identifier
  canonical_user_id VARCHAR(26),                                 -- affected canonical user
  vendor           vendor_enum,                                  -- affected vendor (if applicable)
  vendor_user_id   VARCHAR(255),                                 -- affected vendor user (if applicable)
  metadata         JSONB,                                        -- additional context (e.g. backfilled shot count)
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_canonical_user_id_created
  ON audit_log (canonical_user_id, created_at DESC)
  WHERE canonical_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_action_created
  ON audit_log (action, created_at DESC);
