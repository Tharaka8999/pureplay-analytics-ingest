import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import Redis from 'ioredis';
import { runMigrations } from '../../src/shared/kysely/migration-runner';
import type { Database } from '../../src/shared/kysely/types';

const TEST_DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://pureplay:pureplay@localhost:5432/pureplay_ingest';

const TEST_REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// Configure timestamp type parsers (mirrors kysely.module.ts).
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (val: string) =>
  val ? new Date(val).toISOString() : null,
);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (val: string) =>
  val ? new Date(val).toISOString() : null,
);

export async function createTestKysely(): Promise<Kysely<Database>> {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(db);
  return db;
}

export async function truncateAll(db: Kysely<Database>): Promise<void> {
  // Order matters: ingestion_failures has no FK, shots has self-referencing FK.
  // Delete dependent rows first to avoid FK violations.
  await db.deleteFrom('ingestion_failures').execute();
  await db.updateTable('shots').set({ duplicate_of: null }).execute();
  await db.deleteFrom('shots').execute();
}

export async function flushTestRedis(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
  await redis.flushdb();
  redis.disconnect();
}

/**
 * Replaces the vendor-specific captured-at timestamp in a fixture with a time
 * that is guaranteed to be within the processor's 24h clock-skew window.
 *
 * Static fixture files use dates from when they were authored; after 24 hours
 * the processor rejects them as CLOCK_SKEW_EXCESSIVE.  This helper refreshes
 * the timestamp to 1 hour ago so fixtures remain valid indefinitely.
 *
 * The adversarial clock-skew fixture intentionally keeps its 2020 date — do
 * NOT pass it through this helper.
 */
export function freshenFixture(
  payload: Record<string, unknown>,
  vendor: 'trackpro' | 'swingmetric' | 'proswing',
): Record<string, unknown> {
  // 1 hour ago is always within the 24h window and never in the future.
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();

  switch (vendor) {
    case 'trackpro':
      return { ...payload, captured_at: oneHourAgo };

    case 'proswing': {
      const data = payload['data'] as Record<string, unknown>;
      const shot = data['shot'] as Record<string, unknown>;
      // Preserve the original tz offset string (e.g. "+10:00") so the parser can
      // derive captured_at_tz_offset_min correctly.  We rewrite only the date/time
      // part while keeping whatever suffix the fixture declared.
      const existingOccurredAt = shot['occurred_at'] as string ?? oneHourAgo;
      const tzSuffixMatch = /([+-]\d{2}:\d{2})$/.exec(existingOccurredAt);
      const tzSuffix = tzSuffixMatch?.[1] ?? '+00:00';
      const offsetMinutes = tzSuffix === '+00:00'
        ? 0
        : (parseInt(tzSuffix.slice(1, 3), 10) * 60 + parseInt(tzSuffix.slice(4, 6), 10)) *
          (tzSuffix[0] === '-' ? -1 : 1);
      // Express the "1 hour ago" moment in the fixture's original local timezone.
      const localMs = Date.now() - 3_600_000 + offsetMinutes * 60_000;
      const local = new Date(localMs).toISOString().slice(0, 19); // "YYYY-MM-DDTHH:mm:ss"
      const freshOccurredAt = `${local}${tzSuffix}`;
      return {
        ...payload,
        data: { ...data, shot: { ...shot, occurred_at: freshOccurredAt } },
      };
    }

    case 'swingmetric': {
      const shots = payload['shots'] as Array<Record<string, unknown>>;
      const tsMs = Date.now() - 3_600_000;
      return {
        ...payload,
        shots: shots.map((s) => ({ ...s, ts_ms: tsMs })),
      };
    }
  }
}
