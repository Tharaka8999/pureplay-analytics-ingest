import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { RequestMethod } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
import { randomUUID } from "crypto";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { Env } from "./config/env.schema";
import { runMigrations } from "./shared/kysely/migration-runner";
import type { Kysely } from "kysely";
import type { Database } from "./shared/kysely/types";
import { KYSELY } from "./shared/kysely/kysely.module";
import { setupOpenApi } from "./shared/openapi/openapi";

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    logger: false, // pino handled by nestjs-pino
    bodyLimit: 5 * 1024 * 1024, // 5 MB
    genReqId: (req: {
      headers: Record<string, string | string[] | undefined>;
    }) => {
      const h = req.headers["x-correlation-id"];
      return (Array.isArray(h) ? h[0] : h) ?? randomUUID();
    },
    requestTimeout: 30_000, // 30s: kills hung upstream connections
    connectionTimeout: 10_000, // 10s: time to establish TCP connection
    keepAliveTimeout: 65_000, // 65s: slightly longer than AWS ALB's 60s
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    {
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // Prefix all routes with /v1 except health/metrics endpoints (tools poll these
  // without a version prefix, and they have no API surface that needs versioning).
  // RouteInfo format (vs string array) is the correct NestJS 11 API; however the two
  // LegacyRouteConverter startup warnings for "/v1/*" are a known NestJS 11 + Fastify 5
  // issue (NestJS internally generates a wildcard for the not-found handler). The
  // auto-conversion succeeds and routing is correct — the warnings are cosmetic.
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "healthz", method: RequestMethod.GET },
      { path: "readyz", method: RequestMethod.GET },
      { path: "metrics", method: RequestMethod.GET },
    ],
  });

  const config = app.get(ConfigService<Env>);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fastify = app.getHttpAdapter().getInstance() as any;

  // G13 — CORS headers
  const corsOrigin = config.get("CORS_ORIGIN", { infer: true }) ?? "*";
  fastify.addHook(
    "onRequest",
    async (
      _request: unknown,
      reply: { header: (k: string, v: string) => void },
    ) => {
      void reply.header("Access-Control-Allow-Origin", corsOrigin);
      void reply.header(
        "Access-Control-Allow-Methods",
        "GET,POST,DELETE,OPTIONS",
      );
      void reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,X-Correlation-ID,X-Webhook-Auth,X-Webhook-Timestamp,X-Webhook-Signature,Idempotency-Key",
      );
      // Explicitly deny credentialed cross-origin requests — this service is an
      // internal API not intended for browser-origin credential sharing.
      void reply.header("Access-Control-Allow-Credentials", "false");
    },
  );
  fastify.addHook(
    "onRequest",
    async (
      request: { method: string },
      reply: { status: (s: number) => { send: () => void } },
    ) => {
      if (request.method === "OPTIONS") {
        void reply.status(204).send();
      }
    },
  );

  // G11 — Capture raw body for HMAC signature verification.
  // Uses preParsing (runs before NestJS registers its own JSON parser) to buffer
  // the incoming stream, store it on req.rawBody, and re-emit it unchanged.
  // Cannot use addContentTypeParser — NestJS would conflict with FST_ERR_CTP_ALREADY_PRESENT.
  fastify.addHook(
    "preParsing",
    async (
      request: unknown,
      _reply: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      const { Readable } = await import("stream");
      const chunks: Buffer[] = [];
      for await (const chunk of payload as AsyncIterable<Buffer | string>) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
        );
      }
      const raw = Buffer.concat(chunks);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (request as any).rawBody = raw;
      // Return a new readable so Fastify's JSON parser can still consume the body
      const stream = new Readable();
      stream.push(raw);
      stream.push(null);
      return stream;
    },
  );

  // G21 — 404 and Fastify-native errors (415, 429 etc.) are handled by
  // GlobalExceptionFilter. NestJS registers its own setNotFoundHandler and
  // setErrorHandler during app.listen(); we must not pre-empt them here or
  // Fastify throws FST_ERR_NOT_FOUND_ALREADY_SET / similar errors.
  // GlobalExceptionFilter.mapStatusToCode already maps 404 → NOT_FOUND,
  // 415 → UNSUPPORTED_MEDIA_TYPE, 429 → TOO_MANY_REQUESTS.

  await (
    fastify as { register: (p: unknown, o?: unknown) => Promise<void> }
  ).register(compress, { global: true });
  await (
    fastify as { register: (p: unknown, o?: unknown) => Promise<void> }
  ).register(helmet, {
    contentSecurityPolicy: false, // API only; CSP is portal concern
  });

  if (config.get("RUN_MIGRATIONS", { infer: true })) {
    const db = app.get<Kysely<Database>>(KYSELY);
    await runMigrations(db);
  }

  // [SEC] Swagger is only mounted outside production.
  // In production the /api/docs endpoint must not exist — it leaks the full API
  // surface and the "Try it out" feature can drive real traffic against the service.
  if (config.get("NODE_ENV", { infer: true }) !== "production") {
    setupOpenApi(app);
  }

  const port = config.get("PORT", { infer: true }) ?? 3000;
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
