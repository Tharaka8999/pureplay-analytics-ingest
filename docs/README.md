# Pureplay Analytics Ingest — Documentation

Complete technical reference for the service. All diagrams are Mermaid (`.md` files render them natively in GitHub, GitLab, and most IDEs).

---

## Contents

### Architecture
- [**overview.md**](architecture/overview.md) — System context C4, two-process model, shot ingestion sequence, deduplication flowchart, identity resolution sequence
- [**modules.md**](architecture/modules.md) — Every NestJS module with its providers, imports, and exports

### API
- [**webhooks.md**](api/webhooks.md) — POST /v1/webhooks/trackpro, /swingmetric, /proswing — auth modes, schemas, idempotency key schemes, error codes
- [**query.md**](api/query.md) — GET shots, GET stats, POST/GET/DELETE identity — request/response shapes, pagination, error format

### Database
- [**schema.md**](database/schema.md) — Full ERD (Mermaid), all 9 tables with column-level docs, enum types, index strategy, migration history

### Functions
- [**ingestion.md**](functions/ingestion.md) — ShotIngestionQueue, ShotIngestionProcessor, ShotRepository, computeContentHash, OutboxPublisherService
- [**identity.md**](functions/identity.md) — IdentityService (resolveCanonicalUserId, linkIdentity, listByCanonicalUser, unlinkIdentity), AuditLogService
- [**stats.md**](functions/stats.md) — StatsService, percentile/stddev algorithms, safety cap, response shape
- [**shared.md**](functions/shared.md) — Guards, pipes, interceptors, filters, domain types, unit conversions, migration runner, metrics, OTel

### Security & Operations
- [**security.md**](security.md) — Auth model, timing-safe comparison, PII handling, input validation, rate limiting, CORS, IDOR trust boundary, secrets inventory
- [**operations.md**](operations.md) — Deployment architecture, environment variables, health endpoints, Prometheus metrics catalog, load testing, migration runbook, alert runbooks

---

## Quick reference

### All HTTP endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/v1/webhooks/trackpro` | WebhookAuthGuard | Single shot |
| `POST` | `/v1/webhooks/swingmetric` | WebhookAuthGuard | Batch 1–500 |
| `POST` | `/v1/webhooks/proswing` | WebhookAuthGuard | V1/V2/V3 schema |
| `GET` | `/v1/users/:id/shots` | InternalApiGuard | Keyset pagination |
| `GET` | `/v1/users/by-vendor/:vendor/:vid/shots` | InternalApiGuard | By vendor user |
| `GET` | `/v1/users/:id/stats` | InternalApiGuard | Per-club aggregates |
| `GET` | `/v1/users/by-vendor/:vendor/:vid/stats` | InternalApiGuard | By vendor user |
| `POST` | `/v1/users/:id/identities` | InternalApiGuard | Link; idempotent |
| `GET` | `/v1/users/:id/identities` | InternalApiGuard | List |
| `DELETE` | `/v1/users/:id/identities/:v/:vid` | InternalApiGuard | Unlink |
| `GET` | `/healthz` | None | Liveness |
| `GET` | `/readyz` | None | Readiness (Postgres + Redis) |
| `GET` | `/metrics` | InternalApiGuard | Prometheus scrape |
| `GET` | `/api/docs` | None | Swagger UI (non-production) |

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| HTTP framework | NestJS 11 + Fastify 5 | High throughput, Pino integration |
| Query builder | Kysely 0.29 | Type-safe SQL, no ORM magic |
| Job queue | BullMQ 5 + Redis 7 | Durable, retry-capable, `jobId` dedup |
| ID format | ULID (ulidx) | Sortable, URL-safe, no UUID collision |
| Dedup strategy | Exact (idempotency_key) + Near (content hash ±60s) | Handles retransmissions and within-session duplicates |
| Outbox pattern | `outbox_events` table, poll every 5s | At-least-once event delivery, crash-safe |
| Auth | `timingSafeEqual` for all comparisons | Prevents timing side-channel attacks |
| Stats aggregation | TypeScript (sort-based), not SQL | Portable, no `PERCENTILE_CONT` |
| Test DB | PostgreSQL via Docker (no SQLite) | No dialect mismatch bugs |

### Prometheus metrics quick-reference

| Metric | Type | Key labels |
|---|---|---|
| `pureplay_ingest_shots_total` | Counter | `vendor`, `outcome`, `parser_version` |
| `pureplay_ingest_e2e_lag_ms` | Histogram | `vendor` |
| `pureplay_ingest_near_duplicates_total` | Counter | `vendor` |
| `pureplay_ingest_queue_depth` | Gauge | — |
| `pureplay_ingest_jobs_failed_total` | Counter | `vendor` |
| `pureplay_ingest_auth_failures_total` | Counter | `vendor`, `mode` |
