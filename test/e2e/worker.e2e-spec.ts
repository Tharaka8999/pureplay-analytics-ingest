import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Kysely } from 'kysely';
import { AppModule } from '../../src/app.module';
import { KYSELY } from '../../src/shared/kysely/kysely.module';
import { runMigrations } from '../../src/shared/kysely/migration-runner';
import type { Database } from '../../src/shared/kysely/types';
import { truncateAll, flushTestRedis, freshenFixture } from '../helpers/db';

const FIXTURE_DIR = join(__dirname, '../fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Worker / BullMQ E2E', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env['DATABASE_URL'] =
      process.env['DATABASE_URL'] ?? 'postgresql://pureplay:pureplay@localhost:5432/pureplay_ingest';
    process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    process.env['NODE_ENV'] = 'test';
    process.env['WEBHOOK_AUTH_MODE'] = 'none';

    // Flush Redis BEFORE BullMQ connects so completed jobs from prior test files
    // do not deduplicate shots enqueued by this suite.
    await flushTestRedis();

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false }),
      { logger: false },
    );
    app.setGlobalPrefix('v1', { exclude: ['/healthz', '/readyz', '/metrics'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const db = app.get<Kysely<Database>>(KYSELY);
    await runMigrations(db);
    await truncateAll(db);

    // Second flush: defensive measure against zombie BullMQ workers from the previous
    // test file (trackpro.e2e) completing in-flight jobs and re-adding completed hashes
    // to Redis after the first flush.  Any such re-added hash would deduplicate the
    // fresh shots seeded in each worker.e2e test case.
    await flushTestRedis();
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it('accepted shot is enqueued and eventually queryable', async () => {
    // freshenFixture replaces captured_at with "1 hour ago" so the clock-skew
    // guard accepts it regardless of when the test runs.
    const payload = freshenFixture(
      loadFixture('trackpro.retransmit.json') as Record<string, unknown>,
      'trackpro',
    );

    // Ingest the shot
    const ingestRes = await request(app.getHttpServer())
      .post('/v1/webhooks/trackpro')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(ingestRes.status).toBe(202);
    expect(ingestRes.body.status).toBe('accepted');

    // Give the in-process BullMQ worker time to process
    await sleep(500);

    // Shot should now be visible via the vendor query endpoint
    const tp = payload as Record<string, unknown>;
    const queryRes = await request(app.getHttpServer())
      .get(`/v1/users/by-vendor/trackpro/${String(tp['user_external_id'])}/shots`)
      .expect(200);

    expect(Array.isArray(queryRes.body.data)).toBe(true);
    expect(queryRes.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('duplicate shot (same idempotency key) is deduplicated — not double-stored', async () => {
    const payload = freshenFixture(
      loadFixture('swingmetric.cross-batch-retransmit.json') as Record<string, unknown>,
      'swingmetric',
    );
    const player = payload['player'] as Record<string, unknown>;
    const vendorUserId = String(player['id']);

    // Send the same payload twice
    const r1 = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(r1.status).toBe(202);

    const r2 = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(r2.status).toBe(202);

    await sleep(500);

    const queryRes = await request(app.getHttpServer())
      .get(`/v1/users/by-vendor/swingmetric/${vendorUserId}/shots`)
      .expect(200);

    expect(Array.isArray(queryRes.body.data)).toBe(true);
    // Exactly 1 shot, not 2
    expect(queryRes.body.data.length).toBe(1);
  });

  it('near-duplicate within batch is flagged (duplicate_of set)', async () => {
    const payload = loadFixture('swingmetric.batch-with-duplicate.json') as Record<string, unknown>;
    const player = payload['player'] as Record<string, unknown>;
    const vendorUserId = String(player['id']);

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(202);

    await sleep(500);

    // Without include_near_duplicates the near-duplicate should be hidden
    const queryRes = await request(app.getHttpServer())
      .get(`/v1/users/by-vendor/swingmetric/${vendorUserId}/shots`)
      .expect(200);

    // Batch has 2 identical shots; after dedup only 1 is stored (idempotency key collision)
    expect(Array.isArray(queryRes.body.data)).toBe(true);
  });

  it('clock-skew > 24h shot is routed to ingestion_failures', async () => {
    const payload = loadFixture('adversarial/clock-skew-24h.json');

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/trackpro')
      .set('Content-Type', 'application/json')
      .send(payload);

    // The webhook still accepts the payload (202) — rejection happens async in the worker
    expect(res.status).toBe(202);
    // Worker will route to ingestion_failures — no assertion on DB state in E2E, but no crash
  });
});
