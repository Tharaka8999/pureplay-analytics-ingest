import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { type Kysely } from 'kysely';
import type { Database as DB } from '../../src/shared/kysely/types';
import { ShotRepository } from '../../src/ingestion/shot-repository';
import type { NormalisedShot } from '../../src/shared/domain/shot';
import { createTestKysely, truncateAll } from '../helpers/db';

function makeShot(overrides: Partial<NormalisedShot> = {}): NormalisedShot {
  return {
    canonical_shot_id: 'ulid-001',
    vendor: 'trackpro',
    vendor_shot_id: 'tp-2024-01-01-abcd0001',
    idempotency_key: 'tp|tp-2024-01-01-abcd0001',
    vendor_user_id: 'user-tp-001',
    canonical_user_id: null,
    captured_at_utc: '2024-03-15T10:30:00.000Z',
    captured_at_tz_offset_min: null,
    received_at_utc: '2024-03-15T10:30:05.000Z',
    club_code: '7I',
    club_raw: '7 Iron',
    ball_speed_mps: 57.9,
    club_head_speed_mps: 42.5,
    launch_angle_deg: 17.8,
    spin_rpm: 6500,
    carry_m: 142.3,
    total_m: 148.0,
    lateral_m: -1.2,
    device_id: 'device-001',
    session_id: 'session-001',
    content_hash: 'aaaa' + 'b'.repeat(60),
    raw_payload: { original: true },
    schema_version: 1,
    parser_version: '1.0.0',
    duplicate_of: null,
    ...overrides,
  };
}

describe('ShotRepository', () => {
  let db: Kysely<DB>;
  let repo: ShotRepository;

  beforeAll(async () => {
    db = await createTestKysely();
  });

  beforeEach(async () => {
    await truncateAll(db);
    repo = new ShotRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe('upsertIfNew', () => {
    it('inserts a new shot and returns inserted=true', async () => {
      const shot = makeShot();
      const result = await repo.upsertIfNew(shot);
      expect(result.inserted).toBe(true);
      expect(result.canonical_shot_id).toBe(shot.canonical_shot_id);
    });

    it('second upsert with same idempotency_key returns inserted=false', async () => {
      const shot = makeShot();
      await repo.upsertIfNew(shot);
      const result2 = await repo.upsertIfNew({ ...shot, canonical_shot_id: 'ulid-002' });
      expect(result2.inserted).toBe(false);
      expect(result2.canonical_shot_id).toBe(shot.canonical_shot_id);
    });

    it('persists all NormalisedShot fields correctly', async () => {
      const shot = makeShot();
      await repo.upsertIfNew(shot);

      const rows = await db.selectFrom('shots').selectAll().execute();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.canonical_shot_id).toBe(shot.canonical_shot_id);
      expect(row.vendor).toBe(shot.vendor);
      expect(row.club_code).toBe(shot.club_code);
      expect(Number(row.ball_speed_mps)).toBeCloseTo(shot.ball_speed_mps, 3);
      expect(Number(row.carry_m)).toBeCloseTo(shot.carry_m, 2);
    });

    it('allows different vendors to have same idempotency_key structure', async () => {
      const shot1 = makeShot({ vendor: 'trackpro', idempotency_key: 'tp|same-key', canonical_shot_id: 'ulid-tp' });
      const shot2 = makeShot({ vendor: 'swingmetric', idempotency_key: 'sm|same-key', canonical_shot_id: 'ulid-sm' });
      const r1 = await repo.upsertIfNew(shot1);
      const r2 = await repo.upsertIfNew(shot2);
      expect(r1.inserted).toBe(true);
      expect(r2.inserted).toBe(true);
    });
  });

  describe('checkAndFlagNearDuplicates', () => {
    it('sets duplicate_of on second shot with matching content_hash within 60s', async () => {
      const contentHash = 'dead' + 'b'.repeat(60);
      const shot1 = makeShot({
        canonical_shot_id: 'ulid-a',
        idempotency_key: 'tp|shot-a',
        content_hash: contentHash,
        captured_at_utc: '2024-03-15T10:30:00.000Z',
      });
      const shot2 = makeShot({
        canonical_shot_id: 'ulid-b',
        idempotency_key: 'tp|shot-b',
        content_hash: contentHash,
        captured_at_utc: '2024-03-15T10:30:30.000Z',
      });

      await repo.upsertIfNew(shot1);
      await repo.upsertIfNew(shot2);
      await repo.checkAndFlagNearDuplicates(shot2);

      const row = await db
        .selectFrom('shots')
        .select(['canonical_shot_id', 'duplicate_of'])
        .where('canonical_shot_id', '=', 'ulid-b')
        .executeTakeFirstOrThrow();

      expect(row.duplicate_of).toBe('ulid-a');
    });

    it('does NOT set duplicate_of when shots are more than 60s apart', async () => {
      const contentHash = 'cafe' + 'b'.repeat(60);
      const shot1 = makeShot({
        canonical_shot_id: 'ulid-a',
        idempotency_key: 'tp|shot-a',
        content_hash: contentHash,
        captured_at_utc: '2024-03-15T10:30:00.000Z',
      });
      const shot2 = makeShot({
        canonical_shot_id: 'ulid-b',
        idempotency_key: 'tp|shot-b',
        content_hash: contentHash,
        captured_at_utc: '2024-03-15T10:31:05.000Z',
      });

      await repo.upsertIfNew(shot1);
      await repo.upsertIfNew(shot2);
      await repo.checkAndFlagNearDuplicates(shot2);

      const row = await db
        .selectFrom('shots')
        .select('duplicate_of')
        .where('canonical_shot_id', '=', 'ulid-b')
        .executeTakeFirstOrThrow();

      expect(row.duplicate_of).toBeNull();
    });

    it('does NOT flag when content_hash differs', async () => {
      const shot1 = makeShot({
        canonical_shot_id: 'ulid-a',
        idempotency_key: 'tp|shot-a',
        content_hash: 'aaa' + 'a'.repeat(61),
        captured_at_utc: '2024-03-15T10:30:00.000Z',
      });
      const shot2 = makeShot({
        canonical_shot_id: 'ulid-b',
        idempotency_key: 'tp|shot-b',
        content_hash: 'bbb' + 'b'.repeat(61),
        captured_at_utc: '2024-03-15T10:30:10.000Z',
      });

      await repo.upsertIfNew(shot1);
      await repo.upsertIfNew(shot2);
      await repo.checkAndFlagNearDuplicates(shot2);

      const row = await db
        .selectFrom('shots')
        .select('duplicate_of')
        .where('canonical_shot_id', '=', 'ulid-b')
        .executeTakeFirstOrThrow();

      expect(row.duplicate_of).toBeNull();
    });
  });

  describe('recordIngestionFailure', () => {
    it('writes a row to ingestion_failures with correlation_id', async () => {
      await repo.recordIngestionFailure({
        vendor: 'trackpro',
        received_at_utc: '2024-03-15T10:30:00.000Z',
        raw_body: '{"redacted":true}',
        http_status: 400,
        error_code: 'PAYLOAD_VALIDATION_FAILED',
        error_detail: null,
        correlation_id: 'corr-uuid-001',
      });

      const rows = await db.selectFrom('ingestion_failures').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.correlation_id).toBe('corr-uuid-001');
      expect(rows[0]!.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
    });
  });
});
