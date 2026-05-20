# Operations

---

## Deployment architecture

```
                   ┌──────────────────────────────┐
                   │         AWS ALB               │
                   │  (TLS termination, /healthz)  │
                   └───────────┬──────────────────┘
                               │
               ┌───────────────┴──────────────┐
               │                              │
      ┌────────▼────────┐           ┌─────────▼────────┐
      │   API replica 1 │           │  API replica 2   │
      │  :3000           │           │  :3000            │
      └────────┬────────┘           └─────────┬────────┘
               │                              │
               └──────────────┬───────────────┘
                              │
              ┌───────────────┴──────────────┐
              │         Redis 7.2            │
              │    (BullMQ queues + cache)   │
              └───────────────┬──────────────┘
                              │
              ┌───────────────┴──────────────┐
              │                              │
     ┌────────▼────────┐           ┌─────────▼────────┐
     │  Worker replica 1│           │ Worker replica 2  │
     │  concurrency 16  │           │  concurrency 16   │
     └────────┬────────┘           └─────────┬────────┘
              │                              │
              └──────────────┬───────────────┘
                             │
             ┌───────────────▼──────────────┐
             │       PostgreSQL 16          │
             │   (RDS Multi-AZ or Aurora)   │
             └──────────────────────────────┘
```

Total concurrency: 2 worker replicas × 16 = **32 concurrent shot-processing jobs**.

---

## Starting the service

### Development

```bash
docker compose up -d              # start postgres + redis
pnpm install
pnpm build
RUN_MIGRATIONS=true pnpm start:api
pnpm start:worker
```

Or in watch mode (no build step):
```bash
pnpm start:dev           # API with ts-node
pnpm start:dev:worker    # worker with ts-node
```

### Production

```bash
# Build
pnpm install --frozen-lockfile
pnpm build

# Start (separate process groups / containers)
node -r ./dist/shared/otel/otel.js dist/main.api.js
node -r ./dist/shared/otel/otel.js dist/main.worker.js
```

The `-r` flag loads OTel instrumentation before any framework code runs.

### Docker Compose (local full stack)

```bash
docker compose up            # postgres + redis + api + worker
docker compose up -d         # detached
docker compose logs -f api   # follow API logs
docker compose logs -f worker
```

---

## Environment variables

All variables are validated at startup. Missing required variables crash the process immediately.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `REDIS_URL` | **Yes** | — | Redis connection string |
| `PORT` | No | `3000` | HTTP listen port |
| `NODE_ENV` | No | `development` | `development \| production \| test` |
| `WEBHOOK_AUTH_MODE` | No | `none` | `none \| api_key \| hmac` |
| `TRACKPRO_API_KEY` | Conditional | — | When `WEBHOOK_AUTH_MODE=api_key` |
| `SWINGMETRIC_API_KEY` | Conditional | — | When `WEBHOOK_AUTH_MODE=api_key` |
| `PROSWING_API_KEY` | Conditional | — | When `WEBHOOK_AUTH_MODE=api_key` |
| `TRACKPRO_HMAC_SECRET` | Conditional | — | When `WEBHOOK_AUTH_MODE=hmac` |
| `SWINGMETRIC_HMAC_SECRET` | Conditional | — | When `WEBHOOK_AUTH_MODE=hmac` |
| `PROSWING_HMAC_SECRET` | Conditional | — | When `WEBHOOK_AUTH_MODE=hmac` |
| `INTERNAL_API_KEY` | Prod-required | — | Min 32 chars in production |
| `QUEUE_NAME` | No | `shot-ingestion` | BullMQ queue name |
| `MAX_QUEUE_DEPTH` | No | `10000` | Backpressure threshold |
| `WORKER_CONCURRENCY` | No | `16` | Jobs per worker replica |
| `DB_POOL_MAX` | No | `20` | Postgres connection pool size |
| `RUN_MIGRATIONS` | No | `false` | Run migrations on startup |
| `CORS_ORIGIN` | No | `*` | Blocked as `*` in production |
| `THROTTLE_ENABLED` | No | `true` | `false` for load tests only |
| `OTEL_SERVICE_NAME` | No | `pureplay-analytics-ingest` | OTel trace service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP endpoint URL |

**`DB_POOL_MAX` sizing:**
- API process: `DB_POOL_MAX` connections (used for identity resolution in the processor? No — processor runs in worker. API uses the pool for auth lookups indirectly.)
- Worker process: `DB_POOL_MAX` connections for up to `WORKER_CONCURRENCY` concurrent jobs.
- Set `DB_POOL_MAX` ≥ `WORKER_CONCURRENCY + 5` (headroom for health checks and outbox publisher).
- For 16 concurrency: `DB_POOL_MAX=20` is the recommended minimum.

---

## Health endpoints

