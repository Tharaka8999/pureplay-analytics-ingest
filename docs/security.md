# Security

---

## Auth model

The service has two auth surfaces:

| Surface | Guard | Callers |
|---|---|---|
| Webhook endpoints | `WebhookAuthGuard` | Hardware vendor devices |
| Query / stats / identity / metrics | `InternalApiGuard` | Portal BFF (internal only) |

### `WebhookAuthGuard` — three modes

Controlled by `WEBHOOK_AUTH_MODE` env var.

**`none`** — No authentication. Passes all requests. Blocked at startup in `NODE_ENV=production` by the `env.schema.ts` superRefine guard. Use only in local development.

**`api_key`** — Static shared secret.
- Vendor sends `X-Webhook-Auth: <key>` header.
- Guard reads `{VENDOR}_API_KEY` env var.
- Comparison: `crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))`.
- Length check before `timingSafeEqual` — unequal lengths are definitively rejected without timing leak.

**`hmac`** — HMAC-SHA256 signature.
- Vendor sends `X-Webhook-Timestamp: <unix-seconds>` + `X-Webhook-Signature: sha256=<hex>`.
- Guard computes `HMAC-SHA256(secret, "<timestamp>.<raw-body>")`.
- Replay window: 5 minutes (`|now - timestamp| > 300` → reject).
- `rawBody` is captured in a Fastify `preParsing` hook before JSON parsing. Without this, the body stream is consumed and unavailable for HMAC verification.
- Comparison: `crypto.timingSafeEqual` — same constant-time guarantee as `api_key` mode.

### `InternalApiGuard`

- Reads `Authorization: Bearer <token>` header.
- Compares against `INTERNAL_API_KEY` env var (minimum 32 characters in production).
- `crypto.timingSafeEqual` — constant-time.
- Dev passthrough: if `INTERNAL_API_KEY` is unset in non-production, logs `WARNING` and passes. Never in production.

---

## Timing attack prevention

Both guards use `crypto.timingSafeEqual` for all secret comparisons. Never replace with `===`, `==`, or `.toString()` comparison — these leak key length and character values through response latency differences.

```typescript
// Safe pattern — both guards use this
const expectedBuf = Buffer.from(expectedKey, 'utf8');
const providedBuf = Buffer.from(providedKey, 'utf8');

// Length check first — definitively rejects unequal-length keys
// without a timing leak (both buffers exist but comparison is skipped)
if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
  throw new UnauthorizedException(...);
}
```

---

## PII handling

### `raw_payload` — never exposed

The `shots.raw_payload` column stores the complete vendor JSON payload, which may include user email addresses, user tokens, and other PII.

Restrictions:
- `ShotsTable` has a `[SEC]` comment marking `raw_payload` as restricted.
- `ShotsController` and `ShotsService` never select this column.
- Outbox events strip `raw_payload` before writing (`const { raw_payload: _raw, ...shotWithoutPayload } = shot`).

### PII redaction before failure logging

Every write to `ingestion_failures.raw_body` must pass through `redactPii()`:

```typescript
// src/shared/pii-redact.ts
export function redactPii(payload: Record<string, unknown>): string
```

Removes:
- RFC5322 email addresses (regex)
- `player.email`
- `user_token`
- `data.user_token`

If `redactPii()` throws (malformed payload), the processor catches the error, logs it, and stores the literal string `[PII_REDACTION_ERROR]` instead. Failure logging is never skipped.

---

## Input validation

All webhook payloads are parsed by vendor-specific Zod schemas in `src/webhooks/{vendor}/{vendor}.schema.ts`. Zod v4 schemas enforce:
- Required fields and types
- Numeric ranges (e.g. `ball_speed_mps > 0`)
- String lengths
- Enum membership (vendor codes, club codes)
- ProSwing unit-mistag guard: `unit === 'mps' && value > 120` → 400

The `ZodValidationPipe` converts Zod `ZodError` to `BadRequestException` with structured `issues` — never exposes raw internal error messages.

Query params for stats endpoints are validated by `parseWindowDate()` which throws `InvalidDateError` for non-date strings.

---

## Production boot guards

`src/config/env.schema.ts` has a `.superRefine()` that crashes the process at startup in `NODE_ENV=production` if:

