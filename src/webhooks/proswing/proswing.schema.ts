import { z } from 'zod';
import {
  PipeTransform,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { ZodError } from 'zod';

// ─── Shared measurement sub-schemas ──────────────────────────────────────────

/**
 * Ball speed measurement: nested {value, unit}.
 * [SEC] superRefine catches unit-mistag: mps > 120 is physically impossible
 * (world record is ~91 m/s); only a device sending mph values with an 'mps'
 * label reaches this threshold.
 */
export const ProswingBallSpeedSchema = z
  .object({
    value: z.number().min(0).max(500),
    unit: z.enum(['mph', 'kph', 'mps']),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.unit === 'mps' && data.value > 120) {
      ctx.addIssue({
        code: 'custom',
        message: `ball_speed in mps cannot exceed 120 (unit-mistag detected); got ${data.value}`,
      });
    }
  });

/**
 * Club-head speed measurement: nested {value, unit}.
 * Max 300 is generous; physical max for a driver is ~130 mph.
 */
export const ProswingClubSpeedSchema = z
  .object({
    value: z.number().min(0).max(300),
    unit: z.enum(['mph', 'kph', 'mps']),
  })
  .strict();

/**
 * Distance measurement (carry / total / deviation): nested {value, unit}.
 * Range is signed to accommodate left-right deviation.
 */
export const ProswingDistanceSchema = z
  .object({
    value: z.number().min(-500).max(700),
    unit: z.enum(['yd', 'm', 'ft']),
  })
  .strict();

// ─── V1 payload schema (nested {value, unit} measurements) ───────────────────

export const ProswingPayloadSchema = z
  .object({
    type: z.literal('shot.recorded'),
    data: z
      .object({
        user_token: z.string().min(8).max(255),
        shot: z
          .object({
            id: z.string().min(1).max(255),
            // [SEC] datetime validation prevents RangeError in new Date().toISOString()
            occurred_at: z.string().datetime({ offset: true }),
            club_code: z.string().min(1).max(64),
            ball_speed: ProswingBallSpeedSchema,
            club_speed: ProswingClubSpeedSchema.optional(),
            launch: z
              .object({ value: z.number().min(-10).max(90), unit: z.literal('deg') })
              .strict(),
            carry: ProswingDistanceSchema,
            total: ProswingDistanceSchema.optional(),
            deviation: ProswingDistanceSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type ProswingPayload = z.infer<typeof ProswingPayloadSchema>;

// ─── V2 payload schema (flat scalar fields with unit-suffix naming) ───────────

const ProswingShotV2Schema = z
  .object({
    id: z.string().min(1).max(255),
    occurred_at: z.string().datetime({ offset: true }),
    club_code: z.string().min(1).max(64),

    // At least one ball-speed variant required; mps capped at 120 (unit-mistag guard)
    ball_speed_mph: z.number().min(0).max(268).optional(),
    ball_speed_kph: z.number().min(0).max(430).optional(),
    ball_speed_mps: z.number().min(0).max(120).optional(),

    club_speed_mph: z.number().min(0).max(230).optional(),
    club_speed_kph: z.number().min(0).max(370).optional(),
    club_speed_mps: z.number().min(0).max(103).optional(),

    launch_deg: z.number().min(-10).max(90),

    // At least one carry variant required
    carry_yd: z.number().min(0).max(600).optional(),
    carry_m: z.number().min(0).max(550).optional(),
    total_yd: z.number().min(0).max(700).optional(),
    total_m: z.number().min(0).max(640).optional(),

    // At least one deviation variant required
    deviation_yd: z.number().min(-500).max(500).optional(),
    deviation_m: z.number().min(-500).max(500).optional(),
    deviation_ft: z.number().min(-1500).max(1500).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.ball_speed_mph == null && d.ball_speed_kph == null && d.ball_speed_mps == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['ball_speed'],
        message: 'One of ball_speed_mph, ball_speed_kph, or ball_speed_mps is required',
      });
    }
    if (d.carry_yd == null && d.carry_m == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['carry'],
        message: 'One of carry_yd or carry_m is required',
      });
    }
    if (d.deviation_yd == null && d.deviation_m == null && d.deviation_ft == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['deviation'],
        message: 'One of deviation_yd, deviation_m, or deviation_ft is required',
      });
    }
  });

