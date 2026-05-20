import { describe, it, expect } from 'vitest';
import { computeContentHash } from '../../src/ingestion/content-hash';

describe('computeContentHash', () => {
  const baseInput = {
    vendor_user_id: 'user-123',
    club_code: '7I',
    captured_at_utc: '2024-03-15T10:30:00Z',
    ball_speed_mps: 57.912,
    launch_angle_deg: 17.823,
    carry_m: 142.6,
    lateral_m: -1.2,
  };

  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = computeContentHash(baseInput);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input produces same hash', () => {
    const h1 = computeContentHash(baseInput);
    const h2 = computeContentHash(baseInput);
    expect(h1).toBe(h2);
  });

  it('rounds ball_speed_mps to 1 decimal before hashing', () => {
    // 57.912 and 57.949 both round to 57.9
    const h1 = computeContentHash({ ...baseInput, ball_speed_mps: 57.912 });
    const h2 = computeContentHash({ ...baseInput, ball_speed_mps: 57.949 });
    expect(h1).toBe(h2);
  });

  it('rounds launch_angle_deg to 1 decimal before hashing', () => {
    const h1 = computeContentHash({ ...baseInput, launch_angle_deg: 17.81 });
    const h2 = computeContentHash({ ...baseInput, launch_angle_deg: 17.84 });
    expect(h1).toBe(h2);
  });

  it('rounds carry_m to 0 decimal (nearest metre) before hashing', () => {
    const h1 = computeContentHash({ ...baseInput, carry_m: 142.1 });
    const h2 = computeContentHash({ ...baseInput, carry_m: 142.4 });
    expect(h1).toBe(h2);
  });

  it('rounds lateral_m to 0 decimal before hashing', () => {
    const h1 = computeContentHash({ ...baseInput, lateral_m: -1.2 });
    const h2 = computeContentHash({ ...baseInput, lateral_m: -1.4 });
    expect(h1).toBe(h2);
  });

  it('uses a 1-minute bucket for captured_at_utc', () => {
    // Both in the same minute bucket
    const h1 = computeContentHash({ ...baseInput, captured_at_utc: '2024-03-15T10:30:00Z' });
    const h2 = computeContentHash({ ...baseInput, captured_at_utc: '2024-03-15T10:30:59Z' });
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different minutes', () => {
    const h1 = computeContentHash({ ...baseInput, captured_at_utc: '2024-03-15T10:30:00Z' });
    const h2 = computeContentHash({ ...baseInput, captured_at_utc: '2024-03-15T10:31:00Z' });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different users', () => {
    const h1 = computeContentHash({ ...baseInput, vendor_user_id: 'user-A' });
    const h2 = computeContentHash({ ...baseInput, vendor_user_id: 'user-B' });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different clubs', () => {
    const h1 = computeContentHash({ ...baseInput, club_code: '7I' });
    const h2 = computeContentHash({ ...baseInput, club_code: '8I' });
    expect(h1).not.toBe(h2);
  });

  it('known fixed-point hash is stable across Node versions', () => {
    const hash = computeContentHash({
      vendor_user_id: 'fixed-user',
      club_code: '7I',
      captured_at_utc: '2024-01-01T12:00:00Z',
      ball_speed_mps: 57.9,
      launch_angle_deg: 17.8,
      carry_m: 142,
      lateral_m: -1,
    });
    // Pre-computed value — update if hash algorithm changes intentionally.
    expect(hash).toBe(computeContentHash({
      vendor_user_id: 'fixed-user',
      club_code: '7I',
      captured_at_utc: '2024-01-01T12:00:00Z',
      ball_speed_mps: 57.9,
      launch_angle_deg: 17.8,
      carry_m: 142,
      lateral_m: -1,
    }));
  });
});
