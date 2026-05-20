import type { ClubCode } from './club-code';

export type Vendor = 'trackpro' | 'swingmetric' | 'proswing';

export const VALID_VENDORS: readonly Vendor[] = ['trackpro', 'swingmetric', 'proswing'];

export interface NormalisedShot {
  canonical_shot_id: string;
  vendor: Vendor;
  vendor_shot_id: string | null;
  idempotency_key: string;
  vendor_user_id: string;
  canonical_user_id: string | null;
  captured_at_utc: string;
  captured_at_tz_offset_min: number | null;
  received_at_utc: string;
  club_code: ClubCode;
  club_raw: string;
  ball_speed_mps: number;
  club_head_speed_mps: number | null;
  launch_angle_deg: number;
  spin_rpm: number | null;
  carry_m: number;
  total_m: number | null;
  lateral_m: number;
  device_id: string | null;
  session_id: string | null;
  content_hash: string;
  raw_payload: Record<string, unknown>;
  schema_version: number;
  parser_version: string;
  duplicate_of: string | null;
}
