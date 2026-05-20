import { createHash } from "crypto";

export interface ContentHashInput {
  vendor_user_id: string;
  club_code: string;
  captured_at_utc: string;
  ball_speed_mps: number;
  launch_angle_deg: number;
  carry_m: number;
  lateral_m: number;
}

function minuteBucket(isoUtc: string): string {
  // Truncates to the minute: "2024-03-15T10:30:45Z" → "2024-03-15T10:30"
  return isoUtc.slice(0, 16);
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function computeContentHash(input: ContentHashInput): string {
  const parts = [
    input.vendor_user_id,
    input.club_code,
    minuteBucket(input.captured_at_utc),
    round(input.ball_speed_mps, 1).toFixed(1),
    round(input.launch_angle_deg, 1).toFixed(1),
    round(input.carry_m, 0).toFixed(0),
    round(input.lateral_m, 0).toFixed(0),
  ];

  return createHash("sha256").update(parts.join("|")).digest("hex");
}
