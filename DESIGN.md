# DESIGN.md — Pureplay Analytics Ingest

> Concise RFC covering the seven core design questions. Full reasoning, SQL DDL, sequence diagrams, and extended analysis are in [`DESIGN-FULL.md`](./DESIGN-FULL.md).

---

## Q1. Normalised shot schema — what and why

Three vendors send incompatible formats: TrackPro sends SI flat JSON; SwingMetric batches up to 500 shots in imperial with two field-name variants; ProSwing wraps each shot in a typed `{value, unit}` envelope with configurable unit systems. The normalised schema makes every vendor detail invisible past the ingest boundary — one row per logical shot, all measurements in SI.

**Key type decisions**

| Column | Type | Rationale |
|---|---|---|
| `canonical_shot_id` | `VARCHAR(26)` ULID | Time-sortable — clusters inserts at B-tree right edge, avoids UUID page splits. Monotonic factory gives 500 distinct IDs within one millisecond (SwingMetric batch). |
| `idempotency_key` | `VARCHAR(600)` UNIQUE | Exact dedup at the DB constraint, no read-before-write, no race. Per-vendor scheme: `tp\|{shot_uid}`, `sm\|{player}\|{device}\|{floor(ts_ms/1000)}`, `ps\|{user_token}\|{shot.id}`. |
| `captured_at_utc` | `TIMESTAMPTZ` | All queries, window calculations, and clock-skew checks run against UTC. |
| `captured_at_tz_offset_min` | `SMALLINT` | Local offset preserved for display. Minutes — not hours — because half-hour and quarter-hour zones exist (India, Nepal). |
| `club_code` | `club_code_enum` | 24-value DB enum for groupability. Normalises `I7`→`7I`, `7iron`→`7I`, `pitching wedge`→`PW`. |
| `club_raw` | `VARCHAR(64)` | Original vendor string. When we add vendor D with unknown aliases, `club_code` can be back-filled from `club_raw` without re-transmission. |
| `ball_speed_mps` | `DOUBLE PRECISION` | SI throughout. Storing source units would require per-vendor CASE branches in every aggregation query — unmaintainable when vendor D ships. `DOUBLE PRECISION` not `NUMERIC`: physics precision is far coarser than 15 significant digits; hardware-native float is significantly faster for aggregations. Storing in metres (not yards) keeps constants, conversion factors, and range checks directly verifiable against published physics; the display layer converts `carry_m × 1.09361` to yards at render time. Storing in yards then converting to metres for physics then back to yards for display accumulates floating-point rounding error on every round trip. |
| `lateral_m` | `DOUBLE PRECISION` signed | Right-of-target is positive (TrackMan convention, used by all three vendors and the golf coaching literature). Signed float means one pass over the column yields both mean lateral error (bias indicator) and standard deviation (dispersion indicator). |
| `spin_rpm` | `INTEGER` nullable | No launch monitor reports fractional RPM. Nullable: `0` RPM is physically meaningful; `NULL` means the vendor didn't measure it. |
| `content_hash` | `CHAR(64)` SHA-256 | Near-dedup. Hash inputs: `(vendor_user_id, club_code, minute-bucket, ball_speed_mps ×0.1, launch_angle_deg ×0.1, carry_m ×1, lateral_m ×1)`. Rounding absorbs sensor noise without collapsing genuinely distinct shots. |
| `raw_payload` | `JSONB` | Complete vendor JSON. Write-once, never returned externally. Enables re-normalisation when a parser bug is found — no vendor re-transmission needed. |
| `schema_version` / `parser_version` | `SMALLINT` / `VARCHAR(20)` | Target re-processing cohorts: `WHERE schema_version = 1 AND parser_version < '1.2.0'`. |
| `duplicate_of` | FK → `canonical_shot_id` | Soft dedup only — no hard deletes. Near-dedup false positives are reversible with `UPDATE … SET duplicate_of = NULL`. |

**What we drop and why:** `player.email` from SwingMetric (PII — belongs in the Portal BFF user table, not a high-throughput ingest row). Session aggregates (no current query requirement; build as a read model on top). Derived fields like smash factor and strokes-gained (derivable at query time; storing them creates a consistency risk if source columns are corrected).

