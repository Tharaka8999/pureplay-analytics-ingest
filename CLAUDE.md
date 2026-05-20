# CLAUDE.md — Pureplay Analytics Ingest

Authoritative guidance for Claude Code working in this repository. Read this file before touching any code. Every rule here exists because violating it has broken something — the reason is included.

---

## Stack (pinned versions)

| Package | Version | Role |
|---|---|---|
| `@nestjs/core` / `@nestjs/platform-fastify` | `^11.1.21` | HTTP framework |
| `fastify` | `^5.8.5` | HTTP server |
| `typescript` | `^5.7.3` | Strict mode, `noUncheckedIndexedAccess` |
| `kysely` | `^0.29.2` | Type-safe query builder (no ORM) |
| `pg` | `^8.14.1` | PostgreSQL driver |
| `bullmq` | `^5.76.10` | Async job queue |
| `ioredis` | `^5.3.2` | Redis client |
| `zod` | `^4.4.3` | Sole validation library — do not introduce class-validator |
| `vitest` | `^4.1.6` | Test runner |
| `supertest` | `^7.2.2` | HTTP assertions in E2E tests |
| `prom-client` | `^15.1.3` | Prometheus metrics |
| `nestjs-pino` | `^4.6.1` | Structured JSON logging |
| `ulidx` | `^2.4.1` | Monotonic ULID generation |
| `@nestjs/swagger` | `^11.4.3` | OpenAPI (dev/staging only) |
| `@opentelemetry/auto-instrumentations-node` | `^0.76.0` | OTel auto-instrumentation |

**Node requirement:** `>=22.0.0` (enforced in `package.json` `engines` field).

**No SQLite.** All tests and all environments use PostgreSQL. `better-sqlite3` is installed as a dev dependency from the original spec but is not used. Ignore it.

---

## Critical rules — never violate

### 1. `crypto.timingSafeEqual` in auth guards

**File:** `src/shared/auth/webhook-auth.guard.ts`, `src/shared/auth/internal-api.guard.ts`

Both guards compare secret keys using `crypto.timingSafeEqual`, not `===`. Replacing with `===` introduces a timing side-channel that lets an attacker brute-force the key by measuring response latency differences.

`timingSafeEqual` requires equal-length buffers. Both guards check `expectedBuf.length !== providedBuf.length` first (definitive rejection, no timing leak) before calling `timingSafeEqual`.

```typescript
// Correct pattern — do not change
const expectedBuf = Buffer.from(expectedKey, 'utf8');
const providedBuf = Buffer.from(providedKey, 'utf8');
if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
  throw new UnauthorizedException(...);
}
```

### 2. Zod v4 API — not Zod v3

This repo uses Zod **v4**. The API is different in several ways:

- Use `.issues` not `.errors` when inspecting a `ZodError`.
- Use `code: 'custom'` (not `code: z.ZodIssueCode.custom`) in `ctx.addIssue()`.
- Array literal for enums: `z.enum(['a', 'b'])` — not `z.enum(MY_ARRAY as [string, ...string[]])`.
- `z.string().min(1)` — use this, not `z.string().nonempty()` (deprecated in v4).

### 3. DATABASE_URL and REDIS_URL must never have defaults

**File:** `src/config/env.schema.ts`

```typescript
DATABASE_URL: z.string().min(1),  // must fail fast if unset
REDIS_URL:    z.string().min(1),  // must fail fast if unset
```

Never add `.default('')` or `.optional()` to these. If the process starts without a database URL it should crash immediately with a clear error message, not connect to nothing and fail silently later.

### 4. Backpressure — check BEFORE enqueue, for batches use `checkBatchCapacity`

**File:** `src/ingestion/shot-ingestion.queue.ts`

`ShotIngestionQueue.enqueue()` already checks `getWaitingCount() >= MAX_QUEUE_DEPTH` and throws `ServiceUnavailableException` with `{ retryAfter: 30 }`. The `GlobalExceptionFilter` maps this to `503 Retry-After: 30`.

For batch ingestion (SwingMetric), call `queue.checkBatchCapacity(shots.length)` BEFORE `Promise.all(shots.map(enqueue))`. The individual per-shot check has a TOCTOU race: all 500 shots in a batch read the queue depth concurrently before any write lands, so a full batch can overflow `MAX_QUEUE_DEPTH` by up to 499. `checkBatchCapacity` adds `batchSize` to the current depth and rejects the whole batch atomically.

