# Shared Functions & Infrastructure

Functions, guards, pipes, interceptors, and filters in `src/shared/`.

---

## WebhookAuthGuard

**File:** `src/shared/auth/webhook-auth.guard.ts`

NestJS `CanActivate` guard applied to all webhook controllers. The active mode is read from `WEBHOOK_AUTH_MODE` env var on every request (no cached value — allows runtime reconfiguration without restart in development).

### Mode: `none`

Passes all requests. **Blocked in production** by the `env.schema.ts` superRefine guard.

### Mode: `api_key`

```
Header: X-Webhook-Auth: <key>
Compare: TRACKPRO_API_KEY / SWINGMETRIC_API_KEY / PROSWING_API_KEY
Method:  crypto.timingSafeEqual (constant-time)
```

Steps:
1. Read `@Vendor()` metadata from the controller handler via `Reflector`.
2. Look up `{VENDOR}_API_KEY` from env.
3. Compare provided vs expected using `timingSafeEqual` — requires equal-length buffers; length check first (definitive rejection, no timing leak).

### Mode: `hmac`

```
Headers:
  X-Webhook-Timestamp: <unix-seconds>
  X-Webhook-Signature: sha256=<hex>

Signed payload: "<timestamp>.<raw-body>"
Secret:         {VENDOR}_HMAC_SECRET
Replay window:  5 minutes (|now - timestamp| > 300 → reject)
```

`rawBody` is captured by a Fastify `preParsing` hook in `main.api.ts` before the JSON parser runs. It is stored on `req.rawBody` as a `Buffer`.

### `@Vendor(name)` decorator

```typescript
export const Vendor = (vendor: string) => SetMetadata(VENDOR_KEY, vendor);
```

Applied to each webhook controller class. The guard reads this metadata to determine which env var key to use.

---

## InternalApiGuard

**File:** `src/shared/auth/internal-api.guard.ts`

Guards query, stats, identity, and metrics endpoints.

```
Header: Authorization: Bearer <token>
Compare: INTERNAL_API_KEY env var (min 32 chars in production)
Method:  crypto.timingSafeEqual
```

**Development passthrough:** if `INTERNAL_API_KEY` is not set and `NODE_ENV !== 'production'`, the guard logs a `WARNING` and passes the request. This lets developers call the API without configuring a key locally.

---

## GlobalExceptionFilter

**File:** `src/shared/global-exception.filter.ts`

Catches all unhandled exceptions and serialises them as RFC 9457 Problem Details.

```typescript
// Output shape
{
  type: string;           // "urn:problem:{slug}"
  error_code: string;     // e.g. "PAYLOAD_VALIDATION_FAILED"
  title: string;
  status: number;
  correlation_id: string; // from x-correlation-id request header
  issues?: Array<{ path: string; code: string; message: string }>;
}
```

**Mapping logic:**

| Exception type | Status | `error_code` | Notes |
|---|---|---|---|
| `DomainError` | From `domainErrorToHttp()` | From domain error | `InvalidDateError` → 400, `IdentityNotFoundError` → 404, etc. |
| `HttpException` (NestJS native) | `exception.getStatus()` | Derived from status | 400 → `BAD_REQUEST`, 401 → `UNAUTHORIZED`, etc. |
| `ServiceUnavailableException` | 503 | `SERVICE_UNAVAILABLE` | Adds `Retry-After: 30` response header |
| `ZodValidationPipe` failure | 400 | `PAYLOAD_VALIDATION_FAILED` | Includes `issues` array with field paths |
| Unknown | 500 | `INTERNAL_SERVER_ERROR` | Error detail redacted |

Registered as `APP_FILTER` in `AppModule`, not in `main.ts`. This ensures the filter is available to `TestingModule` in tests.

---

## ZodValidationPipe

**File:** `src/shared/zod-validation.pipe.ts`

Wraps any Zod schema into a NestJS `PipeTransform`.

```typescript
// Usage in a controller
@Body(new ZodValidationPipe(TrackProSchema))
body: TrackProPayload
```

On failure, throws `BadRequestException` with:
```json
{
  "error_code": "PAYLOAD_VALIDATION_FAILED",
  "issues": [
    { "path": "shots[0].ball_speed_mps", "code": "too_small", "message": "..." }
  ]
}
```

Uses Zod v4 API: `.issues` (not `.errors`), `code: 'custom'` in `addIssue`.

---

## RequestIdInterceptor

**File:** `src/shared/request-id.interceptor.ts`

