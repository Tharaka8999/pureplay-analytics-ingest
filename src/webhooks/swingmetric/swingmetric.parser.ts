import { monotonicFactory } from 'ulidx';
import { mphToMps, ydToM } from '../../shared/domain/units';
import { normaliseClub } from '../../shared/domain/club-code';
import { computeContentHash } from '../../ingestion/content-hash';
import type { NormalisedShot } from '../../shared/domain/shot';
import type { SwingmetricPayload, SwingmetricShot } from './swingmetric.schema';
// Re-export schema for unit tests that validate it directly (parsers.spec.ts)
export { SwingmetricPayloadSchema } from './swingmetric.schema';

const ulid = monotonicFactory();
const PARSER_VERSION = '1.0.0';

/**
 * Parse a single normalised shot into a NormalisedShot.
 * All field names are canonical (club, launch_deg, carry_yd, offline_yd) because
 * swingmetric.schema.ts normalises both V1 and V2 wire formats before this runs.
 */
function parseSingleShot(
  shot: SwingmetricShot,
  payload: SwingmetricPayload,
  receivedAtUtc: string,
): NormalisedShot {
  const clubCode = normaliseClub(shot.club);
  const ballSpeedMps = mphToMps(shot.ball_speed_mph);
  const carryM = ydToM(shot.carry_yd);
  const lateralM = ydToM(shot.offline_yd); // right=+ matches house convention
  const capturedAtUtc = new Date(shot.ts_ms).toISOString();

  // 1-second bucket collapses in-batch double-emit and cross-batch retransmit
  const timeBucket = Math.floor(shot.ts_ms / 1000);
  const idempotencyKey = `sm|${payload.player.id}|${payload.device}|${timeBucket}`;

  return {
    canonical_shot_id: ulid(),
    vendor: 'swingmetric',
    vendor_shot_id: null,
    idempotency_key: idempotencyKey,
    vendor_user_id: payload.player.id,
    canonical_user_id: null,
    captured_at_utc: capturedAtUtc,
    captured_at_tz_offset_min: null, // ts_ms is epoch; no wall-clock context
    received_at_utc: receivedAtUtc,
    club_code: clubCode,
    club_raw: shot.club,
    ball_speed_mps: ballSpeedMps,
    club_head_speed_mps:
      shot.swing_speed_mph != null ? mphToMps(shot.swing_speed_mph) : null,
    launch_angle_deg: shot.launch_deg,
    spin_rpm: shot.spin_rpm ?? null,
    carry_m: carryM,
    total_m: shot.total_yd != null ? ydToM(shot.total_yd) : null,
    lateral_m: lateralM,
    device_id: payload.device,
    session_id: payload.session_id,
    content_hash: computeContentHash({
      vendor_user_id: payload.player.id,
      club_code: clubCode,
      captured_at_utc: capturedAtUtc,
      ball_speed_mps: ballSpeedMps,
      launch_angle_deg: shot.launch_deg,
      carry_m: carryM,
      lateral_m: lateralM,
    }),
    // Preserve full provenance: envelope + shot data
    raw_payload: {
      envelope: {
        session_id: payload.session_id,
        player: payload.player,
        device: payload.device,
      },
      shot,
    },
    schema_version: 1,
    parser_version: PARSER_VERSION,
    duplicate_of: null,
  };
}

/**
 * Convert a SwingmetricPayload into an array of NormalisedShots ready for ingestion.
 * Accepts both V1 and V2 wire formats — normalisation happens in swingmetric.schema.ts.
 */
export function parseSwingmetric(
  payload: SwingmetricPayload,
  receivedAtUtc: string,
): NormalisedShot[] {
  return payload.shots.map((shot) =>
    parseSingleShot(shot, payload, receivedAtUtc),
  );
}
