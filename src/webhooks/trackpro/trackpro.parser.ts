import { monotonicFactory } from "ulidx";
import { normaliseClub } from "../../shared/domain/club-code";
import { computeContentHash } from "../../ingestion/content-hash";
import type { NormalisedShot } from "../../shared/domain/shot";
import type { TrackproPayload } from "./trackpro.schema";
// Re-export schema for unit tests that validate it directly (parsers.spec.ts)
export { TrackproPayloadSchema } from "./trackpro.schema";

const ulid = monotonicFactory();
const PARSER_VERSION = "1.0.0";

/**
 * Convert a validated TrackproPayload into a single NormalisedShot.
 * TrackPro sends SI units natively (m/s, m) — no unit conversion needed.
 */
export function parseTrackpro(
  payload: TrackproPayload,
  receivedAtUtc: string,
): NormalisedShot[] {
  const clubCode = normaliseClub(payload.club);
  const capturedAtUtc = new Date(payload.captured_at).toISOString();

  // TrackPro sends SI units natively — no conversion needed
  const ballSpeedMps = payload.ball_speed_mps;
  const carryM = payload.carry_distance_m;
  const lateralM = payload.side_deviation_m; // right=+ matches house convention

  const shot: NormalisedShot = {
    canonical_shot_id: ulid(),
    vendor: "trackpro",
    vendor_shot_id: payload.shot_uid,
    idempotency_key: `tp|${payload.shot_uid}`,
    vendor_user_id: payload.user_external_id,
    canonical_user_id: null,
    captured_at_utc: capturedAtUtc,
    captured_at_tz_offset_min: null,
    received_at_utc: receivedAtUtc,
    club_code: clubCode,
    club_raw: payload.club,
    ball_speed_mps: ballSpeedMps,
    club_head_speed_mps: payload.club_head_speed_mps ?? null,
    launch_angle_deg: payload.launch_angle_deg,
    spin_rpm: payload.spin_rpm ?? null,
    carry_m: carryM,
    total_m: payload.total_distance_m ?? null,
    lateral_m: lateralM,
    device_id: payload.device_id ?? null,
    session_id: payload.session_id ?? null,
    content_hash: computeContentHash({
      vendor_user_id: payload.user_external_id,
      club_code: clubCode,
      captured_at_utc: capturedAtUtc,
      ball_speed_mps: ballSpeedMps,
      launch_angle_deg: payload.launch_angle_deg,
      carry_m: carryM,
      lateral_m: lateralM,
    }),
    raw_payload: payload as unknown as Record<string, unknown>,
    schema_version: 1,
    parser_version: PARSER_VERSION,
    duplicate_of: null,
  };

  return [shot];
}
