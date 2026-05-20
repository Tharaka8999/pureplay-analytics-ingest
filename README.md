# Pureplay Analytics Ingest

**Multi-vendor golf shot ingestion, deduplication, and query service.**

Accepts webhook payloads from three launch-monitor vendors (TrackPro, SwingMetric, ProSwing), normalises all measurements to SI units, deduplicates at two independent layers, persists to PostgreSQL via an async BullMQ worker pool, and exposes authenticated REST endpoints for querying shots, per-club statistics, and cross-vendor user identity management.

---

## Table of contents

1. [Security warnings](#security-warnings)
2. [Architecture overview](#architecture-overview)
3. [Prerequisites](#prerequisites)
4. [Quick start](#quick-start)
5. [Docker Compose reference](#docker-compose-reference)
6. [Development](#development)
7. [Testing](#testing)
8. [Load testing](#load-testing)
9. [API reference](#api-reference)
   - [Webhooks](#webhooks)
   - [Shots](#shots)
   - [Stats](#stats)
   - [Identity](#identity)
   - [Health and observability](#health-and-observability)
9. [Vendor payload formats](#vendor-payload-formats)
10. [Webhook authentication](#webhook-authentication)
11. [Rate limiting](#rate-limiting)
12. [Deduplication](#deduplication)
13. [Metrics](#metrics)
14. [Environment variables](#environment-variables)
15. [Production deployment](#production-deployment)
16. [Database schema](#database-schema)

---

## Security warnings

> Read this section before running the service anywhere outside a local laptop.

### `WEBHOOK_AUTH_MODE=none` disables all webhook authentication

```
WARNING: WEBHOOK_AUTH_MODE=none accepts every POST to /v1/webhooks/* without
any credential check. Any client on the network can inject arbitrary shot data.
This setting exists exclusively for local development and automated test runs.
It is FORBIDDEN in production — the env schema will crash the process on startup
if NODE_ENV=production and WEBHOOK_AUTH_MODE=none are set simultaneously.
```

Set `WEBHOOK_AUTH_MODE=api_key` or `WEBHOOK_AUTH_MODE=hmac` for any non-local deployment and configure per-vendor secrets.

### IDOR trust boundary — do not expose this service directly to the internet

The query, stats, and identity endpoints (`/v1/users/*`) accept a `user_id` path parameter and return data for that user. **This service does not verify that the caller is authorised to access that user's data.** It trusts the caller to supply a correctly-scoped identifier.

Authorization is the responsibility of the upstream Portal BFF or API gateway. The service enforces that the caller holds a valid `INTERNAL_API_KEY` bearer token (required in production), but it does not perform per-user authorization checks. Deploy behind a BFF; never expose `/v1/users/*` directly to untrusted clients.

### Adminer is a development tool — never deploy to production

The `adminer` service defined in `docker-compose.yml` exposes a full PostgreSQL administration UI using the hardcoded development credentials (`pureplay`/`pureplay`). It is gated behind the `--profile dev` flag and binds only to `127.0.0.1:8080`. It must not be included in any production or staging deployment.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Vendor SDK                                                          │
│  TrackPro · SwingMetric · ProSwing                                  │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ HTTPS webhook POST
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ API process  (NestJS 11 · Fastify 5)                                │
│                                                                     │
│  Redis-backed rate limiter  (200 webhook / 50 query / 100 write)    │
│  WebhookAuthGuard           (none | api_key | hmac-sha256)          │
│  Zod schema validation      (→ 400 on failure)                      │
│  Clock-skew guard           (→ 422 if >24h past or >5min future)    │
│  Backpressure gate          (→ 503 + Retry-After:30 at MAX_DEPTH)   │
│  Vendor parser + normaliser (all units → SI)                        │
│  BullMQ enqueue             (jobId = idempotency_key)               │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Redis stream (AOF-persisted)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Worker process  (2 replicas · 16 concurrency each = 32 total)       │
│                                                                     │
│  Clock-skew recheck         (belt-and-suspenders for replayed jobs) │
│  Identity resolution        (user_identities table lookup)          │
│  Upsert                     (ON CONFLICT DO NOTHING on idempotency) │
│  Near-dedupe flag           (content_hash ± 60s → duplicate_of FK) │
│  Transactional outbox write (atomic with shot INSERT)               │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PostgreSQL 15                                                        │
│  shots · user_identities · ingestion_failures · outbox_events       │
└─────────────────────────────────────────────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          │                                     │
          ▼                                     ▼
┌─────────────────────┐             ┌─────────────────────────┐
│ OutboxPublisherSvc  │             │ Portal BFF              │
│ polls every 5s      │             │ GET /v1/users/:id/shots  │
│ emits shot.persisted│             │ GET /v1/users/:id/stats  │
└─────────────────────┘             │ POST/DELETE /identities  │
                                    │ Auth: Bearer INTERNAL_KEY│
                                    └─────────────────────────┘
```

**Stack:** NestJS 11.1.21 · Fastify 5.8.5 · Kysely 0.29.2 · BullMQ 5.76.10 · Zod v4.4.3 · nestjs-pino 4.6.1 · prom-client 15.1.3 · PostgreSQL 15 · Redis 7.2 · ulidx 2.4.1 · OpenTelemetry auto-instrumentation · Node 22 LTS · TypeScript 5.7 strict.

---

## Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| Node.js | 22 LTS | Engine field in `package.json` enforces this |
| pnpm | 10+ | Lockfile is pnpm format |
| Docker | 24+ | Compose V2 required (`docker compose`, not `docker-compose`) |
| Docker Compose | V2 (bundled with Docker Desktop) | |

---

## Quick start

### 1. Clone and install

```bash
git clone <repo-url>
cd pureplay-analytics-ingest
pnpm install --frozen-lockfile
```

### 2. Start infrastructure

```bash
# Start Postgres 15 and Redis 7.2 in the background
docker compose up -d postgres redis

# Verify both are healthy before proceeding
docker compose ps
```

### 3. Configure environment

```bash
cp .env.example .env
# The defaults in .env.example work for local development as-is.
# Edit DATABASE_URL and REDIS_URL if you changed the Compose defaults.
```

### 4. Build and start

```bash
# Compile TypeScript
pnpm build

# Run migrations and start the HTTP API
RUN_MIGRATIONS=true pnpm start:api
```

You should see structured JSON log lines and the API listening on `http://localhost:3000`.

### 5. Verify

```bash
# Liveness
curl -s http://localhost:3000/healthz | jq .
# → {"status":"ok","timestamp":"..."}

# Readiness (Postgres + Redis)
curl -s http://localhost:3000/readyz | jq .
# → {"status":"ok","info":{"db":{"status":"up"},"redis":{"status":"up"}},...}

# OpenAPI docs
open http://localhost:3000/api/docs
```

### 6. Send a test shot

```bash
# TrackPro single shot — all SI units
curl -s -X POST http://localhost:3000/v1/webhooks/trackpro \
  -H 'Content-Type: application/json' \
  -d '{
    "shot_uid":          "tp-2026-05-20-aabbccdd",
    "user_external_id":  "demo-player-1",
    "captured_at":       "2026-05-20T02:00:00.000Z",
    "club":              "DR",
    "ball_speed_mps":    74.8,
    "club_head_speed_mps": 52.7,
    "launch_angle_deg":  10.5,
    "carry_distance_m":  241.1,
    "side_deviation_m":  0.6
  }'
# → {"status":"accepted","correlation_id":"<uuid>"}
```

> **Clock-skew constraint:** `captured_at` must be within the last 24 hours and no more than 5 minutes in the future. The controller rejects out-of-window shots synchronously with `422 Unprocessable Entity` before enqueuing. The worker applies the same check again as a defence against replayed queue jobs.

### 7. Query shots

```bash
# Wait ~500 ms for the worker to write the shot, then:
curl -s 'http://localhost:3000/v1/users/by-vendor/trackpro/demo-player-1/shots' | jq .
```

---

## Docker Compose reference

### Start the full stack

```bash
# All services: API + 2× worker + Postgres + Redis
docker compose up -d

# With Adminer database UI (development only)
docker compose --profile dev up -d
```

### Useful commands

```bash
docker compose ps                    # show running services and health
docker compose logs -f api           # stream API logs
docker compose logs -f worker        # stream worker logs (both replicas)
docker compose logs --tail=100 api   # last 100 API log lines
docker compose restart api           # restart without rebuilding
docker compose down                  # stop all containers
docker compose down --volumes        # stop and delete persistent volumes (destructive)
```

### Service reference

| Service | Port | Image | Memory limit |
|---|---|---|---|
| `postgres` | `5432` | `postgres:15-alpine` | 512 MB |
| `redis` | `6379` | `redis:7.2-alpine` | 192 MB |
| `api` | `3000` | Local `Dockerfile` (target: `api`) | 512 MB |
| `worker` | — | Local `Dockerfile` (target: `worker`) | 512 MB × 2 replicas |
| `adminer` | `8080` (loopback only) | `adminer:4-standalone` | 512 MB — `--profile dev` only |

**Adminer access:** `http://localhost:8080` · System: `PostgreSQL` · Server: `postgres` · Username: `pureplay` · Password: `pureplay` · Database: `pureplay_ingest`

### Redis persistence

Redis is configured with AOF persistence (`appendonly yes`, `appendfsync everysec`) and `maxmemory-policy noeviction`. This ensures queued jobs survive a Redis restart. `noeviction` returns an error rather than silently evicting jobs when memory is full — a `503` to the caller is preferable to silent job loss.

### Container hardening

Both `api` and `worker` containers run with:

```yaml
read_only: true          # filesystem is read-only
tmpfs: [/tmp]            # only /tmp is writable
cap_drop: [ALL]          # all Linux capabilities dropped
security_opt:
  - no-new-privileges:true
```

---

## Development

### Scripts

| Command | Description |
|---|---|
| `pnpm build` | Compile TypeScript → `dist/`. Required before `start:api` or `start:worker`. |
| `pnpm start:api` | Start the HTTP API from compiled output (production mode, OTel loaded). |
| `pnpm start:worker` | Start the BullMQ worker from compiled output (production mode, OTel loaded). |
| `pnpm start:dev` | Start the HTTP API via `ts-node` — no build step, for rapid iteration. |
| `pnpm start:dev:worker` | Start the BullMQ worker via `ts-node`. |
| `pnpm test` | Run the full test suite (unit + E2E) via Vitest. |
| `pnpm test:watch` | Run tests in watch mode (re-runs on file change). |
| `pnpm test:cov` | Run tests with V8 coverage report. |
| `pnpm lint` | ESLint — checks `src/` and `test/`. |
| `pnpm format` | Prettier — reformats `src/` and `test/` in place. |
| `pnpm format:check` | Prettier — checks formatting without writing (used in CI). |
| `pnpm db:migrate` | Run database migrations manually via `ts-node`. |

### Development vs production start

`start:api` and `start:worker` run the compiled `dist/` output and load OpenTelemetry instrumentation:

```bash
node -r ./dist/shared/otel/otel.js dist/main.api.js
```

`start:dev` and `start:dev:worker` use `ts-node` with path aliases — no build step needed, but slower startup and no OTel:

```bash
ts-node -r tsconfig-paths/register src/main.api.ts
```

Use `start:dev` during active development. Use `start:api` (after `pnpm build`) to verify compiled output before deploying.

### Running migrations

Migrations are SQL files in `migrations/`. The migration runner splits on `;` after stripping comments, then executes each statement. Migrations are idempotent (`IF NOT EXISTS`, `DO...EXCEPTION` for enum types).

```bash
# On startup (recommended for dev and CI)
RUN_MIGRATIONS=true pnpm start:api

# Manual run (without starting the server)
pnpm db:migrate
```

### Project layout

```
pureplay-analytics-ingest/
├── migrations/
│   └── 001_init.sql              PostgreSQL DDL (shots, user_identities, failures, outbox)
├── src/
│   ├── main.api.ts               HTTP server bootstrap (Fastify adapter, CORS, HMAC hook)
│   ├── main.worker.ts            BullMQ worker bootstrap
│   ├── app.module.ts             HTTP app root module
│   ├── worker.module.ts          Worker app root module
│   ├── config/
│   │   └── env.schema.ts         Zod environment validation with production safety gates
│   ├── shared/
│   │   ├── auth/                 WebhookAuthGuard (none/api_key/hmac) · InternalApiGuard
│   │   ├── domain/               NormalisedShot type · ClubCode enum · unit converters
│   │   ├── kysely/               KyselyModule · type-safe DB types · migration runner
│   │   ├── metrics/              prom-client counters/histograms/gauges
│   │   ├── idempotency/          IdempotencyInterceptor (identity POST dedup)
│   │   ├── redis/                RedisModule (ioredis singleton)
│   │   ├── otel/                 OpenTelemetry auto-instrumentation loader
│   │   ├── openapi/              Swagger/OpenAPI setup
│   │   ├── pii-redact.ts         [SEC] Email + token stripper for ingestion_failures
│   │   ├── zod-validation.pipe.ts Generic Zod → NestJS pipe
│   │   └── global-exception.filter.ts  Unified error shape for all 4xx/5xx
│   ├── webhooks/
│   │   ├── trackpro/             Schema · parser · controller
│   │   ├── swingmetric/          Schema (V1+V2 normalised) · parser · controller
│   │   └── proswing/             Schema (V1/V2/V3 dispatch) · parser · controller
│   ├── ingestion/
│   │   ├── shot-ingestion.queue.ts   Enqueue + backpressure + batch capacity check
│   │   ├── shot-ingestion.processor.ts  BullMQ job handler (upsert + near-dedup + metrics)
│   │   ├── shot-repository.ts    Kysely upsert · near-dedupe · failure recording
│   │   ├── content-hash.ts       SHA-256 content hash for near-dedup
│   │   └── outbox-publisher.ts   Polls outbox_events → emits shot.persisted
│   ├── shots/                    GET /users/:id/shots · by-vendor variant
│   ├── stats/                    GET /users/:id/stats · by-vendor variant
│   ├── identity/                 POST/GET/DELETE /users/:id/identities
│   └── health/                   /healthz (liveness) · /readyz (Postgres + Redis)
└── test/
    ├── fixtures/                 JSON payloads for all 3 vendors + adversarial cases
    ├── helpers/                  createTestKysely · truncateAll · app bootstrap
    ├── unit/                     Pure unit tests (parsers, dedup, PII, auth guard)
    └── e2e/                      Full HTTP → worker → DB via Supertest
```

---

## Testing

### Requirements

All tests (unit and E2E) require live Postgres and Redis:

```bash
docker compose up -d postgres redis
```

Unit tests connect directly to Postgres (via `test/helpers/db.ts`) to test repository logic against real SQL. E2E tests bootstrap a full NestJS application and exercise the HTTP → BullMQ → worker → DB path.

### Run the test suite

```bash
# Full suite — unit + E2E
pnpm test

# Watch mode — re-runs affected tests on save
pnpm test:watch

# With V8 coverage report (outputs to coverage/)
pnpm test:cov
```

### Test layout

| Layer | Location | Description |
|---|---|---|
| Unit | `test/unit/` | Parsers, content hash, PII redaction, WebhookAuthGuard, shot-repository SQL — no NestJS bootstrap, no HTTP |
| E2E | `test/e2e/` | Full app via `NestFactory + Supertest`; each spec covers one vendor or feature end-to-end |

### Test fixtures

`test/fixtures/` contains canonical payloads for each vendor and adversarial edge cases:

| Fixture | Tests |
|---|---|
| `trackpro.retransmit.json` | Exact dedup — second POST with same `shot_uid` is a no-op |
| `swingmetric.batch-with-duplicate.json` | Within-batch near-dedup |
| `swingmetric.cross-batch-retransmit.json` | Cross-batch exact dedup via idempotency key |
| `proswing.tz-offset.json` | Timezone offset extraction and UTC normalisation |
| `adversarial/unit-mistag.json` | ProSwing unit-mistag: `mps` value > 120 → 400 |
| `adversarial/clock-skew-24h.json` | `captured_at` 25h in the past → 422 |
| `adversarial/empty-batch.json` | SwingMetric with zero shots → 400 |

---

## Load testing

The repository ships a production-grade [k6](https://k6.io) load test script at `k6-load-test.js`. It exercises every API surface — ingest, identity, query, stats, and health — in a realistic 10-step VU journey that mirrors how a launch monitor interacts with the service during a busy round of golf.

### Prerequisites

**Install k6**

```bash
# macOS
brew install k6

# Docker (no install required)
docker run --rm -i grafana/k6 run - < k6-load-test.js
```

**Start the full stack**

```bash
docker compose up -d          # starts postgres, redis, api, and 2 × worker replicas
pnpm build                    # build must exist before api starts
```

**Disable throttle buckets**

k6 runs all VUs from a single IP address. The service's Redis-backed throttler would exhaust the per-IP bucket before any meaningful load is generated. Disable it for load test runs:

```bash
# add to .env or set in docker-compose.yml environment block
THROTTLE_ENABLED=false
```

Restart the api container after changing this value (`docker compose restart api`).

---

### Scenarios

Five scenarios cover the full operating envelope:

| Scenario | Executor | VUs / Rate | Duration | Purpose |
|---|---|---|---|---|
| `smoke` | constant-vus | 1 VU | 30s | Sanity check — confirms the stack boots and all endpoints return 2xx |
| `nft` | ramping-arrival-rate | 16 → 64 iter/s | 5 × 1 min | NFR validation — proves ≥ 32 shots/s sustained; ramps to reveal saturation point |
| `peak` | constant-arrival-rate | 48 iter/s (144 shots/s) | 1 min | 3× sustained load burst |
| `load` | ramping-vus | 0 → 50 → 0 | 5 min | **Default** — busy Saturday morning, 50 concurrent launch monitors |
| `stress` | ramping-vus | 0 → 100 → 200 → 100 → 0 | 9 min | Breaking-point ramp |

Each iteration posts one shot to each of the three vendors (TrackPro + SwingMetric + ProSwing) — so 1 iteration = 3 shots ingested.

---

### Running a scenario

**Required environment variable**

```
INTERNAL_API_KEY   Bearer token for identity / query / stats endpoints.
                   Must match INTERNAL_API_KEY in your .env (min 32 chars).
```

**Optional environment variables**

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | API base URL |
| `SCENARIO` | `load` | Which scenario to run (`smoke`, `nft`, `peak`, `load`, `stress`) |

**Commands**

```bash
# Default scenario (load — 50 VUs, 5 min)
k6 run \
  -e INTERNAL_API_KEY=dev-load-test-internal-api-key-change-in-prod \
  k6-load-test.js

# Smoke — 1 VU, 30s
k6 run -e INTERNAL_API_KEY=<key> -e SCENARIO=smoke k6-load-test.js

# NFR ramp — proves ≥ 32 shots/s sustained
k6 run -e INTERNAL_API_KEY=<key> -e SCENARIO=nft k6-load-test.js

# Peak burst — 144 shots/s for 1 minute
k6 run -e INTERNAL_API_KEY=<key> -e SCENARIO=peak k6-load-test.js

# Stress — find the breaking point (0 → 200 VUs)
k6 run -e INTERNAL_API_KEY=<key> -e SCENARIO=stress k6-load-test.js

# Save raw output for offline analysis
k6 run -e INTERNAL_API_KEY=<key> --out json=results.json k6-load-test.js
```

---

### What each VU does

Every virtual user executes the following 10-step journey per iteration, covering all API paths in dependency order:

| Step | Endpoint | Method | Description |
|---|---|---|---|
| 1 | `POST /v1/webhooks/trackpro` | ingest | Single TrackPro shot with randomised measurements |
| 2 | `POST /v1/webhooks/swingmetric` | ingest | SwingMetric batch (1 shot, V1 wire format) |
| 3 | `POST /v1/webhooks/proswing` | ingest | ProSwing V1 shot |
| 4 | `GET /v1/identity/:id/mappings` | query | List identity mappings for the canonical user |
| 5 | `POST /v1/identity/:id/link` | write | Re-link a vendor user from the identity pool |
| 6 | `GET /v1/shots?user_id=<canonical>` | query | Shots by canonical user ID |
| 7 | `GET /v1/shots?vendor_user_id=<id>&vendor=trackpro` | query | Shots by vendor user ID |
| 8 | `GET /v1/stats?user_id=<canonical>&club=7i` | query | Per-club stats for canonical user |
| 9 | `GET /v1/stats?vendor_user_id=<id>&vendor=trackpro&club=7i` | query | Per-club stats by vendor user |
| 10 | `GET /healthz` | health | Liveness probe — ensures health endpoint stays fast under load |

---

### Setup and teardown

The script's `setup()` function runs once before VUs start. It:

1. Seeds **20 TrackPro shots**, **10 SwingMetric shots**, and **10 ProSwing shots** into the service to ensure the query and stats endpoints return non-empty results from the first iteration.
2. Waits 3 seconds for the BullMQ worker to process the seeded shots.
3. Links the main canonical user (`01JVLOADTEST000000000000A1`) to three vendor users (`load-test-tp-user`, `load-test-sm-user`, `load-test-ps-user`).
4. Links **10 pool vendor users** (`load-test-pool-0` through `load-test-pool-9`) to the same canonical user — see [Identity pool](#identity-pool) below.

The `teardown()` function deletes all 13 identity mappings after the test completes.

#### Identity pool

At 120 VUs, if all VUs write to the same identity row simultaneously, they serialize on a single database row lock. The script distributes this contention by pre-creating a pool of 10 distinct vendor user IDs. Each VU picks one deterministically: `pool[(__VU - 1) % 10]`. This means at 120 VUs, approximately 12 VUs compete for each row — matching production behaviour where distinct customers write distinct rows.

---

### Thresholds

Thresholds are checked automatically by k6. The run exits non-zero if any threshold is breached.

**Standard thresholds** (all scenarios except `peak`):

| Metric | Threshold |
|---|---|
| `http_req_duration{name:ingest_trackpro}` p95 | < 300 ms |
| `http_req_duration{name:ingest_swingmetric}` p95 | < 300 ms |
| `http_req_duration{name:ingest_proswing}` p95 | < 300 ms |
| `http_req_duration{name:query_stats_canonical}` p95 | < 800 ms |
| `http_req_duration{name:query_stats_vendor}` p95 | < 800 ms |
| `http_req_duration{name:identity_list}` p95 | < 200 ms |
| `http_req_duration{name:identity_link}` p95 | < 200 ms |
| `http_req_failed` rate | < 1% |
| `ingest_success_rate` | > 99% |
| `identity_op_success` | > 99% |

**Peak thresholds** (relaxed — `peak` scenario intentionally exceeds NFR floor):

| Metric | Threshold |
|---|---|
| `http_req_duration{name:ingest_*}` p95 | < 500 ms |
| `http_req_duration{name:query_stats_*}` p95 | < 1200 ms |
| `http_req_duration{name:identity_list}` p95 | < 500 ms |
| `http_req_duration{name:identity_link}` p95 | < 700 ms |

---

### Custom metrics

In addition to k6's built-in metrics, the script tracks four custom metrics:

| Metric | Type | Description |
|---|---|---|
| `ingest_success_rate` | Rate | Fraction of ingest requests that returned 202 |
| `identity_op_success` | Rate | Fraction of identity link/list requests that returned 2xx |
| `query_latency_ms` | Trend (p95) | Latency of shot/stats query endpoints |
| `identity_latency_ms` | Trend (p95) | Latency of identity link and list endpoints |

These appear in k6's summary output alongside the standard `http_req_duration` histogram.

---

### Interpreting results

A passing run ends with a green summary:

```
✓ http_req_failed............: 0.00%  ✓ 0       ✗ 0
✓ ingest_success_rate........: 100.00% ✓ 3600    ✗ 0
✓ identity_op_success........: 100.00% ✓ 1200    ✗ 0
✓ http_req_duration{name:ingest_trackpro}...: p(95)=187ms
```

A failing run shows red `✗` lines for breached thresholds and exits with code 99. Common failure modes:

| Symptom | Likely cause |
|---|---|
| `ingest_*` p95 > 300 ms | Worker backlog growing — check `pureplay_ingest_queue_depth` in `/metrics` |
| `query_stats_*` p95 > 800 ms | Missing index or stats aggregation scanning too many rows |
| `http_req_failed` rate > 1% | Throttle bucket exhaustion — confirm `THROTTLE_ENABLED=false` |
| `identity_link` p95 > 200 ms | DB row-lock contention on the identity table |
| k6 errors before any requests | `INTERNAL_API_KEY` unset or incorrect |

Check the Prometheus metrics endpoint during a test run for real-time signal:

```bash
# Stream metrics while the test runs
watch -n2 'curl -s http://localhost:3000/metrics | grep pureplay'
```

---

## API reference

All paths are prefixed with `/v1`, except `/healthz`, `/readyz`, and `/metrics`.

### Common error shape

All `4xx` and `5xx` responses follow a consistent structure:

```json
{
  "error_code": "PAYLOAD_VALIDATION_FAILED",
  "message":    "Request payload validation failed.",
  "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
  "issues": [
    { "path": "ball_speed_mps", "code": "too_big", "message": "Number must be <= 120" }
  ]
}
```

`correlation_id` is taken from the `X-Correlation-ID` request header if provided, or generated as a UUID otherwise. Include it in support requests.

### HTTP status codes used by this service

| Code | Meaning | Common cause |
|---|---|---|
| `200` | OK | Query responses |
| `201` | Created | Identity link created |
| `202` | Accepted | Shot enqueued |
| `204` | No Content | Identity unlinked |
| `400` | Bad Request | Schema validation failed — see `issues[]` |
| `401` | Unauthorized | Missing or invalid webhook credential / INTERNAL_API_KEY |
| `404` | Not Found | Resource not found (identity unlink on non-existent mapping) |
| `422` | Unprocessable Entity | Valid schema, rejected semantics (`CLOCK_SKEW_EXCESSIVE`) |
| `429` | Too Many Requests | Rate limit exceeded (`error_code: TOO_MANY_REQUESTS`) |
| `503` | Service Unavailable | Queue at capacity (`Retry-After: 30`) or dependency down |

---

### Webhooks

Auth: Controlled by `WEBHOOK_AUTH_MODE`. See [Webhook authentication](#webhook-authentication).

All webhook controllers accept an optional `X-Correlation-ID` header. If absent, a UUID is generated and returned in the response body.

#### `POST /v1/webhooks/trackpro`

Ingests a single shot from TrackPro (Vendor A). All measurements are in SI units. One wire format.

**Request headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `X-Webhook-Auth` | When `api_key` | Per-vendor API key |
| `X-Webhook-Timestamp` | When `hmac` | Unix epoch seconds |
| `X-Webhook-Signature` | When `hmac` | `sha256=<hex>` |
| `X-Correlation-ID` | No | Caller-supplied trace ID |

**Request body**

```json
{
  "shot_uid":             "tp-2026-05-20-aabbccdd",
  "user_external_id":     "player-42",
  "session_id":           "sess-001",
  "device_id":            "device-xyz",
  "captured_at":          "2026-05-20T02:00:00.000Z",
  "club":                 "7I",
  "ball_speed_mps":       54.2,
  "club_head_speed_mps":  38.1,
  "launch_angle_deg":     17.3,
  "spin_rpm":             7100,
  "carry_distance_m":     145.0,
  "total_distance_m":     152.0,
  "side_deviation_m":     -1.2
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `shot_uid` | string | Yes | Pattern: `tp-YYYY-MM-DD-[a-f0-9]{8}` |
| `user_external_id` | string | Yes | 1–255 chars |
| `session_id` | string | No | 1–255 chars |
| `device_id` | string | No | 1–255 chars |
| `captured_at` | ISO-8601 | Yes | Offset-aware datetime |
| `club` | string | Yes | 1–64 chars — normalised to ClubCode enum |
| `ball_speed_mps` | number | Yes | 0–120 m/s |
| `club_head_speed_mps` | number | No | 0–100 m/s |
| `launch_angle_deg` | number | Yes | −10–70 degrees |
| `spin_rpm` | integer | No | 0–15 000 RPM |
| `carry_distance_m` | number | Yes | 0–450 m |
| `total_distance_m` | number | No | 0–500 m |
| `side_deviation_m` | number | Yes | −200–200 m (right = positive) |

**Response `202`**

```json
{ "status": "accepted", "correlation_id": "550e8400-e29b-41d4-a716-446655440000" }
```

**Error responses**

| Status | `error_code` | Cause |
|---|---|---|
| `400` | `PAYLOAD_VALIDATION_FAILED` | Schema violation — see `issues[]` |
| `401` | `UNAUTHORIZED` | Invalid or missing webhook credential |
| `422` | `CLOCK_SKEW_EXCESSIVE` | `captured_at` outside window |
| `429` | `TOO_MANY_REQUESTS` | >200 req/s from this IP |
| `503` | `SERVICE_UNAVAILABLE` | Queue at capacity |

---

#### `POST /v1/webhooks/swingmetric`

Ingests a batch of 1–500 shots from SwingMetric (Vendor B). Measurements are in imperial units (mph, yards). Accepts both V1 (`club_used`, `carry_yds`, `offline_yds`) and V2 (`club`, `carry_yd`, `offline_yd`) field naming — schema normalises both transparently.

**Request body**

```json
{
  "session_id": "session-abc",
  "player": {
    "id":    "a.smith",
    "email": "a.smith@example.com"
  },
  "device": "device-001",
  "shots": [
    {
      "ts_ms":          1716167700000,
      "club":           "7I",
      "ball_speed_mph": 121.0,
      "swing_speed_mph": 85.0,
      "launch_deg":     18.1,
      "spin_rpm":       7050,
      "carry_yd":       158.0,
      "total_yd":       165.0,
      "offline_yd":     -1.3
    }
  ]
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `session_id` | string | Yes | 1–255 chars |
| `player.id` | string | Yes | 1–255 chars |
| `player.email` | string | No | RFC-5322 email; **PII — stripped before any failure logging** |
| `device` | string | Yes | 1–255 chars |
| `shots` | array | Yes | 1–500 items |
| `shots[].ts_ms` | integer | Yes | Unix milliseconds ≥ 0 |
| `shots[].club` | string | Yes | `club_used` accepted for V1 compatibility |
| `shots[].ball_speed_mph` | number | Yes | 0–268 mph |
| `shots[].swing_speed_mph` | number | No | 0–230 mph |
| `shots[].launch_deg` | number | Yes | −10–70° (`launch_angle` accepted for V1) |
| `shots[].spin_rpm` | integer | No | 0–15 000 RPM |
| `shots[].carry_yd` | number | Yes | 0–490 yd (`carry_yds` accepted for V1) |
| `shots[].total_yd` | number | No | 0–545 yd (`total_yds` accepted for V1) |
| `shots[].offline_yd` | number | Yes | −220–220 yd (`offline_yds` accepted for V1) |

One BullMQ job is enqueued per shot. The response is `202` only if the entire batch was enqueued. A batch capacity check (`checkBatchCapacity`) guards against TOCTOU overflow: if `queue_depth + batch_size > MAX_QUEUE_DEPTH`, the entire batch is rejected with `503` before any jobs are enqueued.

---

#### `POST /v1/webhooks/proswing`

Ingests a single shot from ProSwing (Vendor C). Supports three wire-format versions detected by structural inspection (O(1), no version field required):

| Version | Detection marker | User identifier | Launch format | Notes |
|---|---|---|---|---|
| **V1** | Nested `{value, unit}` ball_speed | `data.user_token` | `{value, unit: "deg"}` | Original format |
| **V2** | Flat scalar `ball_speed_mph/kph/mps` | `data.user_token` | `launch_deg: <number>` | Simplified scalar format |
| **V3** | `data.player` object present | `data.player.id` | `launch_angle: <number>` | Device envelope format |

**Request body (V1 — nested measurement objects)**

```json
{
  "type": "shot.recorded",
  "data": {
    "user_token": "usr_tok_abc123def456",
    "shot": {
      "id":          "ps-shot-001",
      "occurred_at": "2026-05-20T12:14:22+10:00",
      "club_code":   "DR",
      "ball_speed":  { "value": 167.2, "unit": "mph" },
      "club_speed":  { "value": 117.8, "unit": "mph" },
      "launch":      { "value": 10.5,  "unit": "deg" },
      "carry":       { "value": 263.0, "unit": "yd"  },
      "deviation":   { "value": 2.1,   "unit": "yd"  }
    }
  }
}
```

**Request body (V3 — player/device envelope)**

```json
{
  "type": "shot.recorded",
  "data": {
    "player": { "id": "player-uuid-001" },
    "device": { "id": "device-uuid-002" },
    "shot": {
      "id":           "ps-shot-002",
      "occurred_at":  "2026-05-20T02:14:22Z",
      "club_code":    "7I",
      "ball_speed":   { "value": 121.4, "unit": "mph" },
      "launch_angle": 18.2,
      "spin_rpm":     7200,
      "carry":        { "value": 158.0, "unit": "yd" },
      "deviation":    { "value": -0.8,  "unit": "yd" }
    }
  }
}
```

**Unit-mistag guard:** If `ball_speed.unit = "mps"` and `value > 120`, the schema rejects the payload with `400`. The world record ball speed is ≈91 m/s; a value above 120 with an `mps` label almost certainly means the device sent mph with the wrong unit tag.

**Timezone handling:** `occurred_at` is parsed as ISO-8601 with optional UTC offset. The UTC equivalent is stored in `captured_at_utc`; the original offset in minutes is stored in `captured_at_tz_offset_min` for display-layer use.

---

### Shots

Auth: `Authorization: Bearer <INTERNAL_API_KEY>` — required in production.

#### `GET /v1/users/:user_id/shots`

Returns paginated shots for a canonical user ID.

**Path parameters**

| Parameter | Description |
|---|---|
| `user_id` | Canonical user ID (ULID, 26 characters) assigned by the identity system |

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `since` | ISO-8601 | 30 days ago | Filter: `captured_at_utc` ≥ this value |
| `until` | ISO-8601 | now | Filter: `captured_at_utc` ≤ this value |
| `club` | string | — | Filter by club code, e.g. `7I`, `DR`, `PW` |
| `cursor` | string | — | Keyset pagination cursor from previous `paging.next_cursor` |
| `limit` | integer | `50` | Page size — maximum `100` |
| `include_near_duplicates` | boolean | `false` | Include shots where `duplicate_of IS NOT NULL` |

**Response `200`**

```json
{
  "data": [
    {
      "canonical_shot_id":        "01HVXYZ1234567890ABCDEFGH",
      "vendor":                   "trackpro",
      "vendor_shot_id":           "tp-2026-05-20-aabbccdd",
      "vendor_user_id":           "player-42",
      "canonical_user_id":        "01HVUSR1234567890ABCDEFGH",
      "club_code":                "7I",
      "club_raw":                 "7I",
      "ball_speed_mps":           54.2,
      "club_head_speed_mps":      38.1,
      "launch_angle_deg":         17.3,
      "spin_rpm":                 7100,
      "carry_m":                  145.0,
      "total_m":                  152.0,
      "lateral_m":                -1.2,
      "captured_at_utc":          "2026-05-20T02:00:00.000Z",
      "captured_at_tz_offset_min": null,
      "received_at_utc":          "2026-05-20T02:00:00.123Z",
      "duplicate_of":             null
    }
  ],
  "paging": {
    "next_cursor": "01HVXYZ...",
    "has_more":    true
  }
}
```

#### `GET /v1/users/by-vendor/:vendor/:vendor_user_id/shots`

Same response shape and query parameters as above, but scoped to a `(vendor, vendor_user_id)` pair. Useful before cross-vendor identity unification has been configured, or for vendor-level diagnostics.

| Path parameter | Values |
|---|---|
| `vendor` | `trackpro` · `swingmetric` · `proswing` |
| `vendor_user_id` | Vendor-scoped user identifier (URL-encoded if it contains special characters) |

---

### Stats

Auth: `Authorization: Bearer <INTERNAL_API_KEY>` — required in production.

Returns aggregate per-club statistics. Percentile computation (p50, p90) is performed in TypeScript using a sort-based algorithm in the application layer — no database-specific window functions are required.

#### `GET /v1/users/:user_id/stats`

**Query parameters:** `since`, `until`, `club` — same semantics as shots query.

**Response `200`**

```json
{
  "by_club": [
    {
      "club_code":             "7I",
      "count":                 48,
      "carry_p50_m":           143.5,
      "carry_p90_m":           159.2,
      "ball_speed_mean_mps":   54.1,
      "ball_speed_stddev_mps": 1.4,
      "lateral_mean_m":        0.7
    },
    {
      "club_code":             "DR",
      "count":                 23,
      "carry_p50_m":           238.0,
      "carry_p90_m":           261.5,
      "ball_speed_mean_mps":   72.3,
      "ball_speed_stddev_mps": 2.1,
      "lateral_mean_m":        -2.1
    }
  ],
  "totals": { "total_shots": 71 }
}
```

#### `GET /v1/users/by-vendor/:vendor/:vendor_user_id/stats`

Same response shape, scoped to a single `(vendor, vendor_user_id)` pair.

---

### Identity

Auth: `Authorization: Bearer <INTERNAL_API_KEY>` — required in production.

The identity API maps vendor-scoped user identifiers to a canonical user ID. When a mapping is created, all existing shots for that `(vendor, vendor_user_id)` that have `canonical_user_id IS NULL` are backfilled immediately. New shots are resolved at ingest time by the worker.

#### `POST /v1/users/:canonical_user_id/identities`

Links a vendor account to a canonical user.

**Request headers**

| Header | Required | Description |
|---|---|---|
| `Idempotency-Key` | No | UUID — replays the same `201` response for 24 h on retry |

**Path parameters**

| Parameter | Description |
|---|---|
| `canonical_user_id` | ULID assigned by the Portal BFF's user service |

**Request body**

```json
{ "vendor": "trackpro", "vendor_user_id": "player-42" }
```

| Field | Type | Values |
|---|---|---|
| `vendor` | string | `trackpro` · `swingmetric` · `proswing` |
| `vendor_user_id` | string | Vendor-scoped identifier, 1–255 chars |

**Response `201`**

```json
{
  "vendor":           "trackpro",
  "vendor_user_id":   "player-42",
  "canonical_user_id": "01HVUSR1234567890ABCDEFGH",
  "created_at":       "2026-05-20T02:00:00.000Z",
  "updated_at":       "2026-05-20T02:00:00.000Z"
}
```

Response `Location` header: `/v1/users/:canonical_user_id/identities`

#### `GET /v1/users/:canonical_user_id/identities`

Returns all vendor accounts linked to a canonical user.

**Response `200`** — array of identity objects (same shape as POST 201 body).

#### `DELETE /v1/users/:canonical_user_id/identities/:vendor/:vendor_user_id`

Removes a vendor identity mapping. **Shots already written to the database retain their `canonical_user_id`** — the audit trail is never modified. Only the mapping entry is deleted.

**Response:** `204 No Content`

**Error responses:** `400` if vendor is unrecognised; `404` if the mapping does not exist.

---

### Health and observability

These endpoints are excluded from the `/v1` prefix and from rate limiting.

#### `GET /healthz` — liveness probe

Returns `200` immediately if the process is running. No dependency checks. Use as the Kubernetes/ECS liveness probe.

```json
{ "status": "ok", "timestamp": "2026-05-20T02:00:00.000Z" }
```

#### `GET /readyz` — readiness probe

Checks Postgres (via `SELECT 1`) and Redis (via `PING`). Returns `200` if both pass; `503` if either fails. Use as the Kubernetes/ECS readiness probe.

```json
{
  "status": "ok",
  "info": {
    "db":    { "status": "up" },
    "redis": { "status": "up" }
  },
  "error":   {},
  "details": { "db": { "status": "up" }, "redis": { "status": "up" } }
}
```

#### `GET /metrics` — Prometheus metrics

Returns metrics in the Prometheus text-based exposition format (`text/plain; version=0.0.4`). Auth: `Authorization: Bearer <INTERNAL_API_KEY>`.

Scrape endpoint for Prometheus: `http://<host>:3000/metrics`.

#### `GET /api/docs` — OpenAPI / Swagger UI

Available in non-production environments only (`NODE_ENV != production`). Provides an interactive API explorer. In production, this endpoint does not exist — it is not registered by the application.

---

## Vendor payload formats

### Wire format comparison

| Feature | TrackPro | SwingMetric | ProSwing |
|---|---|---|---|
| Shots per request | 1 | 1–500 | 1 |
| Unit system | SI (m, m/s) | Imperial (yd, mph) | Configurable per field (mph/kph/mps, yd/m/ft) |
| Shot identifier | `shot_uid` | None — derived from player+device+timestamp | `shot.id` |
| User identifier | `user_external_id` | `player.id` | `user_token` (V1/V2) or `player.id` (V3) |
| Timestamp format | ISO-8601 UTC | Unix milliseconds | ISO-8601 with optional UTC offset |
| Wire format versions | 1 | 2 (V1/V2 field aliases) | 3 (detected by structure, O(1)) |

### Normalisation

All vendor parsers convert measurements to the internal SI schema before enqueuing:

| Measurement | Stored unit | Conversion |
|---|---|---|
| Ball speed | m/s | mph × 0.44704; kph × 0.27778 |
| Club head speed | m/s | Same conversions |
| Carry distance | m | yd × 0.9144; ft × 0.3048 |
| Total distance | m | Same conversions |
| Lateral deviation | m | Same conversions (sign preserved) |
| Launch angle | degrees | No conversion — all vendors use degrees |
| Spin rate | RPM | No conversion — all vendors use whole RPM |

### Club code normalisation

The normaliser maps vendor-specific club strings to a 25-value canonical enum:

`DR · 3W · 4W · 5W · 7W · 2H · 3H · 4H · 5H · 1I · 2I · 3I · 4I · 5I · 6I · 7I · 8I · 9I · PW · GW · AW · SW · LW · PT · UNKNOWN`

Algorithm (in order): exact match → inverted-iron pattern (`I7` → `7I`) → alias table (`"pitching wedge"` → `PW`, `"7iron"` → `7I`, etc.) → `UNKNOWN`. The original vendor string is always stored in `club_raw` for auditability and back-fill when new alias patterns are added.

---

## Webhook authentication

Controlled by the `WEBHOOK_AUTH_MODE` environment variable. All three modes are per-vendor — keys and secrets are configured independently for each vendor.

### Mode: `none` (development only)

All requests accepted without any credential check. **Forbidden in production** — the env schema crashes the process at startup if `NODE_ENV=production` and `WEBHOOK_AUTH_MODE=none`.

### Mode: `api_key`

The vendor sends a static API key in the `X-Webhook-Auth` header. Verified using `crypto.timingSafeEqual` to prevent timing attacks.

```bash
curl -X POST http://localhost:3000/v1/webhooks/trackpro \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Auth: your-trackpro-api-key' \
  -d '{...}'
```

Required env vars: `TRACKPRO_API_KEY`, `SWINGMETRIC_API_KEY`, `PROSWING_API_KEY`.

### Mode: `hmac`

HMAC-SHA256 signature verification with replay-window protection. The vendor signs the request as follows:

1. Take the current Unix timestamp in seconds: `ts = floor(Date.now() / 1000)`
2. Construct the signed payload string: `signed_payload = "${ts}.${raw_request_body}"`
3. Compute: `signature = HMAC-SHA256(secret, signed_payload).hex()`
4. Send headers: `X-Webhook-Timestamp: ${ts}` and `X-Webhook-Signature: sha256=${signature}`

The service:
- Rejects requests where `|now - ts| > 300 seconds` (5-minute replay window)
- Verifies the signature using `crypto.timingSafeEqual` after computing the expected value
- Reads the raw request body before any JSON parsing via a Fastify `preParsing` hook

```bash
TS=$(date +%s)
BODY='{"type":"shot.recorded",...}'
SIG=$(echo -n "${TS}.${BODY}" | openssl dgst -sha256 -hmac "your-proswing-hmac-secret" | awk '{print "sha256="$2}')

curl -X POST http://localhost:3000/v1/webhooks/proswing \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Timestamp: ${TS}" \
  -H "X-Webhook-Signature: ${SIG}" \
  -d "${BODY}"
```

Required env vars: `TRACKPRO_HMAC_SECRET`, `SWINGMETRIC_HMAC_SECRET`, `PROSWING_HMAC_SECRET`.

Authentication failures increment `pureplay_ingest_auth_failures_total{vendor, mode}` and emit a structured `WARN` log with the vendor name and request path. The response is always `401 Unauthorized` without details that would aid an attacker.

---

## Rate limiting

All endpoints are rate-limited per source IP using `@nestjs/throttler` backed by Redis (`@nest-lab/throttler-storage-redis`). Limits are shared across all API replicas — a client that hits replica A has already consumed quota that replica B will enforce.

### Tiers

| Tier name | Applies to | Limit | Window |
|---|---|---|---|
| `webhook` | `POST /v1/webhooks/*` | 200 requests | per second |
| `query` | `GET /v1/users/*/shots`<br>`GET /v1/users/*/stats`<br>`GET /v1/users/*/identities` | 50 requests | per second |
| `write` | `POST /v1/users/*/identities`<br>`DELETE /v1/users/*/identities/*` | 100 requests | per second |
| `default` | All other `/v1/*` routes | 1 000 requests | per minute |

`/healthz`, `/readyz`, and `/metrics` are exempt from all throttlers.

### Throttle response

```json
{
  "error_code":     "TOO_MANY_REQUESTS",
  "message":        "Too many requests. Please retry after the limit window.",
  "correlation_id": "..."
}
```

Webhook callers should implement exponential backoff starting at 1 second, with jitter, and a maximum of 60 seconds.

### Disabling for load tests

Set `THROTTLE_ENABLED=false` when running k6 or similar load tests from a single IP. This bypasses all throttlers. **Never set this in production** — the env schema crashes the process at startup if `NODE_ENV=production` and `THROTTLE_ENABLED=false`.

---

## Deduplication

Two independent layers prevent double-storing shots. Neither layer deletes data — all deduplication is soft.

### Layer 1 — Exact deduplication (`idempotency_key`)

A deterministic string key is computed per shot before enqueuing. The key is used as the BullMQ `jobId`, which causes BullMQ to silently ignore re-submitted jobs, and as the database uniqueness constraint on `(vendor, idempotency_key)`, which causes the `INSERT` to be a no-op via `ON CONFLICT DO NOTHING`.

| Vendor | Key scheme | Rationale |
|---|---|---|
| TrackPro | `tp\|<shot_uid>` | `shot_uid` is stable across retransmissions |
| SwingMetric | `sm\|<player.id>\|<device_id>\|<floor(ts_ms/1000)>` | No shot ID — player+device+1-second bucket is stable across firmware retransmission |
| ProSwing | `ps\|<shot.id>` | `shot.id` is stable across retransmissions |

The uniqueness constraint is `(vendor, idempotency_key)` — not just `idempotency_key` — because different vendors could independently generate the same string.

### Layer 2 — Near-deduplication (`content_hash`)

Identifies physically equivalent shots that arrive with different idempotency keys (e.g. same shot from two different vendors, or SwingMetric retransmission that uses a slightly different timestamp). The hash is SHA-256 over seven normalised fields:

```
vendor_user_id
+ club_code
+ minute_bucket(captured_at_utc)   ← rounded to nearest minute
+ round(ball_speed_mps, 1)
+ round(launch_angle_deg, 1)
+ round(carry_m, 0)
+ round(lateral_m, 0)
```

Rounding is load-bearing: different vendor smoothing algorithms produce slightly different raw values for the same physical event. Rounding absorbs measurement noise without collapsing genuinely distinct consecutive shots.

When a match is found within ±60 seconds, the newer shot's `duplicate_of` FK is set to point to the earlier shot's `canonical_shot_id`. Near-duplicate shots are excluded from query results by default (`include_near_duplicates=false`).

### Why shots are never deleted

1. Near-deduplication can produce false positives. A player who hits two identical 7-irons in quick succession can have the second flagged as a near-duplicate. False positives must be reversible: `UPDATE shots SET duplicate_of = NULL WHERE ...` is always safe.
2. Identity resolution is asynchronous. A shot that appears to duplicate another user's shot today may turn out to belong to the same canonical user after identity linking, making it a genuine duplicate — or a different user, making it a false positive. The correct classification is only knowable after the identity graph is populated.

---

## Metrics

Metrics are exposed at `GET /metrics` in Prometheus text format. Scrape interval: recommend 15 s.

### Metric catalogue

| Metric | Type | Labels | Description |
|---|---|---|---|
| `pureplay_ingest_shots_total` | Counter | `vendor`, `outcome`, `parser_version` | Total shots processed, by outcome |
| `pureplay_ingest_e2e_lag_ms` | Histogram | `vendor` | Time from HTTP receipt to DB write completion |
| `pureplay_ingest_near_duplicates_total` | Counter | `vendor` | Near-duplicate detections (`duplicate_of` set) |
| `pureplay_ingest_queue_depth` | Gauge | — | Current BullMQ waiting job count, polled every 10 s |
| `pureplay_ingest_jobs_failed_total` | Counter | `vendor` | Jobs exhausting all 5 retry attempts (dead-lettered) |
| `pureplay_ingest_auth_failures_total` | Counter | `vendor`, `mode` | Webhook authentication failures |

### Label values

**`outcome`** on `pureplay_ingest_shots_total`:

| Value | Meaning |
|---|---|
| `accepted` | Shot successfully written to the database |
| `deduplicated` | Exact dedup — `idempotency_key` already existed |
| `rejected_clock` | Clock skew > 24h past or > 5min future |

**`mode`** on `pureplay_ingest_auth_failures_total`: `api_key` · `hmac`

### Alert recommendations

| Condition | Severity | Action |
|---|---|---|
| `pureplay_ingest_jobs_failed_total` rate > 0 | P1 | Shots are being permanently dropped — investigate worker logs immediately |
| `pureplay_ingest_e2e_lag_ms{p99}` > 60 000 ms | P2 | Queue backlog or slow Postgres writes |
| `pureplay_ingest_queue_depth` > 8 000 | P2 | Worker falling behind — scale workers or investigate slow DB |
| `pureplay_ingest_near_duplicates_total` rate > 10/min (single vendor) | P3 | Possible vendor SDK retransmission storm or false-positive hash collision |
| `pureplay_ingest_auth_failures_total` sustained rate | P3 | Misconfigured vendor SDK or potential credential probing |

---

## Environment variables

All variables are validated at startup via Zod (`src/config/env.schema.ts`). The process exits with a descriptive error if any required variable is missing or fails a constraint.

### Required (no default — process crashes if absent)

| Variable | Example | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://pureplay:pureplay@localhost:5432/pureplay_ingest` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |

### Application

| Variable | Default | Allowed values | Description |
|---|---|---|---|
| `NODE_ENV` | `development` | `development` · `test` · `production` | Runtime environment. Controls logging format and production safety gates. |
| `PORT` | `3000` | 1–65535 | HTTP listen port |
| `RUN_MIGRATIONS` | `false` | `true` · `false` | Run SQL migrations from `migrations/` on startup |
| `OTEL_SERVICE_NAME` | `pureplay-analytics-ingest` | string | OpenTelemetry service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | URL | OTLP gRPC endpoint for traces/metrics (e.g. `http://otel-collector:4317`) |

### Security

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_AUTH_MODE` | `none` | `none` (dev only) · `api_key` · `hmac`. **`none` is forbidden in production.** |
| `INTERNAL_API_KEY` | — | Bearer token for `/v1/users/*` and `/metrics` endpoints. Minimum 32 characters. Required in production. Generate: `openssl rand -hex 32` |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` value. Must be a specific origin (e.g. `https://app.example.com`) in production. **`*` is forbidden in production.** |

### Webhook credentials

Required only when `WEBHOOK_AUTH_MODE` matches. Service crashes at startup with a clear error if the expected credential is missing.

| Variable | Required when | Description |
|---|---|---|
| `TRACKPRO_API_KEY` | `api_key` | TrackPro static API key |
| `SWINGMETRIC_API_KEY` | `api_key` | SwingMetric static API key |
| `PROSWING_API_KEY` | `api_key` | ProSwing static API key |
| `TRACKPRO_HMAC_SECRET` | `hmac` | TrackPro HMAC-SHA256 signing secret |
| `SWINGMETRIC_HMAC_SECRET` | `hmac` | SwingMetric HMAC-SHA256 signing secret |
| `PROSWING_HMAC_SECRET` | `hmac` | ProSwing HMAC-SHA256 signing secret |

### Queue and performance

| Variable | Default | Constraints | Description |
|---|---|---|---|
| `MAX_QUEUE_DEPTH` | `10000` | ≥1 | BullMQ backpressure threshold. API returns `503` when waiting job count reaches this value. |
| `WORKER_CONCURRENCY` | `16` | 1–64 | Concurrent jobs per worker replica. Two replicas run by default (32 total). |
| `DB_POOL_MAX` | `20` | 1–100 | PostgreSQL connection pool maximum. Recommended: `WORKER_CONCURRENCY + 4` for worker processes. |
| `THROTTLE_ENABLED` | `true` | `true` · `false` | Set `false` to disable rate limiting during load tests. **Forbidden in production.** |
| `QUEUE_NAME` | `shot-ingestion` | string | BullMQ queue name. Must match between API and worker processes. |

---

## Production deployment

### Minimum production environment

```bash
# Required
DATABASE_URL=postgresql://user:pass@db-host:5432/pureplay_ingest
REDIS_URL=redis://redis-host:6379

# Environment
NODE_ENV=production

# Security — all four are enforced by the startup check
WEBHOOK_AUTH_MODE=api_key        # or hmac
INTERNAL_API_KEY=<openssl rand -hex 32>
CORS_ORIGIN=https://app.example.com
THROTTLE_ENABLED=true

# Webhook credentials
TRACKPRO_API_KEY=<secret>
SWINGMETRIC_API_KEY=<secret>
PROSWING_API_KEY=<secret>

# Performance (tune to your instance size)
WORKER_CONCURRENCY=16
DB_POOL_MAX=20
MAX_QUEUE_DEPTH=10000

# Observability
OTEL_SERVICE_NAME=pureplay-analytics-ingest
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

### Production safety gates

The environment schema (`src/config/env.schema.ts`) applies cross-field validation at startup. Any of the following conditions will crash the process with a descriptive error when `NODE_ENV=production`:

| Condition | Error |
|---|---|
| `WEBHOOK_AUTH_MODE=none` | `WEBHOOK_AUTH_MODE cannot be "none" in production.` |
| `THROTTLE_ENABLED=false` | `THROTTLE_ENABLED cannot be false in production.` |
| `INTERNAL_API_KEY` unset or < 32 chars | `INTERNAL_API_KEY must be set (min 32 chars) in production.` |
| `CORS_ORIGIN='*'` | `CORS_ORIGIN cannot be "*" in production.` |

These checks prevent misconfigured deployments from silently running in an insecure state.

### Two-process deployment

The service is split into two Docker image targets:

| Target | Command | Purpose |
|---|---|---|
| `api` | `pnpm start:api` | HTTP server — stateless, horizontally scalable |
| `worker` | `pnpm start:worker` | BullMQ job processor — run 2+ replicas |

The API process does not process jobs. The worker process does not accept HTTP traffic. Both processes connect to the same Postgres and Redis.

**Recommended replica counts:**
- API: scale based on inbound HTTP RPS (each process handles hundreds of concurrent requests)
- Worker: start with 2 replicas × 16 concurrency. Scale up by adding replicas — BullMQ's distributed locking ensures each job is processed by exactly one replica.

### Migration strategy

Run migrations from the API process on startup with `RUN_MIGRATIONS=true`, or separately as a pre-deploy job:

```bash
RUN_MIGRATIONS=true pnpm start:api
```

Migrations are idempotent — safe to run on every deployment. They use `IF NOT EXISTS` for tables and a `DO...EXCEPTION` block for PostgreSQL enum types (which have no native `IF NOT EXISTS` clause).

### Health probe configuration

| Probe | Endpoint | Recommended check interval | Failure threshold |
|---|---|---|---|
| Liveness | `GET /healthz` | 15 s | 3 consecutive failures |
| Readiness | `GET /readyz` | 15 s | 1 failure |

The liveness probe never checks external dependencies. The readiness probe checks Postgres and Redis connectivity — remove the pod from the load balancer immediately on any readiness failure.

### Graceful shutdown

Both the API and worker processes call `app.enableShutdownHooks()`. On `SIGTERM`:

- The API process stops accepting new connections and drains in-flight HTTP requests.
- The worker process stops dequeuing new jobs and waits for in-flight jobs to complete before exiting.

Allow at least 30 seconds for graceful shutdown before sending `SIGKILL`.

---

## Database schema

Full DDL is in `migrations/001_init.sql`. Key tables:

### `shots`

One row per logical golf shot. Primary key is a 26-character ULID (`canonical_shot_id`). The unique index on `(vendor, idempotency_key)` is the exact deduplication mechanism.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `canonical_shot_id` | `VARCHAR(26)` | No | ULID primary key — time-sortable, monotonically generated |
| `vendor` | `vendor_enum` | No | `trackpro` · `swingmetric` · `proswing` |
| `vendor_shot_id` | `VARCHAR(255)` | Yes | Vendor's own shot ID (`shot_uid`, `shot.id`); null for SwingMetric |
| `idempotency_key` | `VARCHAR(600)` | No | Exact dedup key; unique per vendor |
| `vendor_user_id` | `VARCHAR(255)` | No | Vendor-scoped user identifier |
| `canonical_user_id` | `VARCHAR(26)` | Yes | ULID; null until identity resolved |
| `captured_at_utc` | `TIMESTAMPTZ` | No | When the shot was hit — UTC; all queries run against this |
| `captured_at_tz_offset_min` | `SMALLINT` | Yes | Original UTC offset in minutes (−720..+840); display only |
| `received_at_utc` | `TIMESTAMPTZ` | No | When the API received the webhook |
| `club_code` | `club_code_enum` | No | Normalised club code |
| `club_raw` | `VARCHAR(64)` | No | Original vendor club string — for alias back-fill |
| `ball_speed_mps` | `DOUBLE PRECISION` | No | m/s, 0–120 |
| `club_head_speed_mps` | `DOUBLE PRECISION` | Yes | m/s |
| `launch_angle_deg` | `DOUBLE PRECISION` | No | Degrees, −10–70 |
| `spin_rpm` | `INTEGER` | Yes | Whole RPM, 0–15 000 |
| `carry_m` | `DOUBLE PRECISION` | No | Metres, 0–450 |
| `total_m` | `DOUBLE PRECISION` | Yes | Metres |
| `lateral_m` | `DOUBLE PRECISION` | No | Metres; right = positive (TrackMan convention) |
| `device_id` | `VARCHAR(255)` | Yes | Launch monitor device ID |
| `session_id` | `VARCHAR(255)` | Yes | Vendor session ID |
| `content_hash` | `CHAR(64)` | No | SHA-256 hex; near-dedup identifier |
| `raw_payload` | `JSONB` | No | Complete vendor JSON — write-once, never exposed externally |
| `schema_version` | `SMALLINT` | No | Incremented on breaking normalisation changes |
| `parser_version` | `VARCHAR(20)` | No | Semver — identifies which parser code produced this row |
| `duplicate_of` | `VARCHAR(26)` | Yes | FK → `shots.canonical_shot_id` of earlier equivalent |

### `user_identities`

Maps `(vendor, vendor_user_id)` pairs to canonical user IDs.

### `ingestion_failures`

Records shots that failed clock-skew checks, parse errors, or DB write failures. `raw_body` is written via `redactPii()` — email addresses and known PII fields (`player.email`, `user_token`, `data.user_token`) are stripped before storage.

### `outbox_events`

Transactional outbox for `shot.persisted` events. Written atomically with the `shots` INSERT in a single Kysely transaction. Polled every 5 seconds by `OutboxPublisherService`, which emits the event and deletes the row. Guarantees at-least-once delivery even if the worker process crashes between the write and the in-memory emit.