const ProswingPayloadV2Schema = z
  .object({
    type: z.literal('shot.recorded'),
    data: z
      .object({
        user_token: z.string().min(8).max(255),
        shot: ProswingShotV2Schema,
      })
      .strict(),
  })
  .strict();

// ─── V3 payload schema (player/device envelope + scalar launch_angle + spin_rpm) ─

const ProswingShotV3Schema = z
  .object({
    id: z.string().min(1).max(255),
    occurred_at: z.string().datetime({ offset: true }),
    club_code: z.string().min(1).max(64),

    // Ball/club speed reuse the shared schemas (same bounds and unit-mistag guard as V1)
    ball_speed: ProswingBallSpeedSchema,
    club_speed: ProswingClubSpeedSchema.optional(),

    // V3 uses a scalar launch_angle in degrees instead of the nested {value, unit} object
    launch_angle: z.number().min(-10).max(90),

    spin_rpm: z.number().int().min(0).max(15000).optional(),

    carry: ProswingDistanceSchema,
    total: ProswingDistanceSchema.optional(),
    deviation: ProswingDistanceSchema,
  })
  .strict();

const ProswingPayloadV3Schema = z
  .object({
    type: z.literal('shot.recorded'),
    data: z
      .object({
        player: z.object({ id: z.string().min(1).max(255) }).strict(),
        device: z.object({ id: z.string().min(1).max(255) }).strict().optional(),
        shot: ProswingShotV3Schema,
      })
      .strict(),
  })
  .strict();

// ─── Canonical internal types (used by the parser) ────────────────────────────

export interface ProswingCanonicalShot {
  id: string;
  occurred_at: string;
  club_code: string;
  ball_speed: { value: number; unit: 'mph' | 'kph' | 'mps' };
  club_speed?: { value: number; unit: 'mph' | 'kph' | 'mps' };
  launch: { value: number; unit: 'deg' };
  carry: { value: number; unit: 'yd' | 'm' | 'ft' };
  total?: { value: number; unit: 'yd' | 'm' | 'ft' };
  deviation: { value: number; unit: 'yd' | 'm' | 'ft' };
  /** V3 provides spin_rpm; V1/V2 leave this absent (parser defaults to null). */
  spin_rpm?: number;
}

export interface ProswingCanonicalPayload {
  type: 'shot.recorded';
  data: {
    /** Vendor-scoped user identifier. Derived from player.id in V3. */
    user_token: string;
    shot: ProswingCanonicalShot;
  };
}

// ─── Version detection ────────────────────────────────────────────────────────

/**
 * Detect the ProSwing wire-format version by inspecting unique structural markers.
 * O(1) — checks at most two fields before deciding.
 *
 *   V3: data.player exists    (uses player/device envelope instead of user_token)
 *   V2: data.shot has a flat ball_speed_mph / ball_speed_kph / ball_speed_mps field
 *   V1: default               (nested {value, unit} measurement objects)
 */
function detectVersion(raw: unknown): 'v1' | 'v2' | 'v3' {
  if (typeof raw !== 'object' || raw === null) return 'v1';
  const data = (raw as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) return 'v1';

  // V3 marker: player object instead of user_token
  if ('player' in data) return 'v3';

  // V2 marker: flat scalar ball_speed fields in the shot
  const shot = (data as Record<string, unknown>)['shot'];
  if (typeof shot === 'object' && shot !== null) {
    const s = shot as Record<string, unknown>;
    if ('ball_speed_mph' in s || 'ball_speed_kph' in s || 'ball_speed_mps' in s) return 'v2';
  }

  return 'v1';
}

// ─── V2 / V3 → canonical conversion ──────────────────────────────────────────

/** Conditionally spreads a key only when the value is not undefined. */
function ifDefined<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value !== undefined ? ({ [key]: value } as Record<K, V>) : {};
}

type PayloadV2 = z.infer<typeof ProswingPayloadV2Schema>;
type PayloadV3 = z.infer<typeof ProswingPayloadV3Schema>;