**What comes next:** `face_angle_deg` and `path_deg` (explain *why* a shot went where it did — both vendors record internally but don't expose in current webhooks). Monthly partition on `captured_at_utc` at ~50–100M rows (18–24 months at projected volume; transparent to Kysely).

---

## Q2. Deduplication

**Layer 1 — Exact (`idempotency_key` UNIQUE index)**

`INSERT … ON CONFLICT (vendor, idempotency_key) DO NOTHING`. A retransmit is silently absorbed; the BullMQ job is acknowledged; the vendor gets `202` and stops retrying. The DB constraint is the dedup mechanism — no application-level read-before-write, no race.

**Layer 2 — Near (`content_hash` ± 60 s window)**

Runs in the async worker after the exact-dedup upsert. Queries for any earlier shot with the same `(vendor_user_id, content_hash)` within ±60 seconds. Match → set `duplicate_of`. Query endpoint excludes near-duplicates by default (`include_near_duplicates=false`).

**The weak point:** SwingMetric's 1-second bucket key. Two genuine shots within 1 second with identical physics to rounding precision → second shot silently dropped. Fix: use raw `ts_ms` in the key (abandoning the bucket) and rely solely on near-dedup with a ±10-second window for firmware retransmissions. Track false-positive rate with a `confidence=low` metric label.

---

## Q3. Cross-vendor user identity unification

A player uses TrackPro at home (`user_external_id: "alice_123"`) and SwingMetric at their club (`player.id: "a.smith@email.com"`). Their history is split across two `vendor_user_id` values.

**Solution: denormalised `canonical_user_id` on the shot row.**

1. `POST /v1/users/:id/identities` writes a `(vendor, vendor_user_id) → canonical_user_id` mapping and immediately back-fills `canonical_user_id` on all existing shots for that pair (UPDATE WHERE IS NULL, outside transaction so it doesn't hold the row lock).
2. At ingest time, `IdentityService.resolveCanonicalUserId(vendor, vendorUserId)` checks a Redis cache (60s TTL) before hitting Postgres. New shots get `canonical_user_id` stamped at write time.

**Why not join at query time:** query latency would depend on the identity service being healthy. Denormalisation means `/shots` never calls identity — an identity outage doesn't affect read paths.

**Edge case — same player across three vendors:** if alice has TrackPro (`tp_alice`), SwingMetric (`sm_a.smith`), and ProSwing (`ps_tok_abc`), all three `vendor_user_id` values map to the same `canonical_user_id`. Three `POST /identities` calls, one `canonical_user_id` per shot regardless of vendor. The query endpoint's `WHERE canonical_user_id = ?` returns shots from all three vendors in one index scan — no join, no union.

**Identity cache invalidation:** `linkIdentity` immediately deletes both the per-vendor resolve cache key (`identity:<vendor>:<vendorUserId>`) and the list cache key (`identity-list:<canonicalUserId>`) from Redis after the DB write commits. This ensures the next ingest for that vendor user gets the updated `canonical_user_id` in under one second, not after the 60-second TTL expires.

---

## Q4. Service under load

The API process is stateless and CPU-light — Zod validation + one Redis `XADD` per job. Redis handles ~100K ops/sec; 200 concurrent enqueues is trivial. The real bottleneck is the worker (Postgres writes). At 2 replicas × 16 concurrency = 32 concurrent jobs, each job is one `INSERT … ON CONFLICT DO NOTHING` + one `SELECT` for near-dedup. At P99, ~5ms per shot with the correct indexes. A 200-shot burst drains in ~3.2 seconds, well within the BullMQ buffer.

**Connection pool:** set `DB_POOL_MAX` to `WORKER_CONCURRENCY + 4` for worker processes; the API process only hits Postgres for identity resolution and health checks.

**Backpressure gate:** `getWaitingCount() >= MAX_QUEUE_DEPTH` → `503 Retry-After: 30` before enqueuing. Queue never grows unboundedly; the vendor SDK retries after 30 seconds once the worker has had time to drain.

**Next scale lever:** batch Postgres writes — buffer 100ms of processed jobs, write as a single multi-row INSERT. 10–100× fewer DB round-trips. Not needed until sustained throughput exceeds 100 shots/s.

---

## Q5. Failure modes I most worried about

**1. Near-duplicate false positives — silent stats corruption**

Two genuine shots within the 60-second window with identical physics → second excluded from stats with no error. Player's carry P50 silently shifts. Detect via `pureplay_ingest_near_duplicates_total{vendor, club_code}` — alert if > 10/min for any (vendor, club) pair. Recover with `UPDATE shots SET duplicate_of = NULL WHERE …` (data is never deleted). Prevent by tightening to ±10 seconds and adding a dissimilarity floor (>5m carry = never duplicate).

**2. Cross-vendor hash collision** — already safe. The hash inputs include `vendor_user_id` as the first argument, so a cross-player collision requires the same vendor user ID — impossible by definition. Verified in `content-hash.ts`. Run this daily audit to catch any future regression:

```sql
SELECT s1.canonical_shot_id, s1.vendor_user_id, s2.vendor_user_id AS duplicate_owner
FROM shots s1
JOIN shots s2 ON s1.duplicate_of = s2.canonical_shot_id
WHERE s1.vendor_user_id != s2.vendor_user_id;
```

**3. Future-dated shots from firmware bugs** — asymmetric clock-skew window: 24h past (legitimate retransmission lag) vs 5 minutes future (worst-case NTP drift). `Math.abs` would have admitted shots dated 23h in the future; the asymmetric check rejects them to `ingestion_failures` as `CLOCK_SKEW_EXCESSIVE`.

**4. Worker crash mid-job** — BullMQ stalled-job detector re-queues within 30 seconds. `ON CONFLICT DO NOTHING` makes the retry idempotent. `shot.persisted` event may be emitted twice — downstream consumers must key on `canonical_shot_id`.

---

## Q6. Instrumentation

**`pureplay_ingest_e2e_lag_ms`** — `Date.now() - new Date(receivedAtUtc).getTime()` measured in the worker after upsert. This is HTTP receipt → persistence latency, not player-hit → receipt. P99 alert threshold: 60 000 ms — longer means shot data sits in the queue long enough to be stale when the player opens the app.

**`pureplay_ingest_near_duplicates_total{vendor, club_code}`** — leading indicator of two distinct problems: spike on one vendor at all clubs = SDK retransmission storm; spike on one club at all vendors = hash function too coarse for that club (putter shots cluster tightly).

**Recommended alert thresholds for all six metrics:**

| Metric | Alert condition | Severity | Meaning |
|---|---|---|---|
| `e2e_lag_ms` p99 | > 60 000 ms | P1 | Queue not draining; shot data stale by app open |
| `queue_depth` | > 8 000 (80 % of `MAX_QUEUE_DEPTH`) | P2 | Worker falling behind |
| `jobs_failed_total` rate | > 5/min sustained | P2 | DLQ filling; shots being lost |
| `near_duplicates_total` rate | > 10/min per vendor | P3 | SDK storm or over-aggressive dedup |
| `auth_failures_total` rate | > 20/min | P2 | Vendor misconfiguration or credential attack |
| `shots_total{outcome=failed}` rate | > 1 % of ingest | P2 | Parse errors or schema mismatch |

**`WARN` log on `ingestion_failures`** — every clock-skew rejection, parse error, and DB write failure emits a structured log with `correlation_id`, `vendor`, `vendor_user_id`, `failure_reason`. Without this, a vendor sending malformed payloads is silent; with it, a support investigation takes one grep.

---

## Q7. MVP gate and what comes next

### Shipped

| Area | Detail |
|---|---|
| Ingest pipeline | TrackPro, SwingMetric (batch 1–500), ProSwing — all three wire formats, Zod validation, SI normalisation |
| Webhook auth | Three-mode guard: `none` (dev), `api_key`, `hmac`. HMAC-SHA256 `<ts>.<raw-body>`, 5-min replay window, `timingSafeEqual` |
| Identity service | `POST/GET/DELETE /v1/users/:id/identities`. Redis cache (60s), backfill on link, atomic audit log |
| Deduplication | Exact via `idempotency_key` UNIQUE + BullMQ `jobId`. Near via `content_hash` ±60s, soft-flag |
| Async processing | BullMQ, 2 replicas × 16 concurrency, AOF Redis, 5 retries with exponential backoff |
| Rate limiting | Redis-backed throttler, 4 tiers: `webhook` 200/s · `query` 50/s · `write` 100/s · `default` 1000/min |
| Observability | 6 Prometheus metrics, structured Pino logs, OpenTelemetry auto-instrumentation, `/healthz` + `/readyz` |
| Load testing | k6 script, 5 scenarios (smoke/nft/peak/load/stress), thresholds at NFR floor |

### Stage 1 — four blockers before vendors can send real shots

**1. CI pipeline** — No automated gate on PRs today. Minimum: typecheck + `pnpm test` + `pnpm test:e2e` on every PR, with Postgres and Redis as GitHub Actions service containers. Deploy job on merge to `main` pushes to staging registry.

**2. Public HTTPS endpoint** — Vendors require TLS. Architecture: `ALB (ACM cert, :443) → Target Group (HTTP :3000)`. The service's `keepAliveTimeout: 65s` already exceeds ALB's 60s idle timeout. For initial vendor testing before staging infra is ready: `ngrok http 3000` provides a temporary public HTTPS URL. Register a stable DNS subdomain (`ingest.yourapp.com`) for all permanent vendor registrations.

**3. Portal BFF auth integration** — The service trusts callers to supply an authenticated `canonical_user_id` (IDOR trust boundary, by design). The Portal BFF validates the user's JWT, extracts `canonical_user_id` from claims, and calls this service with `Authorization: Bearer <INTERNAL_API_KEY>`. One gap: `audit_log.actor` is hardcoded to `'internal-api'` — every identity operation looks like the same system actor, making per-user audit useless. The BFF must send `X-Actor-ID: <canonical_user_id>`; the identity controller must read and forward it:

```typescript
// identity.controller.ts — add @Headers('x-actor-id') to all three methods
async linkIdentity(
  @Param('canonical_user_id') canonicalUserId: string,
  @Body(new ZodValidationPipe(LinkBodySchema)) body: LinkBody,
  @Headers('x-actor-id') actorHeader: string | undefined,
  @Res({ passthrough: true }) reply: FastifyReply,
) {
  const actor = actorHeader ?? 'internal-api';
  return this.identityService.linkIdentity(
    body.vendor, body.vendor_user_id, canonicalUserId, actor,
  );
}
```

`IdentityService` already accepts `actor` — only the HTTP layer wiring is missing.

**4. Vendor webhook registration and smoke testing**

Generate an HMAC secret per vendor (`openssl rand -hex 32`), set `WEBHOOK_AUTH_MODE=hmac` in the staging env, then register the endpoint with each vendor:

| Vendor | Register at | Endpoint to register |
|---|---|---|
| TrackPro | Developer portal → Webhooks | `https://ingest.yourapp.com/v1/webhooks/trackpro` |
| SwingMetric | Partner dashboard → Integrations | `https://ingest.yourapp.com/v1/webhooks/swingmetric` |
| ProSwing | API settings → Webhook endpoints | `https://ingest.yourapp.com/v1/webhooks/proswing` |

Trigger a test shot from each vendor's dashboard. Verify with `SELECT * FROM shots ORDER BY received_at_utc DESC LIMIT 1`. Common failures: `401 Invalid HMAC signature` (secret mismatch — check signing format in `webhook-auth.guard.ts`), `400 PAYLOAD_VALIDATION_FAILED` (undocumented field in real payload — add `z.unknown().optional()` then refine), `200 OK` but shot missing (worker not running — `docker compose logs worker`). Confirm the full journey with the k6 smoke scenario against staging (`SCENARIO=smoke`, 30 seconds).

### Stage 2 — post-MVP backlog

- **X-Actor-ID propagation** — wire BFF actor through to `audit_log.actor` (small change, high audit value)
- **Monitoring alerts** — wire 6 Prometheus metrics to alerting: e2e_lag p99 > 60s (P1), queue_depth > 80% (P2), jobs_failed > 5/min (P2), auth_failures > 20/min (P2)
- **Key rotation rollover** — `*_HMAC_SECRET_PREV` env vars; guard tries current then prev; vendor rotates while old requests drain
- **Soft-delete + re-derivation** — background job re-normalises `raw_payload` for cohorts where `parser_version < current`; requires `parser_version` migration and admin trigger endpoint
- **Batch Postgres writes** — buffer 100ms of processed jobs into a single multi-row INSERT; not needed until > 100 sustained shots/s

---

## AI usage disclosure

### Tools used

**Claude Code (claude-sonnet-4-6)** — scaffold (NestJS modules, Kysely, BullMQ, Zod schemas), SQL migrations, migration runner, test suite (parsers, content hash, PII redaction), Dockerfile, docker-compose tuning.

### Example of AI output I rewrote

**`splitStatements` in `migration-runner.ts` — original:**

```typescript
function splitStatements(content: string): string[] {
  return content
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}
```

Strips full-line comments but not inline ones. Column `tz_offset_min SMALLINT, -- range −720..+840` has a semicolon inside the inline comment, which becomes a statement terminator; `sql.raw()` throws `syntax error at end of input`.

**Replacement:** a character-by-character state machine tracking dollar-quoted blocks (`$$...$$`), single-quoted literals, and single-line comments (`--`). Semicolons inside comments are never terminators. ~90 lines vs 8, but correct.

### Where the AI misled me

`import pg from 'pg'` (default import) in `kysely.module.ts` compiles fine under ts-node (`esModuleInterop: true`). In the compiled Docker output, CommonJS `require('pg')` returns the module object — not a default export — so `pg.types` was `undefined` and the service crashed:

```
TypeError: Cannot read properties of undefined (reading 'types')
```

Caught via `docker compose logs api`. Fix: `import { Pool, types } from 'pg'` — named imports work in both environments.

**Lesson:** AI doesn't distinguish "works under ts-node" from "works in compiled Node" — always verify in the target runtime.