| Endpoint | Auth | Behaviour |
|---|---|---|
| `GET /healthz` | None | 200 always (liveness — process is running) |
| `GET /readyz` | None | 200 if Postgres + Redis respond; 503 otherwise |

ALB / Kubernetes probe configuration:
- **Liveness probe:** `GET /healthz` — restart container if it fails 3× in 30s
- **Readiness probe:** `GET /readyz` — remove from LB if it fails; Postgres/Redis are down

---

## Prometheus metrics

Scraped at `GET /metrics` (protected by `InternalApiGuard`).

| Metric | Type | Labels | Alert threshold |
|---|---|---|---|
| `pureplay_ingest_shots_total` | Counter | `vendor`, `outcome`, `parser_version` | `outcome=failed` rate > 1% |
| `pureplay_ingest_e2e_lag_ms` | Histogram | `vendor` | p95 > 5000ms |
| `pureplay_ingest_near_duplicates_total` | Counter | `vendor` | Sudden spike (> 10× baseline) |
| `pureplay_ingest_queue_depth` | Gauge | — | > 8000 (80% of MAX_QUEUE_DEPTH) |
| `pureplay_ingest_jobs_failed_total` | Counter | `vendor` | > 0 in 5-minute window |
| `pureplay_ingest_auth_failures_total` | Counter | `vendor`, `mode` | > 10/min (possible brute force) |

`e2e_lag_ms` histogram buckets: `[50, 100, 250, 500, 1000, 2500, 5000, 10000]` ms.

---

## Load testing

See `k6-load-test.js` and the `## Load testing` section in `README.md` for full scenario details.

**Before running k6:**
```bash
THROTTLE_ENABLED=false docker compose up -d   # disable rate limiting
```

**Scenarios:**
1. `webhook_steady` — steady webhook ingest at 100 VU/s
2. `webhook_burst` — 30-second burst to 500 VU/s
3. `query_steady` — steady query load
4. `identity_link` — link/unlink operations
5. `mixed` — all combined

---

## Migrations

Migrations run in two modes:

**Automatic (recommended):** Set `RUN_MIGRATIONS=true`. The API process runs all pending migrations on startup before accepting traffic. Idempotent — re-running safe.

**Manual:**
```bash
pnpm db:migrate
```

Migration files live in `migrations/`. Add new files with monotonically increasing prefix (`004_...`). Never modify existing migration files.

The migration runner splits SQL on `;` using a state machine that handles inline comments and dollar-quoted PL/pgSQL blocks.

---

## Redis requirements

- Version: 7.2+
- AOF persistence: recommended (`appendonly yes`) to survive restarts without losing the job queue
- `maxRetriesPerRequest: null` on the ioredis client: required by BullMQ
- Cluster mode: supported (requires `BullModule.forRootAsync` configuration changes)

---

## Runbook: queue backup

**Symptom:** `pureplay_ingest_queue_depth` approaches `MAX_QUEUE_DEPTH`. Webhook endpoints begin returning 503.

**Causes:**
- Worker replicas crashed or are not running
- Postgres is down or slow (jobs fail and re-queue)
- Burst from a vendor sending a large backlog

**Steps:**
1. Check worker process health: `docker compose ps` / `kubectl get pods`
2. Check Postgres connectivity: `GET /readyz`
3. Inspect failed jobs: connect to Redis with `redis-cli`, run `LLEN bull:shot-ingestion:failed`
4. If workers are healthy and queue is growing: scale up worker replicas or increase `WORKER_CONCURRENCY`
5. If jobs are failing: check worker logs for the error and DB connectivity

---

## Runbook: authentication failures spike

**Symptom:** `pureplay_ingest_auth_failures_total` increases rapidly.

**Causes:**
- Misconfigured vendor (wrong API key or HMAC secret)
- Attacker probing the endpoint

**Steps:**
1. Check which vendor and mode: `auth_failures_total{vendor="...", mode="..."}`
2. If a specific vendor: verify `{VENDOR}_API_KEY` or `{VENDOR}_HMAC_SECRET` matches the vendor's configuration
3. If multi-vendor or unknown origin: check source IPs in ALB access logs
4. Consider temporarily blocking the offending IP range at the ALB level

---

## Runbook: high e2e lag

**Symptom:** `pureplay_ingest_e2e_lag_ms` p95 exceeds 5 seconds.

**Causes:**
- Queue backup (shots wait in Redis before processing)
- Postgres slow queries (identity resolution or upsert)
- Redis latency (identity cache miss rate high)

**Steps:**
1. Check queue depth first — high lag often follows queue backup
2. Check Postgres slow query log for `upsertIfNew` or `resolveCanonicalUserId`
3. Check Redis latency: `redis-cli latency history`
4. If identity cache miss rate is high, check Redis memory and eviction policy
