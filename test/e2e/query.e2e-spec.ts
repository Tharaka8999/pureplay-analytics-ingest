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
import { truncateAll, flushTestRedis, freshenFixture } from "../helpers/db";

const FIXTURE_DIR = join(__dirname, "../fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Query API E2E", () => {
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
    // (e.g. proswing.e2e-spec.ts) do not deduplicate shots enqueued by this suite.
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

    // Second flush: clears any zombie-completed hashes that re-appeared during the
    // ~300ms elapsed while NestFactory.create + app.init ran.
    await flushTestRedis();

    // Brief sleep so any zombie BullMQ worker from proswing.e2e (the previous test
    // file) that is still completing its in-flight job has time to finish and write
    // its completed-job hash back to Redis.  Observed: the zombie adds 'ps|ps_shot_001'
    // ~3 ms after the second flush runs.  50 ms is conservatively more than enough.
    await sleep(50);

    // Third flush: removes any hash the zombie re-added during the sleep above.
    // After this flush there is no Redis state that could deduplicate the seeds below.
    await flushTestRedis();

    // Seed some shots for query tests.
    // freshenFixture replaces vendor-specific timestamps with "1 hour ago" so
    // the processor's 24h clock-skew window never rejects them as stale.
    const fixtures: Array<{
      url: string;
      vendor: "trackpro" | "swingmetric" | "proswing";
      fixture: string;
    }> = [
      {
        url: "/v1/webhooks/trackpro",
        vendor: "trackpro",
        fixture: "trackpro.retransmit.json",
      },
      {
        url: "/v1/webhooks/swingmetric",
        vendor: "swingmetric",
        fixture: "swingmetric.cross-batch-retransmit.json",
      },
      {
        url: "/v1/webhooks/proswing",
        vendor: "proswing",
        fixture: "proswing.tz-offset.json",
      },
    ];

    for (const { url, vendor, fixture } of fixtures) {
      await request(app.getHttpServer())
        .post(url)
        .set("Content-Type", "application/json")
        .send(
          freshenFixture(
            loadFixture(fixture) as Record<string, unknown>,
            vendor,
          ),
        );
    }

    await sleep(500);
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it("GET /v1/users/by-vendor/trackpro/:id/shots → 200 with data array", async () => {
    const payload = loadFixture("trackpro.retransmit.json") as Record<
      string,
      unknown
    >;
    const vendorUserId = String(payload["user_external_id"]);

    const res = await request(app.getHttpServer())
      .get(`/v1/users/by-vendor/trackpro/${vendorUserId}/shots`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    // raw_payload must be stripped
    const shot = res.body.data[0] as Record<string, unknown>;
    expect(shot["raw_payload"]).toBeUndefined();
    expect(shot["canonical_shot_id"]).toBeDefined();
    expect(shot["vendor"]).toBe("trackpro");
  });

  it("GET /v1/users/by-vendor/proswing/:id/shots → 200 with tz-offset shot", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/users/by-vendor/proswing/ps_tok_b2a14e7c91f0/shots")
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    const shot = res.body.data[0] as Record<string, unknown>;
    expect(shot["vendor"]).toBe("proswing");
    // Timezone offset should be stored (AEST = +600)
    expect(typeof shot["captured_at_tz_offset_min"]).toBe("number");
    expect(shot["captured_at_tz_offset_min"]).toBe(600);
  });

  it("GET /v1/users/by-vendor/swingmetric/:id/shots → 200 with pagination metadata", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/users/by-vendor/swingmetric/swing-user-A/shots")
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    // Pagination meta fields are nested under paging
    expect("paging" in res.body).toBe(true);
    expect("next_cursor" in res.body.paging).toBe(true);
    expect("has_more" in res.body.paging).toBe(true);
  });

  it("GET /v1/users/by-vendor/:vendor/:id/shots with club filter → filtered results", async () => {
    const payload = loadFixture("trackpro.retransmit.json") as Record<
      string,
      unknown
    >;
    const vendorUserId = String(payload["user_external_id"]);

    const resFiltered = await request(app.getHttpServer())
      .get(`/v1/users/by-vendor/trackpro/${vendorUserId}/shots?club=DR`)
      .expect(200);

    expect(Array.isArray(resFiltered.body.data)).toBe(true);
    for (const shot of resFiltered.body.data as Array<
      Record<string, unknown>
    >) {
      expect(shot["club_code"]).toBe("DR");
    }
  });

  it("GET /v1/users/:user_id/shots → 200 (empty when no canonical user)", async () => {
    const res = await request(app.getHttpServer())
      .get("/v1/users/canonical-user-does-not-exist/shots")
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(0);
  });

  it("GET /v1/users/:user_id/stats → 200 with stats structure", async () => {
    const payload = loadFixture("trackpro.retransmit.json") as Record<
      string,
      unknown
    >;
    const vendorUserId = String(payload["player_id"]);

    // Stats are by canonical_user_id; use a user we know has shots via vendor query
    // For this test we verify the endpoint returns the correct structure even for an empty user
    const res = await request(app.getHttpServer())
      .get("/v1/users/some-canonical-user/stats")
      .expect(200);

    expect(res.body).toHaveProperty("by_club");
    expect(res.body).toHaveProperty("totals");
    expect(Array.isArray(res.body.by_club)).toBe(true);
    // Unused vendor_user_id — suppress linter
    void vendorUserId;
  });

  // Health / metrics endpoints are excluded from the /v1 prefix
  it("GET /healthz → 200 liveness", async () => {
    const res = await request(app.getHttpServer()).get("/healthz").expect(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /readyz → 200 readiness", async () => {
    const res = await request(app.getHttpServer()).get("/readyz").expect(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /metrics → 200 Prometheus text", async () => {
    const res = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(typeof res.text).toBe("string");
    expect(res.text).toContain("pureplay_ingest_shots_total");
  });
});