### 5. `shot.persisted` event — only on new inserts, via outbox

**File:** `src/ingestion/shot-ingestion.processor.ts`, `src/ingestion/shot-repository.ts`, `src/ingestion/outbox-publisher.service.ts`

The `shot.persisted` event must fire **if and only if** the shot row was newly inserted. It must **never** fire on a deduplicated write (exact or near).

Implementation: `ShotRepository.upsertIfNew()` uses `INSERT … ON CONFLICT (vendor, idempotency_key) DO NOTHING RETURNING canonical_shot_id`. If a row is returned, the shot is new — the repo writes an `outbox_events` row in the **same Kysely transaction**. `OutboxPublisherService` polls the table every 5 seconds, emits the event via `EventEmitter2`, and deletes the row. This is the transactional outbox pattern: the event fires even if the worker crashes mid-job, and never fires on a rolled-back transaction.

Do not bypass the outbox by emitting events directly from the processor. Do not emit events from the API process.

### 6. PII redaction before writing to `ingestion_failures`

**File:** `src/shared/pii-redact.ts`

Every write to `ingestion_failures.raw_body` must go through `redactPii(payload)`. The function:
- Strips RFC5322 email addresses (regex pattern).
- Deletes `player.email`, `user_token`, and `data.user_token` fields from the JSON.

```typescript
// Correct
await shotRepository.recordIngestionFailure({
  raw_body: redactPii(shot.raw_payload),
  ...
});

// Wrong — raw vendor payload may contain email addresses
await shotRepository.recordIngestionFailure({
  raw_body: JSON.stringify(shot.raw_payload),
  ...
});
```

### 7. No `console.log` anywhere in src/

Use NestJS Logger: `private readonly logger = new Logger(ClassName.name)`. Logger output is intercepted by `nestjs-pino` and written as structured JSON. `console.log` bypasses pino and produces unstructured output that breaks log aggregators.

### 8. No `any` without an ESLint disable comment

