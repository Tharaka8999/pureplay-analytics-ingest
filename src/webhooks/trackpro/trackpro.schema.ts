import { z } from 'zod';

export const TrackproPayloadSchema = z
  .object({
    shot_uid: z
      .string()
      .regex(/^tp-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/, 'Invalid shot_uid format'),
    user_external_id: z.string().min(1).max(255),
    session_id: z.string().min(1).max(255).optional(),
    device_id: z.string().min(1).max(255).optional(),
    captured_at: z.string().datetime({ offset: true }),
    club: z.string().min(1).max(64),
    ball_speed_mps: z.number().min(0).max(120),
    club_head_speed_mps: z.number().min(0).max(100).optional(),
    launch_angle_deg: z.number().min(-10).max(70),
    spin_rpm: z.number().int().min(0).max(15000).optional(),
    carry_distance_m: z.number().min(0).max(450),
    total_distance_m: z.number().min(0).max(500).optional(),
    side_deviation_m: z.number().min(-200).max(200),
  })
  .strict();

export type TrackproPayload = z.infer<typeof TrackproPayloadSchema>;
