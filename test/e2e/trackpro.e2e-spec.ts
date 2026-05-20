import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import request from "supertest";
import { readFileSync } from "fs";
import { join } from "path";
import type { Kysely } from "kysely";
import { AppModule } from "../../src/app.module";
import { KYSELY } from "../../src/shared/kysely/kysely.module";
import { runMigrations } from "../../src/shared/kysely/migration-runner";
import type { Database } from "../../src/shared/kysely/types";
import { truncateAll, flushTestRedis } from "../helpers/db";

const FIXTURE_DIR = join(__dirname, "../fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

describe("TrackPro E2E", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env["DATABASE_URL"] =
      process.env["DATABASE_URL"] ??
      "postgresql://pureplay:pureplay@localhost:5432/pureplay_ingest";
    process.env["REDIS_URL"] =
      process.env["REDIS_URL"] ?? "redis://localhost:6379";
    process.env["NODE_ENV"] = "test";
    process.env["WEBHOOK_AUTH_MODE"] = "none";

    // Flush Redis BEFORE BullMQ connects so completed jobs from prior test files
    // do not deduplicate shots enqueued by this suite.
    await flushTestRedis();

    app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ logger: false }),
      { logger: false },
    );
    app.setGlobalPrefix("v1", { exclude: ["/healthz", "/readyz", "/metrics"] });
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

  it("POST /webhooks/trackpro with valid payload → 202 accepted", async () => {
    const payload = loadFixture("trackpro.retransmit.json");
    const res = await request(app.getHttpServer())
      .post("/v1/webhooks/trackpro")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
    expect(res.body.correlation_id).toBeDefined();
  });

  it("POST /webhooks/trackpro with invalid payload → 400 with issues[]", async () => {
    // ball_speed_mps > 120 (physical maximum) — schema rejects it
    const payload = {
      ...(loadFixture("trackpro.retransmit.json") as Record<string, unknown>),
      ball_speed_mps: 150,
    };
    const res = await request(app.getHttpServer())
      .post("/v1/webhooks/trackpro")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe("PAYLOAD_VALIDATION_FAILED");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("POST /webhooks/trackpro with adversarial unit-mistag → 400", async () => {
    // TrackPro sends SI (mps); a value > 120 mps exceeds the physical maximum
    const payload = {
      ...(loadFixture("trackpro.retransmit.json") as Record<string, unknown>),
      ball_speed_mps: 150,
    };
    const res = await request(app.getHttpServer())
      .post("/v1/webhooks/trackpro")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(400);
  });
});
