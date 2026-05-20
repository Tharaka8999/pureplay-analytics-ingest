import { Controller, Get, Inject, Logger } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
} from "@nestjs/terminus";
import { type Kysely, sql } from "kysely";
import type Redis from "ioredis";
import type { Database } from "../shared/kysely/types";
import { KYSELY } from "../shared/kysely/kysely.module";
import { REDIS } from "../shared/redis/redis.module";

@ApiTags("health")
@SkipThrottle()
@Controller()
export class HealthController {
  // NestJS Logger is intercepted by nestjs-pino at the app level — no console.log.
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get("healthz")
  @ApiOperation({
    summary: "Liveness probe",
    description:
      "Returns 200 immediately if the process is alive. No external dependency checks.",
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: { status: "ok", timestamp: "2026-05-19T04:00:00.000Z" },
    },
  })
  liveness(): { status: string; timestamp: string } {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("readyz")
  @HealthCheck()
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Checks Postgres + Redis connectivity. Returns 503 if either is down.",
  })
  @ApiResponse({ status: 200, description: "All dependencies healthy" })
  @ApiResponse({
    status: 503,
    description: "One or more dependencies unhealthy",
  })
  readiness(): Promise<unknown> {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        try {
          await sql`SELECT 1`.execute(this.db);
          return { db: { status: "up" } };
        } catch (err) {
          // [SEC] Log the real error internally; never leak DB error strings to callers.
          this.logger.error({ err }, "Database health check failed");
          return Promise.reject({
            db: { status: "down", error: "db_unavailable" },
          });
        }
      },
      async (): Promise<HealthIndicatorResult> => {
        try {
          const pong = await this.redis.ping();
          if (pong !== "PONG")
            throw new Error(`unexpected Redis response: ${pong}`);
          return { redis: { status: "up" } };
        } catch (err) {
          // [SEC] Log the real error internally; never leak Redis error strings to callers.
          this.logger.error({ err }, "Redis health check failed");
          return Promise.reject({
            redis: { status: "down", error: "redis_unavailable" },
          });
        }
      },
    ]);
  }
}
