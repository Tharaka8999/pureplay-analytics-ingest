import { InternalServerErrorException } from '@nestjs/common';
import { monotonicFactory } from 'ulidx';
import { mphToMps, kphToMps, mpsToMps, ftToM, ydToM } from '../../shared/domain/units';
import { normaliseClub } from '../../shared/domain/club-code';
import { computeContentHash } from '../../ingestion/content-hash';
import type { NormalisedShot } from '../../shared/domain/shot';
import type { ProswingCanonicalPayload } from './proswing.schema';
// Re-export V1 schema for unit tests that validate it directly (parsers.spec.ts)
export { ProswingPayloadSchema } from './proswing.schema';

const ulid = monotonicFactory();
const PARSER_VERSION = '1.0.0';

/**
 * These defaults are unreachable in practice — the Zod schema enforces enum values
 * before parsing. They exist as a defensive guard against future schema/code drift.
 */
function convertSpeed(value: number, unit: string): number {
  switch (unit) {
    case 'mph': return mphToMps(value);
    case 'kph': return kphToMps(value);
    case 'mps': return mpsToMps(value);
    default:
      // Schema mismatch: Zod enum should have caught this. This is a programmer error.
      throw new InternalServerErrorException(
        `Unhandled speed unit in ProSwing parser: '${unit}'. Update the converter to match the schema.`,
      );
  }
}

function convertDistance(value: number, unit: string): number {
  switch (unit) {
    case 'yd': return ydToM(value);
    case 'm':  return value;
    case 'ft': return ftToM(value);
    default:
      // Schema mismatch: Zod enum should have caught this. This is a programmer error.
      throw new InternalServerErrorException(
        `Unhandled distance unit in ProSwing parser: '${unit}'. Update the converter to match the schema.`,
      );
  }
}

function parseTzOffset(occurred_at: string): { utc: string; offsetMin: number } {
  // Parse ISO-8601 with optional timezone offset, e.g. "2024-03-15T20:30:00+10:00"
  const tzMatch = occurred_at.match(/([+-])(\d{2}):(\d{2})$/);

  if (!tzMatch) {
    // No offset — treat as UTC
    return { utc: new Date(occurred_at).toISOString(), offsetMin: 0 };
  }

  const sign = tzMatch[1] === '+' ? 1 : -1;
  const hours = parseInt(String(tzMatch[2]), 10);
  const minutes = parseInt(String(tzMatch[3]), 10);
  const offsetMin = sign * (hours * 60 + minutes);

  const utc = new Date(occurred_at).toISOString();
  return { utc, offsetMin };
}

/**
 * Convert a ProswingCanonicalPayload (output of any proswingAdapters entry) into
 * a single NormalisedShot.  The canonical type uses the same nested {value, unit}
 * structure as V1, so this parser is adapter-version-agnostic.
 */
export function parseProswing(
  payload: ProswingCanonicalPayload,
  receivedAtUtc: string,
): NormalisedShot[] {
  const { shot, user_token } = payload.data;

  const { utc: capturedAtUtc, offsetMin } = parseTzOffset(shot.occurred_at);
  const clubCode = normaliseClub(shot.club_code);
  const ballSpeedMps = convertSpeed(shot.ball_speed.value, shot.ball_speed.unit);
  const carryM = convertDistance(shot.carry.value, shot.carry.unit);
  const lateralM = convertDistance(shot.deviation.value, shot.deviation.unit);
  const totalM = shot.total
    ? convertDistance(shot.total.value, shot.total.unit)
    : null;
  const clubHeadSpeedMps = shot.club_speed
    ? convertSpeed(shot.club_speed.value, shot.club_speed.unit)
    : null;

  const normalisedShot: NormalisedShot = {
    canonical_shot_id: ulid(),
    vendor: 'proswing',
    vendor_shot_id: shot.id,
    idempotency_key: `ps|${shot.id}`,
    vendor_user_id: user_token,
    canonical_user_id: null,
    captured_at_utc: capturedAtUtc,
    captured_at_tz_offset_min: offsetMin,
    received_at_utc: receivedAtUtc,
    club_code: clubCode,
    club_raw: shot.club_code,
    ball_speed_mps: ballSpeedMps,
    club_head_speed_mps: clubHeadSpeedMps,
    launch_angle_deg: shot.launch.value, // launch is a measurement; .value is the numeric degrees
    spin_rpm: shot.spin_rpm ?? null, // V3 provides spin_rpm; V1/V2 leave it absent → null
    carry_m: carryM,
    total_m: totalM,
    lateral_m: lateralM,
    device_id: null,
    session_id: null,
    content_hash: computeContentHash({
      vendor_user_id: user_token,
      club_code: clubCode,
      captured_at_utc: capturedAtUtc,
      ball_speed_mps: ballSpeedMps,
      launch_angle_deg: shot.launch.value,
      carry_m: carryM,
      lateral_m: lateralM,
    }),
    raw_payload: payload as unknown as Record<string, unknown>,
    schema_version: 1,
    parser_version: PARSER_VERSION,
    duplicate_of: null,
  };

  return [normalisedShot];
}
