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

describe('ProSwing E2E', () => {
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
    // After app.close() the BullMQ worker has finished any in-flight job and marked
    // it completed — which re-adds the job hash to Redis (removeOnComplete: { age }).
    // Flush now so the next test file (query.e2e-spec.ts) starts with a clean slate
    // and its freshenFixture() seeds are never deduplicated against a stale hash.
    await flushTestRedis();
  });

  it('POST /webhooks/proswing with tz-offset payload → 202 accepted', async () => {
    const payload = loadFixture('proswing.tz-offset.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.correlation_id).toBeDefined();
  });

  it('POST /webhooks/proswing with adversarial unit-mistag (mps > 120) → 400', async () => {
    // unit-mistag fixture has ball_speed value=180 unit=mps — far exceeds 120 mps physical max
    const payload = loadFixture('adversarial/unit-mistag.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it('POST /webhooks/proswing with missing required field → 400', async () => {
    const payload = {
      type: 'shot.recorded',
      data: {
        shot: {
          id: 'ps-missing-field',
          occurred_at: '2024-03-15T10:00:00Z',
          club: '7I',
          // missing ball_speed
          launch_angle: 17.8,
          carry: { value: 155.6, unit: 'yd' },
          deviation: { value: -4.0, unit: 'ft' },
        },
        player: { id: 'ps-player-test' },
        device: { id: 'ps-device-test' },
      },
    };

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });

  it('POST /webhooks/proswing with unknown speed unit → 202 (schema accepts enum)', async () => {
    // The schema validates unit is one of mph/kph/mps — unknown unit should 400
    const base = loadFixture('proswing.tz-offset.json') as Record<string, unknown>;
    const data = base['data'] as Record<string, unknown>;
    const shot = data['shot'] as Record<string, unknown>;
    const badPayload = {
      ...base,
      data: {
        ...data,
        shot: {
          ...shot,
          ball_speed: { value: 129.5, unit: 'knots' },
        },
      },
    };

    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(badPayload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });

  // ─── V2 schema (flat scalar fields) ─────────────────────────────────────────

  it('POST /webhooks/proswing with V2 payload (ball_speed_mph/launch_deg/carry_yd/deviation_yd) → 202', async () => {
    const payload = loadFixture('proswing.v2.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.correlation_id).toBeDefined();
  });

  it('POST /webhooks/proswing V2 payload with ball_speed_kph → 202', async () => {
    const payload = {
      type: 'shot.recorded',
      data: {
        user_token: 'ps_tok_e2e_kph_test12',
        shot: {
          id: `ps-e2e-kph-${Date.now()}`,
          occurred_at: new Date().toISOString(),
          club_code: '5I',
          ball_speed_kph: 214.0,
          launch_deg: 20.5,
          carry_yd: 172.0,
          deviation_yd: -1.2,
        },
      },
    };
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
  });

  // ─── V3 schema (player/device envelope + scalar launch_angle + spin_rpm) ────

  it('POST /webhooks/proswing with V3 payload (player/device + launch_angle + spin_rpm) → 202', async () => {
    const payload = loadFixture('proswing.v3.json');
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.correlation_id).toBeDefined();
  });

  it('POST /webhooks/proswing V3 payload without device (device optional) → 202', async () => {
    const payload = {
      type: 'shot.recorded',
      data: {
        player: { id: 'ps-v3-no-device-player' },
        shot: {
          id: `ps-v3-no-dev-${Date.now()}`,
          occurred_at: new Date().toISOString(),
          club_code: '5I',
          ball_speed: { value: 132.0, unit: 'mph' },
          launch_angle: 19.0,
          carry: { value: 168.0, unit: 'yd' },
          deviation: { value: 1.5, unit: 'yd' },
        },
      },
    };
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
  });

  it('POST /webhooks/proswing V3 payload ball_speed mps > 120 → 400', async () => {
    const payload = {
      type: 'shot.recorded',
      data: {
        player: { id: 'ps-v3-mistag-player1' },
        device: { id: 'ps-v3-device-mistag' },
        shot: {
          id: `ps-v3-mistag-${Date.now()}`,
          occurred_at: new Date().toISOString(),
          club_code: 'DR',
          ball_speed: { value: 180.0, unit: 'mps' },
          launch_angle: 11.0,
          carry: { value: 240.0, unit: 'yd' },
          deviation: { value: 2.0, unit: 'yd' },
        },
      },
    };
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });

  it('POST /webhooks/proswing V2 payload ball_speed_mps > 120 (unit-mistag) → 400', async () => {
    const payload = {
      type: 'shot.recorded',
      data: {
        user_token: 'ps_tok_e2e_mistag_tst',
        shot: {
          id: `ps-e2e-mistag-${Date.now()}`,
          occurred_at: new Date().toISOString(),
          club_code: 'DR',
          ball_speed_mps: 180.0,
          launch_deg: 11.0,
          carry_yd: 240.0,
          deviation_yd: 2.0,
        },
      },
    };
    const res = await request(app.getHttpServer())
      .post('/v1/webhooks/proswing')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe('PAYLOAD_VALIDATION_FAILED');
  });
});
