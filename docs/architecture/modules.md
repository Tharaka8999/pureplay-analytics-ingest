# NestJS Module Map

Every bounded context is its own NestJS module. A module owns its providers and exports only the public surface that other modules depend on.

---

## AppModule (API process)

**File:** `src/app.module.ts`

Imports, in order:

| Import | From | Exports |
|---|---|---|
| `ConfigModule.forRoot()` | `@nestjs/config` | `ConfigService` globally |
| `LoggerModule` | `src/shared/pino/logger.module.ts` | `Logger` globally |
| `KyselyModule` | `src/shared/kysely/kysely.module.ts` | `Kysely<Database>` via `KYSELY` token |
| `BullModule.forRootAsync()` | `@nestjs/bullmq` | Redis connection |
| `ThrottlerModule.forRootAsync()` | `@nestjs/throttler` | Rate limiter |
| `EventEmitterModule.forRoot()` | `@nestjs/event-emitter` | EventEmitter2 |
| `MetricsModule` | `src/shared/metrics/metrics.module.ts` | `/metrics` endpoint |
| `WebhooksModule` | `src/webhooks/webhooks.module.ts` | 3 webhook controllers |
| `IngestionModule` | `src/ingestion/ingestion.module.ts` | `ShotIngestionQueue` only |
| `ShotsModule` | `src/shots/shots.module.ts` | `ShotsController` |
| `StatsModule` | `src/stats/stats.module.ts` | `StatsController` |
| `IdentityModule` | `src/identity/identity.module.ts` | `IdentityController` |
| `HealthModule` | `src/health/health.module.ts` | `/healthz` `/readyz` |

Global providers registered in `AppModule` (not `main.ts`):
- `APP_FILTER` → `GlobalExceptionFilter`
- `APP_INTERCEPTOR` → `RequestIdInterceptor`

---

## WorkerModule (worker process)

**File:** `src/worker.module.ts`

| Import | Note |
|---|---|
| `ConfigModule.forRoot()` | Same env as AppModule |
| `LoggerModule` | Shared pino config |
| `KyselyModule` | Own Postgres pool |
| `BullModule.forRootAsync()` | Own Redis connection |
| `EventEmitterModule.forRoot()` | Own EventEmitter2 instance |
| `MetricsModule` | Worker-side metrics (e.g. jobs_failed) |
| `IngestionModule` | Queue + processor + repository + outbox publisher |
| `IdentityModule` | `IdentityService` for `resolveCanonicalUserId` |

`OutboxPublisherService` is **only** in WorkerModule. Running it in AppModule would cause two publishers to race for the same outbox rows.

---

## KyselyModule

**File:** `src/shared/kysely/kysely.module.ts`

Provides `Kysely<Database>` via injection token `KYSELY = 'KYSELY'`.

Internals:
- Creates a `pg.Pool` using named imports: `import { Pool, types } from 'pg'`
- Registers a `types.setTypeParser(1114, ...)` so `TIMESTAMP` columns return ISO-8601 strings
- Wraps the pool in a Kysely builder with `PostgresDialect`
- `onModuleDestroy()` calls `pool.end()`

```typescript
// Correct injection pattern
constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}
```

---

## IngestionModule

**File:** `src/ingestion/ingestion.module.ts`

| Provider | Exported | Role |
|---|---|---|
| `ShotIngestionQueue` | Yes | Enqueue shots; backpressure guard |
| `ShotIngestionProcessor` | No | BullMQ `@Processor` — worker only |
| `ShotRepository` | No | DB read/write |
| `OutboxPublisherService` | No | Polls `outbox_events` — worker only |

`BullModule.registerQueue(SHOT_INGESTION_QUEUE)` is declared inside `IngestionModule`. Do not repeat it in `AppModule` or `WorkerModule`.

---

## WebhooksModule

**File:** `src/webhooks/webhooks.module.ts`

Registers:
- `TrackproController` — POST `/v1/webhooks/trackpro`
- `SwingmetricController` — POST `/v1/webhooks/swingmetric`
- `ProswingController` — POST `/v1/webhooks/proswing`

Imports `IngestionModule` (for `ShotIngestionQueue`) and `WebhookAuthGuard` (which is request-scoped and reads `ConfigService`).

---

## IdentityModule

**File:** `src/identity/identity.module.ts`

| Provider | Exported | Role |
|---|---|---|
| `IdentityService` | Yes | resolveCanonicalUserId, linkIdentity, listByCanonicalUser, unlinkIdentity |
| `IdentityController` | No | HTTP controllers |
| `AuditLogService` | No | writes audit_log rows |

Imports `KyselyModule`, `RedisModule`, and the `AuditLogService` provider.

---

## MetricsModule

**File:** `src/shared/metrics/metrics.module.ts`

Registers `MetricsController` at `GET /metrics`. Protects it with `InternalApiGuard`. The Prometheus `prom-client` registry is the default global registry — all metrics are lazy singletons created once at first use.

---

## RedisModule

**File:** `src/shared/redis/redis.module.ts`

Provides an `ioredis` client via injection token `REDIS = 'REDIS'`.

Required option: `maxRetriesPerRequest: null`. Without this, BullMQ throws `MaxRetriesPerRequestError` when Redis is briefly unavailable.

```typescript
// Correct injection pattern
constructor(@Inject(REDIS) private readonly redis: Redis) {}
```

---

## HealthModule

**File:** `src/health/health.module.ts`

Registers `HealthController`:

| Endpoint | Behaviour |
|---|---|
| `GET /healthz` | Always 200 if the process is running (liveness) |
| `GET /readyz` | 200 if Postgres + Redis respond; 503 otherwise (readiness) |

Both endpoints are excluded from the `/v1` global prefix and from all throttlers.
