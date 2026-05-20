import { z } from 'zod';

/**
 * Normalise a raw SwingMetric shot object before validation so both wire formats
 * are accepted by a single strict schema.
 *
 * SwingMetric changed field names between API generations (V1 → V2):
 *   club_used   → club          launch_deg (unchanged) ← launch_angle
 *   carry_yds   → carry_yd      total_yds  → total_yd
 *   offline_yds → offline_yd
 *
 * The old names are destructured out (so .strict() doesn't see them) and the
 * canonical names are written in.  If the canonical name already exists (V2),
 * the ?? short-circuits and leaves it unchanged.
 */
function normaliseShot(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const {
    club_used, // V1 → 'club'
    launch_angle, // V2 → 'launch_deg'
    carry_yds, // V1 → 'carry_yd'
    total_yds, // V1 → 'total_yd'
    offline_yds, // V1 → 'offline_yd'
    ...rest
  } = raw as Record<string, unknown>;
  return {
    ...rest,
    club: rest['club'] ?? club_used,
    launch_deg: rest['launch_deg'] ?? launch_angle,
    carry_yd: rest['carry_yd'] ?? carry_yds,
    total_yd: rest['total_yd'] ?? total_yds,
    offline_yd: rest['offline_yd'] ?? offline_yds,
  };
}

const SwingmetricShotSchema = z.preprocess(
  normaliseShot,
  z
    .object({
      ts_ms: z.number().int().min(0),
      club: z.string().min(1).max(64),
      ball_speed_mph: z.number().min(0).max(268),
      swing_speed_mph: z.number().min(0).max(230).optional(),
      launch_deg: z.number().min(-10).max(70),
      spin_rpm: z.number().int().min(0).max(15000).optional(),
      carry_yd: z.number().min(0).max(490),
      total_yd: z.number().min(0).max(545).optional(),
      offline_yd: z.number().min(-220).max(220),
    })
    .strict(),
);

export const SwingmetricPayloadSchema = z
  .object({
    session_id: z.string().min(1).max(255),
    player: z
      .object({
        id: z.string().min(1).max(255),
        email: z.string().email().max(254).optional(),
      })
      .strict(),
    device: z.string().min(1).max(255),
    shots: z.array(SwingmetricShotSchema).min(1).max(500),
  })
  .strict();

export type SwingmetricPayload = z.infer<typeof SwingmetricPayloadSchema>;
export type SwingmetricShot = z.infer<typeof SwingmetricShotSchema>;
