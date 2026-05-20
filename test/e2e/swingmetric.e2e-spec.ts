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
import { truncateAll, flushTestRedis } from '../helpers/db';

const FIXTURE_DIR = join(__dirname, '../fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8'));
}

describe('SwingMetric E2E', () => {
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
  }, 30000);

  afterAll(async () => {
    await app?.close();
    // Flush Redis after close so any BullMQ job hash that was completed during
    // shutdown does not linger and deduplicate the next test file's fresh seeds.
    await flushTestRedis();
  });

  it('POST /webhooks/swingmetric with batch payload → 202 accepted', async () => {
    const payload = loadFixture('swingmetric.batch-with-duplicate.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.correlation_id).toBeDefined();
  });

  it('POST /webhooks/swingmetric with cross-batch retransmit → 202 accepted', async () => {
    const payload = loadFixture('swingmetric.cross-batch-retransmit.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
  });

  it('POST /webhooks/swingmetric with empty shots array → 400', async () => {
    const payload = loadFixture('adversarial/empty-batch.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('POST /webhooks/swingmetric with ball_speed_mph over max → 400', async () => {
    const base = loadFixture('swingmetric.batch-with-duplicate.json') as Record<string, unknown>;
    const shots = (base['shots'] as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      ball_speed_mph: 350,
    }));
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send({ ...base, shots });

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });

  it('POST /webhooks/swingmetric with missing required field → 400', async () => {
    const payload = {
      session: {
        session_id: 'sm-test',
        player: { id: 'sm-player-test' },
        device: 'DEVICE-001',
      },
      shots: [
        {
          ts_ms: 1710499800000,
          // missing club
          ball_speed_mph: 129.5,
          launch_angle: 17.8,
          carry_yd: 155.0,
          offline_yd: -1.3,
        },
      ],
    };

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });

  // ─── V2 schema (alternate field names) ──────────────────────────────────────

  it('POST /webhooks/swingmetric with V2 payload (club/launch_angle/carry_yd/offline_yd) → 202', async () => {
    const payload = loadFixture('swingmetric.v2.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.correlation_id).toBeDefined();
  });

  it('POST /webhooks/swingmetric V2 payload missing launch_angle → 400', async () => {
    const payload = {
      session_id: 'sm-v2-no-launch',
      player: { id: 'sm-player-no-launch' },
      device: 'DEVICE-001',
      shots: [
        { ts_ms: Date.now(), club: '7I', ball_speed_mph: 121.5, carry_yd: 158.0, offline_yd: -2.1 },
      ],
    };
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/swingmetric')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });
});