Every `any` must be preceded by:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
```
Include a brief reason why `any` is necessary at that point (e.g. Fastify's internal type not exported, dynamic Redis pipeline response).

### 9. Production safety guards in `env.schema.ts`

A `.superRefine()` on the env schema blocks startup in `NODE_ENV=production` if:
- `WEBHOOK_AUTH_MODE === 'none'` — all webhooks are unauthenticated
- `THROTTLE_ENABLED === false` — rate limiting is disabled
- `INTERNAL_API_KEY` is not set (or < 32 chars) — internal endpoints are unprotected
- `CORS_ORIGIN === '*'` — any origin can make credentialed requests

These are boot-crash errors, not warnings. Do not add `.optional()` or defaults that bypass them.

### 10. `THROTTLE_ENABLED` uses enum-then-transform, not `z.coerce.boolean()`

`Boolean('false') === true` in JavaScript (non-empty string). The env schema uses `z.enum(['true', 'false']).transform(v => v === 'true').default(true)` to parse `THROTTLE_ENABLED` and `RUN_MIGRATIONS`. Never switch to `z.coerce.boolean()`.

---

## Two-process architecture

The service runs as two separate Node processes built from the same source:

```
src/main.api.ts     → NestFactory(AppModule)    → HTTP :3000
src/main.worker.ts  → NestFactory(WorkerModule) → BullMQ worker loop
```

**`AppModule`** includes: `ConfigModule`, `LoggerModule`, `KyselyModule`, `BullModule.forRootAsync`, `ThrottlerModule`, `WebhooksModule`, `IngestionModule` (queue only), `ShotsModule`, `StatsModule`, `IdentityModule`, `HealthModule`, `MetricsModule`, `EventEmitterModule`.

**`WorkerModule`** includes: `ConfigModule`, `LoggerModule`, `KyselyModule`, `BullModule.forRootAsync`, `IngestionModule` (processor + repository + outbox publisher), `IdentityModule`, `MetricsModule`, `EventEmitterModule`.

`OutboxPublisherService` is registered in `WorkerModule` only — never in `AppModule`. Both processes running the publisher would race to consume and delete the same outbox rows.

**Start commands:**
```bash
pnpm start:api      # node -r ./dist/shared/otel/otel.js dist/main.api.js
pnpm start:worker   # node -r ./dist/shared/otel/otel.js dist/main.worker.js
```

OTel is loaded via `-r` (Node `--require`) before the main module so instrumentation patches are applied before any framework code runs. Do not move `otel.ts` loading inside the NestJS bootstrap.

---

## Full directory map

```
src/
├── main.api.ts               HTTP bootstrap. Registers Fastify hooks for:
│                               - CORS headers (onRequest)
│                               - OPTIONS 204 preflight handler
│                               - rawBody capture (preParsing) for HMAC verification
│                               - compress + helmet plugins
│                             Sets /v1 global prefix; excludes /healthz /readyz /metrics.
├── main.worker.ts            BullMQ worker bootstrap. Same structure, WorkerModule.
│
├── app.module.ts             Root module for API process.
├── worker.module.ts          Root module for worker process.
│
├── config/
│   └── env.schema.ts         Zod env schema + superRefine production guards.
│                             validate() is called by ConfigModule.forRoot().
│
├── shared/
│   ├── auth/
│   │   ├── webhook-auth.guard.ts    WebhookAuthGuard — 3 modes:
│   │   │                              none: always passes (dev only)
│   │   │                              api_key: checks X-Webhook-Auth header
│   │   │                                against {VENDOR}_API_KEY env var
│   │   │                              hmac: verifies HMAC-SHA256 of
│   │   │                                "<timestamp>.<raw-body>" against
│   │   │                                {VENDOR}_HMAC_SECRET env var,
│   │   │                                with 5-minute replay window
│   │   │                            @Vendor('trackpro') decorator sets vendor
│   │   │                            metadata read by the guard via Reflector.
│   │   └── internal-api.guard.ts    InternalApiGuard — checks
│   │                                  Authorization: Bearer <INTERNAL_API_KEY>
│   │                                  on query/stats/identity/metrics endpoints.
│   │                                  timingSafeEqual. In dev without the env
│   │                                  var set, logs a WARNING and passes through.
│   │
│   ├── audit/
│   │   └── audit-log.service.ts     Writes IDENTITY_LINK / IDENTITY_UNLINK /
│   │                                  IDENTITY_LIST events to audit_log table.
│   │                                  Accepts an optional Kysely Transaction so
│   │                                  the audit write is atomic with the identity
│   │                                  mutation (link/unlink run inside a TX).
│   │
│   ├── domain/
│   │   ├── shot.ts                  NormalisedShot interface + Vendor type +
│   │   │                              VALID_VENDORS const.
│   │   ├── club-code.ts             ClubCode enum + normaliseClubCode() function.
│   │   │                              Handles: 'I7' → '7I', '7iron' → '7I',
│   │   │                              'pitching wedge' → 'PW', etc.
│   │   └── units.ts                 Unit conversion functions:
│   │                                  mphToMps, kphToMps, ydToM, ftToM.
│   │
│   ├── errors/
│   │   └── domain-errors.ts         DomainError abstract base + concrete errors:
│   │                                  InvalidCursorError → 400
│   │                                  InvalidDateError → 400
│   │                                  UnknownVendorError → 400
│   │                                  UnknownClubCodeError → 400
│   │                                  IdentityNotFoundError → 404
│   │                                  domainErrorToHttp() mapping function.
│   │
│   ├── idempotency/
│   │   └── idempotency.interceptor.ts  Redis-backed 24h idempotency cache.
│   │                                    Keyed on (path, Idempotency-Key header).
│   │                                    Only caches 2xx responses.
│   │                                    Degrades gracefully if Redis is down.
│   │                                    Applied to POST /users/:id/identities.
│   │
│   ├── kysely/
│   │   ├── kysely.module.ts         KyselyModule — provides Kysely<Database>
│   │   │                              via KYSELY injection token. Uses pg.Pool
│   │   │                              with named imports (not default import).
│   │   ├── migration-runner.ts      Character-by-character SQL splitter that
│   │   │                              handles inline comments and dollar-quoted
│   │   │                              PL/pgSQL blocks. Run via RUN_MIGRATIONS
│   │   │                              env var on startup.
│   │   └── types.ts                 Kysely Database interface — all table types.
│   │
│   ├── metrics/
│   │   ├── ingest-metrics.ts        Lazy singleton Prometheus metrics (see catalog).
│   │   └── metrics.module.ts        Registers MetricsController at /metrics.
│   │                                  Protected by InternalApiGuard.
│   │
│   ├── openapi/
│   │   └── openapi.ts               Mounts Swagger UI at /api/docs.
│   │                                  Only called in non-production environments.
│   │
│   ├── otel/
│   │   └── otel.ts                  OpenTelemetry NodeSDK bootstrap.
│   │                                  Loaded via -r flag before main module.
│   │
│   ├── pino/
│   │   └── logger.module.ts         LoggerModule — nestjs-pino configuration.
│   │                                  JSON output in production, pretty in dev.
│   │
│   ├── redis/
│   │   └── redis.module.ts          RedisModule — provides ioredis client via
│   │                                  REDIS injection token.
│   │                                  maxRetriesPerRequest: null is required.
│   │
│   ├── global-exception.filter.ts   Catches all exceptions and returns RFC 9457
│   │                                  Problem Details JSON. Sets Retry-After: 30
│   │                                  on 503 responses. Maps DomainErrors,
│   │                                  HttpExceptions, and unknown errors.
│   ├── request-id.interceptor.ts    Propagates x-correlation-id from request
│   │                                  headers into the pino log context.
│   └── zod-validation.pipe.ts       ZodValidationPipe — wraps any Zod schema
│                                      into a NestJS PipeTransform. Throws
│                                      BadRequestException on validation failure
│                                      with { error_code, issues } body.
│
├── webhooks/
│   ├── webhooks.module.ts           Registers all three vendor controllers.
│   ├── trackpro/
│   │   ├── trackpro.schema.ts       Zod schema for TrackPro payload.
│   │   │                              Single shot, flat SI fields.
│   │   │                              Idempotency key: tp|{shot_uid}
│   │   ├── trackpro.parser.ts       parseTrackPro() → NormalisedShot[]
│   │   └── trackpro.controller.ts   POST /v1/webhooks/trackpro
│   │                                  @Throttle({ webhook: { ttl:1000, limit:200 } })
│   │                                  @UseGuards(WebhookAuthGuard)
│   │                                  @Vendor('trackpro')
│   │
│   ├── swingmetric/
│   │   ├── swingmetric.schema.ts    Zod schema for SwingMetric payload.
│   │   │                              normaliseShot() preprocessor aliases
│   │   │                              V1 field names to V2: club_used→club,
│   │   │                              carry_yds→carry_yd, offline_yds→offline_yd,
│   │   │                              launch_angle→launch_deg.
│   │   │                              .min(1) on shots array → 400 on empty batch.
│   │   │                              Idempotency key: sm|{player.id}|{device}|{floor(ts_ms/1000)}
│   │   ├── swingmetric.parser.ts    parseSwingmetric() → NormalisedShot[]
│   │   └── swingmetric.controller.ts POST /v1/webhooks/swingmetric
│   │                                  Batch 1–500 shots.
│   │                                  Calls queue.checkBatchCapacity() before
│   │                                  Promise.all(shots.map(enqueue)).
│   │
│   └── proswing/
│       ├── proswing.schema.ts       Zod schema for ProSwing payload.
│       │                              detectVersion(): V3 if data.player exists,
│       │                              V2 if flat ball_speed_mph/kph/mps fields,
│       │                              else V1 (nested {value,unit} objects).
│       │                              Unit-mistag guard: ball_speed.unit==='mps'
│       │                              && value > 120 → 400.
│       │                              Idempotency key: ps|{user_token}|{shot.id}
│       ├── proswing.parser.ts       parseProswing() → NormalisedShot[]
│       └── proswing.controller.ts   POST /v1/webhooks/proswing
│
├── ingestion/
│   ├── ingestion.module.ts          Registers queue, processor, repository,
│   │                                  outbox publisher (worker only).
│   ├── shot-ingestion.queue.ts      ShotIngestionQueue:
│   │                                  enqueue() — backpressure check + add job
│   │                                  checkBatchCapacity() — batch TOCTOU guard
│   │                                  isJobIdKnown() — dedup check
│   │                                  onModuleInit() — starts 10s queue depth poll
│   │                                  Job options: jobId=idempotency_key, attempts=5,
│   │                                  backoff=exponential 1000ms, removeOnComplete
│   │                                  age=1d, removeOnFail age=7d.
│   ├── shot-ingestion.processor.ts  @Processor(SHOT_INGESTION_QUEUE, {concurrency:16})
│   │                                  process(): clock-skew check → identity resolve
│   │                                  → near-dedup → upsertIfNew → metrics + lag.
│   │                                  @OnWorkerEvent('failed'): logs + increments
│   │                                  pureplay_ingest_jobs_failed_total.
│   ├── shot-repository.ts           ShotRepository:
│   │                                  upsertIfNew() — INSERT ON CONFLICT DO NOTHING
│   │                                  RETURNING + outbox_events write in one TX.
│   │                                  findNearDuplicate() — ±60s window by
│   │                                  (vendor_user_id, content_hash).
│   │                                  recordIngestionFailure() — writes to
│   │                                  ingestion_failures with redacted raw_body.
│   │                                  hasExcessiveClockSkew() — asymmetric:
│   │                                  24h past, 5min future.
│   ├── content-hash.ts              computeContentHash() — SHA-256 over:
│   │                                  vendor_user_id | club_code |
│   │                                  minuteBucket(captured_at_utc) |
│   │                                  ball_speed_mps(1dp) | launch_angle_deg(1dp) |
│   │                                  carry_m(0dp) | lateral_m(0dp)
│   ├── outbox-publisher.service.ts  Polls outbox_events every 5s (POLL_INTERVAL_MS).
│   │                                  Batch size: 100 (BATCH_SIZE).
│   │                                  Fires EventEmitter2 event → deletes row.
│   │                                  At-least-once: if DELETE fails, re-emits next poll.
│   └── events/
│       └── shot-persisted.event.ts  ShotPersistedEvent payload type +
│                                      SHOT_PERSISTED_EVENT constant.
│
├── shots/
│   ├── shots.module.ts
│   ├── shots.service.ts             ShotsService: listByCanonicalUser(),
│   │                                  listByVendorUser(). Keyset cursor pagination.
│   │                                  Excludes near-duplicates by default.
│   └── shots.controller.ts          GET /v1/users/:user_id/shots
│                                      GET /v1/users/by-vendor/:vendor/:vendor_user_id/shots
│                                      @UseGuards(InternalApiGuard)
│                                      @Throttle({ query: { ttl:1000, limit:50 } })
│
├── stats/
│   ├── stats.module.ts
│   ├── stats.service.ts             StatsService: per-club p50/p90 calculated in
│   │                                  TypeScript (sort-based, not SQL PERCENTILE_CONT).
│   └── stats.controller.ts          GET /v1/users/:user_id/stats
│                                      GET /v1/users/by-vendor/:vendor/:vendor_user_id/stats
│                                      Query params: club (filter), since, until.
│                                      @UseGuards(InternalApiGuard)
│                                      @Throttle({ query: { ttl:1000, limit:50 } })
│
├── identity/
│   ├── identity.module.ts
│   ├── identity.service.ts          IdentityService — fully implemented, not a stub:
│   │                                  resolveCanonicalUserId() — Redis cache (60s TTL),
│   │                                  falls through to Postgres on miss.
│   │                                  linkIdentity() — upsert + audit log in TX,
│   │                                  backfill shots outside TX.
│   │                                  listByCanonicalUser() — Redis list cache (30s TTL).
│   │                                  unlinkIdentity() — DELETE + audit log in TX.
│   │                                  Cache eviction on link/unlink (DEL both keys).
│   └── identity.controller.ts       POST   /v1/users/:canonical_user_id/identities
│                                      GET    /v1/users/:canonical_user_id/identities
│                                      DELETE /v1/users/:id/identities/:vendor/:vendor_user_id
│                                      @UseGuards(InternalApiGuard)
│                                      POST throttle: write 100/s. GET throttle: query 50/s.
│                                      POST uses @UseInterceptors(IdempotencyInterceptor).
│
└── health/
    ├── health.module.ts
    └── health.controller.ts         GET /healthz — liveness (always 200 if process running)
                                       GET /readyz  — readiness (pings Postgres + Redis;
                                                      returns 503 if either is down)
                                       Both exempt from /v1 prefix and all throttlers.