| Condition | Reason |
|---|---|
| `WEBHOOK_AUTH_MODE === 'none'` | All webhooks are unauthenticated |
| `THROTTLE_ENABLED === false` | Rate limiting disabled — DoS surface |
| `INTERNAL_API_KEY` unset or < 32 chars | Internal API unprotected |
| `CORS_ORIGIN === '*'` | Any origin can make credentialed requests |

These are fatal crashes, not warnings. The service does not start in a misconfigured state.

---

## Rate limiting

`@nestjs/throttler` with three tiers:

| Tier | `ttl` | `limit` | Applied to |
|---|---|---|---|
| `webhook` | 1000ms | 200 | All three webhook endpoints |
| `query` | 1000ms | 50 | GET shots, stats, identity list |
| `write` | 1000ms | 100 | POST identity link, DELETE identity unlink |

`THROTTLE_ENABLED=false` disables all throttlers (for k6 load tests). Blocked in production.

---

## Backpressure (DoS mitigation)

`ShotIngestionQueue.enqueue()` checks BullMQ's waiting job count before adding a job. If `waitingCount >= MAX_QUEUE_DEPTH (10000)`, it throws `ServiceUnavailableException` with `retryAfter: 30`. The `GlobalExceptionFilter` maps this to a `503 Retry-After: 30` response.

Batch ingestion (SwingMetric) calls `checkBatchCapacity(n)` before enqueueing, preventing a 500-shot batch from overflowing the cap by 499 via a TOCTOU race.

---

## CORS

CORS headers are added by a Fastify `onRequest` hook in `main.api.ts`:
- `Access-Control-Allow-Origin: {CORS_ORIGIN}` (default `*`, blocked in production)
- `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`
- `Access-Control-Allow-Headers: Content-Type,Authorization,X-Correlation-ID,X-Webhook-Auth,X-Webhook-Timestamp,X-Webhook-Signature`

`OPTIONS` preflight requests are intercepted by a second hook and return `204` immediately.

---

## Security headers

`@fastify/helmet` is registered globally in `main.api.ts`:
- `Content-Security-Policy`: disabled (API only — CSP is the portal's concern)
- All other Helmet defaults apply: `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `X-XSS-Protection`, `Referrer-Policy`

---

## IDOR trust boundary

**This service trusts the caller-supplied `canonical_user_id`.**

The Portal BFF is the auth gate. It authenticates the end user, determines their canonical ID, and passes it in the request path or body. This service does not verify that the calling user owns the canonical ID — it is internal-API-only and the BFF enforces that boundary.

This design decision is documented in the README and DESIGN.md. Do not attempt to add user-level auth in this service without updating the architecture.

---

## Audit log

All identity mutations write an immutable row to `audit_log`:

| Action | Trigger |
|---|---|
| `IDENTITY_LINK` | POST /v1/users/:id/identities |
| `IDENTITY_UNLINK` | DELETE /v1/users/:id/identities/:vendor/:vid |
| `IDENTITY_LIST` | GET /v1/users/:id/identities |

The link and unlink writes run inside the same Kysely transaction as the mutation. The list write is fire-and-forget (async, does not block the response).

`actor` defaults to `'internal-api'`. The Portal BFF should send `X-Actor-ID` to identify the operator; the identity controller reads this header and passes it to `IdentityService`. Without it, audit entries show `'internal-api'` only.

---

## Secrets inventory

| Secret | Env var | Min length | Used by |
|---|---|---|---|
| TrackPro API key | `TRACKPRO_API_KEY` | — | `WebhookAuthGuard` (api_key mode) |
| SwingMetric API key | `SWINGMETRIC_API_KEY` | — | `WebhookAuthGuard` (api_key mode) |
| ProSwing API key | `PROSWING_API_KEY` | — | `WebhookAuthGuard` (api_key mode) |
| TrackPro HMAC secret | `TRACKPRO_HMAC_SECRET` | — | `WebhookAuthGuard` (hmac mode) |
| SwingMetric HMAC secret | `SWINGMETRIC_HMAC_SECRET` | — | `WebhookAuthGuard` (hmac mode) |
| ProSwing HMAC secret | `PROSWING_HMAC_SECRET` | — | `WebhookAuthGuard` (hmac mode) |
| Internal API key | `INTERNAL_API_KEY` | 32 chars | `InternalApiGuard` |

Never commit secret values. Store in a secrets manager (AWS Secrets Manager, HashiCorp Vault, or equivalent) and inject via environment at deploy time.