Reads the `x-correlation-id` request header (set by Fastify's `genReqId` in `main.api.ts`) and injects it into the pino log context. All log lines within a request include `correlation_id`.

Registered as `APP_INTERCEPTOR` in `AppModule`.

---

## IdempotencyInterceptor

**File:** `src/shared/idempotency/idempotency.interceptor.ts`

Redis-backed 24-hour idempotency cache. Applied to `POST /v1/users/:id/identities`.

```
Cache key: idempotency:{path}:{Idempotency-Key header value}
TTL:       86400 seconds (24h)
Cached:    only 2xx responses
```

On a cache hit: returns the cached response body with the original status code. On a cache miss: passes through, then caches the 2xx response.

**Graceful degradation:** if Redis is unavailable, logs a warning and passes the request through as normal. Never blocks on Redis failure.

---

## `redactPii(payload)`

**File:** `src/shared/pii-redact.ts`

```typescript
export function redactPii(payload: Record<string, unknown>): string
```

Called before writing to `ingestion_failures.raw_body`. Returns a JSON string with PII stripped.

Removes:
- All RFC5322 email addresses (regex `[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`)
- `payload.player.email`
- `payload.user_token`
- `payload.data.user_token`

The function mutates a deep clone, not the original object.

---

## Domain types

### `NormalisedShot` — `src/shared/domain/shot.ts`

```typescript
export type Vendor = 'trackpro' | 'swingmetric' | 'proswing';
export const VALID_VENDORS: readonly Vendor[] = ['trackpro', 'swingmetric', 'proswing'];

export interface NormalisedShot {
  canonical_shot_id: string;   // ULID from ulidx.monotonicFactory()
  vendor: Vendor;
  vendor_shot_id: string | null;
  idempotency_key: string;
  vendor_user_id: string;
  canonical_user_id: string | null;
  captured_at_utc: string;
  captured_at_tz_offset_min: number | null;
  received_at_utc: string;
  club_code: ClubCode;
  club_raw: string;
  ball_speed_mps: number;
  club_head_speed_mps: number | null;
  launch_angle_deg: number;
  spin_rpm: number | null;
  carry_m: number;
  total_m: number | null;
  lateral_m: number;           // signed: negative = left
  device_id: string | null;
  session_id: string | null;
  content_hash: string;        // from computeContentHash()
  raw_payload: Record<string, unknown>;
  schema_version: number;
  parser_version: string;
  duplicate_of: string | null; // set by checkAndFlagNearDuplicates
}
```

### `ClubCode` — `src/shared/domain/club-code.ts`

TypeScript union of all valid club codes. `normaliseClub(raw: string): ClubCode` handles common vendor aliases:
- `'7iron'` → `'7I'`
- `'I7'` → `'7I'`
- `'pitching wedge'` → `'PW'`
- `'putter'` → `'PT'`

Unknown strings return `'UNKNOWN'` (not `'UK'`).

### Unit conversions — `src/shared/domain/units.ts`

```typescript
mphToMps(mph: number): number   // × 0.44704
kphToMps(kph: number): number   // × 0.27778
ydToM(yd: number): number       // × 0.9144
ftToM(ft: number): number       // × 0.3048
```

All parsers convert vendor units to SI (m/s, m) before producing a `NormalisedShot`.

---

## Domain errors — `src/shared/errors/domain-errors.ts`

| Class | HTTP status | `error_code` |
|---|---|---|
| `InvalidCursorError` | 400 | `INVALID_CURSOR` |
| `InvalidDateError` | 400 | `INVALID_DATE` |
| `UnknownVendorError` | 400 | `UNKNOWN_VENDOR` |
| `UnknownClubCodeError` | 400 | `UNKNOWN_CLUB_CODE` |
| `IdentityNotFoundError` | 404 | `IDENTITY_NOT_FOUND` |

All extend abstract `DomainError`. `GlobalExceptionFilter` calls `domainErrorToHttp(err)` to get the status and maps it to the Problem Details response.

---

## Migration runner — `src/shared/kysely/migration-runner.ts`

`splitStatements(sql: string): string[]` splits a SQL migration file into individual statements.

**State machine tracks:**
- Single-quoted string literals (`'...'`)
- Dollar-quoted blocks (`$$...$$` or `$body$...$body$`)
- Single-line comments (`--` to end of line)
- Semicolons outside strings/comments → statement boundary

Necessary because: `pg` driver requires statements to be sent one at a time; naive split on `;` breaks on semicolons inside comments and dollar-quoted PL/pgSQL functions.

---

## Prometheus metrics — `src/shared/metrics/ingest-metrics.ts`

Lazy singleton pattern — each metric is created once at first call and re-used. Uses `try/catch` around registration to survive `prom-client` deduplication errors during test re-runs.

```typescript
getShotsTotal(): Counter       // pureplay_ingest_shots_total
getE2eLag(): Histogram         // pureplay_ingest_e2e_lag_ms
getNearDuplicates(): Counter   // pureplay_ingest_near_duplicates_total
getQueueDepth(): Gauge         // pureplay_ingest_queue_depth
getJobsFailed(): Counter       // pureplay_ingest_jobs_failed_total
getAuthFailures(): Counter     // pureplay_ingest_auth_failures_total
```

See [operations.md](../operations.md#prometheus-metrics) for the full label schema.

---

## OpenAPI / Swagger — `src/shared/openapi/openapi.ts`

`setupOpenApi(app: NestFastifyApplication): void`

Mounts Swagger UI at `/api/docs`. Called in `main.api.ts` only when `NODE_ENV !== 'production'`. Never call in production — the UI leaks the full API surface and enables live traffic against the service.

---

## OTel bootstrap — `src/shared/otel/otel.ts`

Initialises `@opentelemetry/auto-instrumentations-node`. Must be loaded via Node `--require` before the main module:

```bash
node -r ./dist/shared/otel/otel.js dist/main.api.js
```

Auto-instruments: HTTP/HTTPS, Fastify, pg (PostgreSQL), ioredis. If loaded after NestJS, the module loading phase is missed and instrumentation is incomplete.
