import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import type { Vendor } from '../domain/shot';
import type { ClubCode } from '../domain/club-code';

// Timestamps: pg type parser returns ISO-8601 strings (see kysely.module.ts).
// JSONB columns: pg deserialises to JS object on SELECT; pg driver serialises
// from object on INSERT — do NOT JSON.stringify before passing to Kysely.
// vendor_enum / club_code_enum: Postgres ENUMs map to the same TS union types.

export interface ShotsTable {
  canonical_shot_id: string;                       // VARCHAR(26) — ULID
  vendor: Vendor;                                   // vendor_enum — not plain string
  vendor_shot_id: string | null;
  idempotency_key: string;
  vendor_user_id: string;
  canonical_user_id: string | null;
  captured_at_utc: string;
  captured_at_tz_offset_min: number | null;         // SMALLINT — stored as JS number
  received_at_utc: string;
  club_code: ClubCode;                              // club_code_enum — not plain string
  club_raw: string;
  ball_speed_mps: number;
  club_head_speed_mps: number | null;
  launch_angle_deg: number;
  spin_rpm: number | null;                          // INTEGER — whole RPM; JS number covers it
  carry_m: number;
  total_m: number | null;
  lateral_m: number;
  device_id: string | null;
  session_id: string | null;
  content_hash: string;                             // CHAR(64) — SHA-256 hex
  // [SEC] raw_payload contains the full vendor payload including PII fields.
  // NEVER select or return this field from any controller or service response.
  // It is exclusively used by the ingestion processor for PII-redacted failure logging.
  raw_payload: Record<string, unknown>;             // JSONB — pg deserialises to object
  schema_version: number;                           // SMALLINT
  parser_version: string;
  duplicate_of: string | null;                      // VARCHAR(26) — ULID FK
  created_at: ColumnType<string, never, never>;
}

export interface UserIdentitiesTable {
  id: Generated<number>;
  vendor: Vendor;                                   // vendor_enum
  vendor_user_id: string;
  canonical_user_id: string;                        // VARCHAR(26) — ULID
  created_at: ColumnType<string, never, never>;
  updated_at: ColumnType<string, never, string>;
}

export interface IdentityMergesTable {
  id: Generated<number>;
  from_canonical_user_id: string;                   // VARCHAR(26)
  to_canonical_user_id: string;                     // VARCHAR(26)
  merged_at: string;
  merged_by: string | null;
}

export interface IngestionFailuresTable {
  id: Generated<number>;
  vendor: Vendor;                                   // vendor_enum
  received_at_utc: string;
  raw_body: string;                                 // TEXT — PII-redacted
  http_status: number;                              // SMALLINT — JS number covers it
  error_code: string;
  error_detail: Record<string, unknown> | null;     // JSONB — object, never a JSON string
  correlation_id: string | null;
  created_at: ColumnType<string, never, never>;
}

export interface ClubCodesTable {
  club_code: string;                                  // VARCHAR(8) PRIMARY KEY
  display_name: string;                               // VARCHAR(64)
  category: 'wood' | 'hybrid' | 'iron' | 'wedge' | 'putter' | 'unknown';
  loft_deg_min: number | null;                        // NUMERIC(4,1)
  loft_deg_max: number | null;                        // NUMERIC(4,1)
  excluded_from_distance_stats: boolean;
}

export interface ClubAliasesTable {
  alias: string;                                      // VARCHAR(128) PRIMARY KEY — lowercase, trimmed
  club_code: string;                                  // VARCHAR(8) FK → club_codes
  source: 'seed' | 'ops' | 'auto_suggested';
  confirmed_by: string | null;                        // VARCHAR(255)
  confirmed_at_utc: string | null;                    // TIMESTAMPTZ
  created_at_utc: ColumnType<string, never, never>;
}

export interface UnknownClubAliasesTable {
  alias: string;                                      // VARCHAR(128) PRIMARY KEY — lowercase, trimmed
  first_seen_at_utc: ColumnType<string, never, never>;
  last_seen_at_utc: string;
  seen_count: number;                                 // INTEGER
}

export interface OutboxEventsTable {
  id: Generated<number>;
  event_type: string;                              // e.g. 'shot.persisted'
  payload: Record<string, unknown>;                // JSONB — event data
  created_at: ColumnType<string, never, never>;
}

export interface AuditLogTable {
  id: Generated<number>;
  action: string;                                  // IDENTITY_LINK | IDENTITY_UNLINK | IDENTITY_LIST
  actor: string;                                   // service or operator identifier
  canonical_user_id: string | null;
  vendor: string | null;
  vendor_user_id: string | null;
  metadata: Record<string, unknown> | null;        // JSONB
  created_at: ColumnType<string, never, never>;
}

export interface Database {
  shots: ShotsTable;
  user_identities: UserIdentitiesTable;
  identity_merges: IdentityMergesTable;
  ingestion_failures: IngestionFailuresTable;
  club_codes: ClubCodesTable;
  club_aliases: ClubAliasesTable;
  unknown_club_aliases: UnknownClubAliasesTable;
  outbox_events: OutboxEventsTable;
  audit_log: AuditLogTable;
}

export type Shot = Selectable<ShotsTable>;
export type InsertableShot = Insertable<ShotsTable>;
export type IngestionFailure = Selectable<IngestionFailuresTable>;
export type InsertableIngestionFailure = Insertable<IngestionFailuresTable>;
export type ClubCode_ = Selectable<ClubCodesTable>;
export type ClubAlias = Selectable<ClubAliasesTable>;
export type InsertableClubAlias = Insertable<ClubAliasesTable>;
export type UnknownClubAlias = Selectable<UnknownClubAliasesTable>;