```

---

## All HTTP endpoints

| Method | Path | Auth | Throttler | Description |
|---|---|---|---|---|
| `POST` | `/v1/webhooks/trackpro` | `WebhookAuthGuard` | webhook 200/s | Ingest single TrackPro shot |
| `POST` | `/v1/webhooks/swingmetric` | `WebhookAuthGuard` | webhook 200/s | Ingest SwingMetric batch (1–500) |
| `POST` | `/v1/webhooks/proswing` | `WebhookAuthGuard` | webhook 200/s | Ingest single ProSwing shot |
| `GET` | `/v1/users/:id/shots` | `InternalApiGuard` | query 50/s | Shots by canonical user |
| `GET` | `/v1/users/by-vendor/:vendor/:vendor_user_id/shots` | `InternalApiGuard` | query 50/s | Shots by vendor user |
| `GET` | `/v1/users/:id/stats` | `InternalApiGuard` | query 50/s | Per-club stats by canonical user |
| `GET` | `/v1/users/by-vendor/:vendor/:vendor_user_id/stats` | `InternalApiGuard` | query 50/s | Per-club stats by vendor user |
| `POST` | `/v1/users/:id/identities` | `InternalApiGuard` | write 100/s | Link vendor identity |
| `GET` | `/v1/users/:id/identities` | `InternalApiGuard` | query 50/s | List vendor identities |
| `DELETE` | `/v1/users/:id/identities/:vendor/:vid` | `InternalApiGuard` | write 100/s | Unlink vendor identity |
| `GET` | `/healthz` | none | none | Liveness probe |
| `GET` | `/readyz` | none | none | Readiness probe (Postgres + Redis) |
| `GET` | `/metrics` | `InternalApiGuard` | none | Prometheus scrape endpoint |
| `GET` | `/api/docs` | none | none | Swagger UI (non-production only) |

---

## Prometheus metrics catalog

All metrics are registered lazily (singleton pattern) in `src/shared/metrics/ingest-metrics.ts`.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `pureplay_ingest_shots_total` | Counter | `vendor`, `outcome`, `parser_version` | Every shot through the ingest funnel. `outcome`: `accepted`, `duplicate_exact`, `duplicate_near`, `rejected_clock`, `failed` |
| `pureplay_ingest_e2e_lag_ms` | Histogram | `vendor` | `Date.now() - new Date(receivedAtUtc).getTime()` measured in worker after upsert. Buckets: 50, 100, 250, 500, 1k, 2.5k, 5k, 10k ms |
| `pureplay_ingest_near_duplicates_total` | Counter | `vendor` | Near-duplicate detections (`duplicate_of` set) |
| `pureplay_ingest_queue_depth` | Gauge | none | BullMQ waiting job count, polled every 10s |
| `pureplay_ingest_jobs_failed_total` | Counter | `vendor` | Jobs that exhausted all 5 retries (dead-lettered) |
| `pureplay_ingest_auth_failures_total` | Counter | `vendor`, `mode` | Webhook auth rejections. `mode`: `api_key` or `hmac` |

---

## Error response shape

All 4xx and 5xx responses use the RFC 9457 Problem Details format, extended with `error_code`:

```json
{
  "type": "urn:problem:payload-validation-failed",
  "error_code": "PAYLOAD_VALIDATION_FAILED",
  "title": "Request payload validation failed.",
  "status": 400,
  "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
  "issues": [
    { "path": "data.shot.ball_speed.value", "code": "too_small", "message": "..." }
  ]
}
```

`GlobalExceptionFilter` handles: `DomainError` (mapped via `domainErrorToHttp()`), `HttpException` (NestJS native), `ServiceUnavailableException` (sets `Retry-After: 30` header), unknown errors (500 with redacted detail). The filter is registered in `AppModule` as a global filter, not in `main.ts`.

---

## Test setup

**Runner:** Vitest 4 with SWC transpilation (via `unplugin-swc`). SWC handles TypeScript decorators — `reflect-metadata` must be imported first in any file that uses NestJS DI decorators.

**Key config in `vitest.config.ts`:**
- `singleThread: true` — all test files run sequentially. Parallel execution causes test files to clobber shared Postgres tables and Redis keys. Do not change this.
- `pool: 'threads'` — uses the Vitest threads pool (not forks or vmThreads).
- Coverage thresholds: lines 70%, functions 70%, branches 60%.
- `setupFiles: ['./test/setup.ts']` — runs before every test file.

**All tests require Docker.** Unit tests connect to live PostgreSQL via `test/helpers/db.ts`. E2E tests also require live Redis.

```bash
docker compose up -d          # start postgres + redis
pnpm test                     # unit tests (test/unit/*.spec.ts)
pnpm test:e2e                 # E2E tests (test/e2e/*.e2e-spec.ts)
pnpm test:cov                 # with coverage report
pnpm test:watch               # watch mode
```

**Test helpers:**

`test/helpers/db.ts` exports:
- `createTestKysely()` — creates a Kysely instance connected to `DATABASE_URL`.
- `truncateAll(db)` — truncates all tables between tests. Call in `beforeEach`.

**Test fixtures (`test/fixtures/`):**

| File | Tests |
|---|---|
| `trackpro.retransmit.json` | Exact dedup via `shot_uid` |
| `swingmetric.batch-with-duplicate.json` | Within-batch near-dedup |
| `swingmetric.cross-batch-retransmit.json` | Cross-batch exact dedup via 1s bucket key |
| `swingmetric.v2.json` | V2 field name normalisation |
| `proswing.tz-offset.json` | UTC extraction + offset preservation |
| `proswing.v2.json` | Flat scalar format |
| `proswing.v3.json` | player/device envelope format |
| `adversarial/unit-mistag.json` | `mps` value > 120 → 400 |
| `adversarial/clock-skew-24h.json` | `captured_at` 25h past → 422 |
| `adversarial/empty-batch.json` | SwingMetric 0 shots → 400 |

**E2E test files:**

| File | Covers |
|---|---|
| `trackpro.e2e-spec.ts` | TrackPro ingest, dedup, auth modes |
| `swingmetric.e2e-spec.ts` | SwingMetric batch, field aliasing, empty-batch 400 |
| `proswing.e2e-spec.ts` | ProSwing V1/V2/V3, unit-mistag, clock-skew |
| `worker.e2e-spec.ts` | BullMQ processing, outbox events, near-dedup |
| `query.e2e-spec.ts` | Shots list, stats, identity CRUD, pagination |

---

## All npm scripts

| Script | Command | When to use |
|---|---|---|
| `build` | `tsc -p tsconfig.json` | Compile before deploying or running `start:api/worker` |
| `start:api` | `node -r ./dist/otel/otel.js dist/main.api.js` | Run compiled API |
| `start:worker` | `node -r ./dist/otel/otel.js dist/main.worker.js` | Run compiled worker |
| `start:dev` | `ts-node … src/main.api.ts` | Local dev with hot-restart |
| `start:dev:worker` | `ts-node … src/main.worker.ts` | Local dev worker |
| `test` | `vitest run` | All tests (unit + e2e) |
| `test:watch` | `vitest` | Watch mode during development |
| `test:cov` | `vitest run --coverage` | Coverage report |
| `lint` | `eslint "{src,test}/**/*.ts"` | Lint check |
| `format` | `prettier --write …` | Auto-format |
| `format:check` | `prettier --check …` | Format check (CI) |
| `db:migrate` | `ts-node … migration-runner` | Run migrations manually |

**There is no `test:e2e` script.** E2E tests are run via `pnpm test` alongside unit tests (Vitest discovers both `*.spec.ts` and `*.e2e-spec.ts`).

---

## Environment variables reference

All variables are validated at startup by `src/config/env.schema.ts`. The process crashes immediately on any missing required variable.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string. `min(1)` — no empty string. |
| `REDIS_URL` | **Yes** | — | Redis connection string. `min(1)` — no empty string. |
| `PORT` | No | `3000` | HTTP listen port |
| `NODE_ENV` | No | `development` | `development` \| `production` \| `test` |
| `WEBHOOK_AUTH_MODE` | No | `none` | `none` \| `api_key` \| `hmac`. `none` blocked in production. |
| `TRACKPRO_API_KEY` | Conditional | — | Required when `WEBHOOK_AUTH_MODE=api_key` |
| `SWINGMETRIC_API_KEY` | Conditional | — | Required when `WEBHOOK_AUTH_MODE=api_key` |
| `PROSWING_API_KEY` | Conditional | — | Required when `WEBHOOK_AUTH_MODE=api_key` |
| `TRACKPRO_HMAC_SECRET` | Conditional | — | Required when `WEBHOOK_AUTH_MODE=hmac` |
| `SWINGMETRIC_HMAC_SECRET` | Conditional | — | Required when `WEBHOOK_AUTH_MODE=hmac` |
| `PROSWING_HMAC_SECRET` | Conditional | — | Required when `WEBHOOK_AUTH_MODE=hmac` |
| `INTERNAL_API_KEY` | Prod-required | — | Min 32 chars. Protects query/stats/identity/metrics. |
| `QUEUE_NAME` | No | `shot-ingestion` | BullMQ queue name |
| `MAX_QUEUE_DEPTH` | No | `10000` | Backpressure threshold |
| `WORKER_CONCURRENCY` | No | `16` | BullMQ processor concurrency per replica |
| `DB_POOL_MAX` | No | `20` | Postgres connection pool size |
| `RUN_MIGRATIONS` | No | `false` | `true` runs migrations on API startup |
| `CORS_ORIGIN` | No | `*` | `*` blocked in production |
| `THROTTLE_ENABLED` | No | `true` | `false` blocked in production. Set `false` for k6 tests. |
| `OTEL_SERVICE_NAME` | No | `pureplay-analytics-ingest` | OTel service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP endpoint URL |

---

## Common pitfalls

**`maxRetriesPerRequest: null` in ioredis config**
BullMQ requires this option on the ioredis connection. Without it, ioredis will throw `MaxRetriesPerRequestError` after the default 20 retries when Redis is briefly unavailable, crashing the worker.

**`BullModule.forRootAsync` vs `BullModule.registerQueue`**
`forRootAsync` (Redis connection config) goes in `AppModule` and `WorkerModule`. `registerQueue('shot-ingestion')` goes in `IngestionModule`. Putting both in the same module, or duplicating `forRootAsync`, causes BullMQ to create a second Redis connection pool.

**Vitest `singleThread: true` must stay**
Changing this to allow parallel test files causes non-deterministic failures because unit tests share the Postgres database and Redis instance. Each test file calls `truncateAll()` in `beforeEach` — parallel execution creates race conditions between the truncate and the preceding test's reads.

**Migration runner semicolon sensitivity**
The `splitStatements` function in `migration-runner.ts` uses a character-by-character state machine. Do not add a semicolon (`;`) to any line that is inside a comment (`-- ...`). The runner skips to end-of-line on `--` but the final scanner still treats `;` inside strings or dollar-quoted blocks as non-terminators. If you add a multi-statement migration, test it with `pnpm db:migrate` against a clean database before merging.

**`raw_payload` must be raw vendor JSON, never re-serialised**
`shot.raw_payload` is the complete vendor JSON object as received. Parsers must pass `payload` directly, not `JSON.parse(JSON.stringify(payload))` — the latter loses `undefined` values and changes the shape of the stored provenance.

**StatsService percentile is TypeScript, not SQL**
`StatsService` fetches rows and computes p50/p90 by sorting in Node. There is no `PERCENTILE_CONT` SQL call. This is intentional (avoids PostgreSQL-specific syntax). Do not refactor to SQL unless you add SQLite compatibility fallback paths.

**Identity service is fully implemented**
The identity service is NOT a stub. `resolveCanonicalUserId` hits Redis then Postgres. `linkIdentity` runs a transaction with the audit log and a post-TX backfill. Do not replace these with stub implementations in tests without mocking explicitly.

**OTel must be loaded before NestJS**
`otel.ts` patches Node's HTTP, Postgres, and Redis modules via auto-instrumentation. If it runs after `NestFactory.create()`, the instrumentation misses the module loading phase. Always load via `-r ./dist/shared/otel/otel.js`.

**`import { Pool, types } from 'pg'` — not `import pg from 'pg'`**
The default import compiles under ts-node but fails in compiled Node because CommonJS `require('pg')` returns the module object, not a default export. `pg.types` becomes `undefined` and the service crashes on startup.

---

## Adding a new vendor

1. Create `src/webhooks/<vendor>/` with three files:
   - `<vendor>.schema.ts` — Zod schema. Define the idempotency key scheme here.
   - `<vendor>.parser.ts` — `parse<Vendor>(payload, receivedAtUtc): NormalisedShot[]`
   - `<vendor>.controller.ts` — `POST /v1/webhooks/<vendor>`. Apply `@Vendor('<vendor>')`, `@UseGuards(WebhookAuthGuard)`, `@Throttle({ webhook: { ttl: 1_000, limit: 200 } })`.

2. Add the vendor to `VALID_VENDORS` in `src/shared/domain/shot.ts`.

3. Add the vendor to the `vendor_enum` PostgreSQL enum in a new migration file.

4. Add `<VENDOR>_API_KEY` and `<VENDOR>_HMAC_SECRET` to `src/config/env.schema.ts`.

5. Register the controller in `src/webhooks/webhooks.module.ts`.

6. Add fixture files to `test/fixtures/` and unit tests to `test/unit/parsers.spec.ts`.

7. Add an E2E spec at `test/e2e/<vendor>.e2e-spec.ts`.