function fromV2(p: PayloadV2): ProswingCanonicalPayload {
  const s = p.data.shot;

  // Resolve ball speed — first populated variant wins (mph > kph > mps)
  let ballSpeed: ProswingCanonicalShot['ball_speed'];
  if (s.ball_speed_mph != null) {
    ballSpeed = { value: s.ball_speed_mph, unit: 'mph' };
  } else if (s.ball_speed_kph != null) {
    ballSpeed = { value: s.ball_speed_kph, unit: 'kph' };
  } else {
    ballSpeed = { value: s.ball_speed_mps!, unit: 'mps' };
  }

  // Resolve optional club speed
  let clubSpeed: ProswingCanonicalShot['club_speed'];
  if (s.club_speed_mph != null) {
    clubSpeed = { value: s.club_speed_mph, unit: 'mph' };
  } else if (s.club_speed_kph != null) {
    clubSpeed = { value: s.club_speed_kph, unit: 'kph' };
  } else if (s.club_speed_mps != null) {
    clubSpeed = { value: s.club_speed_mps, unit: 'mps' };
  }

  // Resolve carry — yd takes precedence
  const carry: ProswingCanonicalShot['carry'] =
    s.carry_yd != null ? { value: s.carry_yd, unit: 'yd' } : { value: s.carry_m!, unit: 'm' };

  // Resolve optional total
  let total: ProswingCanonicalShot['total'];
  if (s.total_yd != null) total = { value: s.total_yd, unit: 'yd' };
  else if (s.total_m != null) total = { value: s.total_m, unit: 'm' };

  // Resolve deviation — yd > m > ft
  let deviation: ProswingCanonicalShot['deviation'];
  if (s.deviation_yd != null) deviation = { value: s.deviation_yd, unit: 'yd' };
  else if (s.deviation_m != null) deviation = { value: s.deviation_m, unit: 'm' };
  else deviation = { value: s.deviation_ft!, unit: 'ft' };

  return {
    type: 'shot.recorded',
    data: {
      user_token: p.data.user_token,
      shot: {
        id: s.id,
        occurred_at: s.occurred_at,
        club_code: s.club_code,
        ball_speed: ballSpeed,
        ...ifDefined('club_speed', clubSpeed),
        launch: { value: s.launch_deg, unit: 'deg' },
        carry,
        ...ifDefined('total', total),
        deviation,
      },
    },
  };
}

function fromV3(p: PayloadV3): ProswingCanonicalPayload {
  const s = p.data.shot;
  return {
    type: 'shot.recorded',
    data: {
      user_token: p.data.player.id,
      shot: {
        id: s.id,
        occurred_at: s.occurred_at,
        club_code: s.club_code,
        ball_speed: s.ball_speed,
        ...ifDefined('club_speed', s.club_speed),
        launch: { value: s.launch_angle, unit: 'deg' },
        ...ifDefined('spin_rpm', s.spin_rpm),
        carry: s.carry,
        ...ifDefined('total', s.total),
        deviation: s.deviation,
      },
    },
  };
}

// ─── Public parsing function (used by tests and the pipe below) ───────────────

/**
 * Detect the ProSwing wire-format version, validate against the correct schema,
 * and return a canonical payload.  Throws ZodError on validation failure.
 *
 * Use this function in tests.  The controller uses ProswingValidationPipe which
 * wraps this and converts ZodError to a 400 BadRequestException.
 */
export function parseProswingRaw(raw: unknown): ProswingCanonicalPayload {
  const version = detectVersion(raw);

  if (version === 'v3') {
    const parsed = ProswingPayloadV3Schema.parse(raw); // throws ZodError on failure
    return fromV3(parsed);
  }
  if (version === 'v2') {
    const parsed = ProswingPayloadV2Schema.parse(raw); // throws ZodError
    return fromV2(parsed);
  }
  // V1: schema already uses canonical nested format
  return ProswingPayloadSchema.parse(raw) as ProswingCanonicalPayload;
}

// ─── NestJS validation pipe ───────────────────────────────────────────────────

/**
 * Validates and normalises a raw ProSwing webhook body.
 *
 * Detects the wire-format version (V1 / V2 / V3) by structural inspection,
 * validates against the matching schema, and returns a ProswingCanonicalPayload.
 * Throws 400 BadRequestException with field-level issues on failure.
 *
 * Usage in controller:
 *   @Body(new ProswingValidationPipe()) payload: ProswingCanonicalPayload
 */
export class ProswingValidationPipe implements PipeTransform {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  transform(value: unknown, _metadata: ArgumentMetadata): ProswingCanonicalPayload {
    try {
      return parseProswingRaw(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          error_code: 'PAYLOAD_VALIDATION_FAILED',
          message: 'Request payload validation failed.',
          issues: err.issues.map((e) => ({
            path: e.path.join('.'),
            code: e.code,
            message: e.message,
          })),
        });
      }
      throw err;
    }
  }
}
