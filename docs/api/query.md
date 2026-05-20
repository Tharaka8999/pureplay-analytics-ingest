# Query API

All query endpoints require `Authorization: Bearer <INTERNAL_API_KEY>` and are intended for the Portal BFF, not end users. The Portal BFF is the auth gate — this service trusts the caller-supplied `canonical_user_id`.

**Auth:** `InternalApiGuard` (constant-time Bearer token compare)
**Rate limit:** 50 req/s (query tier) for GET endpoints; 100 req/s (write tier) for POST/DELETE

---

## Shots

### GET /v1/users/:user_id/shots

Returns shots for a canonical user, newest first. Excludes near-duplicates (`duplicate_of IS NULL`).

**Path param:** `user_id` — canonical user ULID

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | 20 | Max 100 |
| `cursor` | string | — | Opaque keyset cursor from previous response |
| `since` | ISO-8601 | — | Filter `captured_at_utc >= since` |
| `until` | ISO-8601 | — | Filter `captured_at_utc <= until` |
| `club` | string | — | Filter by club code (e.g. `7I`) |
| `include_duplicates` | boolean | false | Include near-duplicates in results |

**Example request:**

```
GET /v1/users/01HQ2RJ3P5KV9XNCT8MZBY4YDF/shots?limit=20&club=7I
Authorization: Bearer <INTERNAL_API_KEY>
```

**Example response — 200:**

```json
{
  "data": [
    {
      "canonical_shot_id": "01HQ2RJ3P5KV9XNCT8MZBY4YDF",
      "vendor": "trackpro",
      "vendor_shot_id": "TP-20240315-abc123",
      "vendor_user_id": "tp_user_456",
      "canonical_user_id": "01HQ2RJ3P5KV9XNCT8MZBY4YDF",
      "captured_at_utc": "2024-03-15T10:30:00.000Z",
      "club_code": "7I",
      "club_raw": "7I",
      "ball_speed_mps": 55.2,
      "club_head_speed_mps": 40.1,
      "launch_angle_deg": 18.5,
      "spin_rpm": null,
      "carry_m": 148.3,
      "total_m": 161.0,
      "lateral_m": -2.1,
      "duplicate_of": null
    }
  ],
  "cursor": "eyJjYXB0dXJlZF9hdF91dGMiOiIyMDI0LTAzLTE1VDEwOjMwOjAwLjAwMFoiLCJjYW5vbmljYWxfc2hvdF9pZCI6IjAxSFEyUkozUDVLVjlYTkNUOE1aQlk0WURGJ30",
  "has_more": false
}
```

**Note:** `raw_payload` is never included in API responses.

**Pagination:** Keyset cursor encoding `(captured_at_utc, canonical_shot_id)`. Pass the returned `cursor` as the `cursor` query param in the next request.

---

### GET /v1/users/by-vendor/:vendor/:vendor_user_id/shots

Same as above but identified by vendor + vendor user ID instead of canonical user ID. Useful before identity is linked.

**Path params:**
- `vendor` — `trackpro | swingmetric | proswing`
- `vendor_user_id` — vendor's user identifier

---

## Stats

### GET /v1/users/:user_id/stats

Returns per-club aggregated statistics for a canonical user over a time window.

**Path param:** `user_id` — canonical user ULID

**Query params:**

| Param | Type | Default | Notes |
|---|---|---|---|
| `since` | ISO-8601 | 30 days ago | Start of window |
| `until` | ISO-8601 | now | End of window |
| `club` | string | — | Filter to single club code |

**Example response — 200:**

```json
{
  "user_id": "01HQ2RJ3P5KV9XNCT8MZBY4YDF",
  "window": {
    "since": "2024-02-14T10:00:00.000Z",
    "until": "2024-03-15T10:00:00.000Z"
  },
  "club": null,
  "totals": {
    "shot_count": 247
  },
  "by_club": [
    {
      "club_code": "7I",
      "sample_size": 43,
      "carry_m": {
        "mean": 147.2,
        "stdev": 8.4,
        "p50": 148.0,
        "p90": 157.3
      },
      "lateral_m": {
        "mean": 1.2,
        "stdev": 6.1,
        "p50": 0.8,
        "p90": 8.9
      },
      "ball_speed_mps": {
        "mean": 54.9,
        "stdev": 2.1
      },
      "launch_angle_deg": {
        "mean": 18.7,
        "stdev": 1.3
      },
      "spin_rpm": {
        "mean": 6850,
        "stdev": 420,
        "sample_size": 28,
        "vendors_excluded": ["trackpro"]
      },
      "dispersion": {
        "lateral_sigma_m": 6.1,
        "carry_sigma_m": 8.4
      },
      "low_sample_size": false
    }
  ]
}
```

**Notes:**
- `p50` / `p90` are `null` when `sample_size < 10` (`low_sample_size: true`).
- Putters (`club_code = 'PT'`) are excluded from distance stats.
- Near-duplicates (`duplicate_of IS NOT NULL`) are excluded.
- Capped at 10,000 most-recent shots per window (safety cap for in-memory aggregation).
- Percentiles computed in TypeScript (sort-based), not SQL `PERCENTILE_CONT`.
- `spin_rpm.vendors_excluded` lists vendors that don't provide spin data for the shots in the window.

---

### GET /v1/users/by-vendor/:vendor/:vendor_user_id/stats

Same as above but identified by vendor + vendor user ID.

---

## Identity

### POST /v1/users/:canonical_user_id/identities

Links a vendor user ID to a canonical user.

**Path param:** `canonical_user_id` — ULID

**Headers:**
- `Authorization: Bearer <INTERNAL_API_KEY>`
- `Idempotency-Key: <uuid>` — Redis-backed 24h cache; same key returns cached 2xx

**Request body:**

```json
{
  "vendor": "trackpro",
  "vendor_user_id": "tp_user_456"
}
```

**Success response — 201:**

```json
{
  "id": 42,
  "vendor": "trackpro",
  "vendor_user_id": "tp_user_456",
  "canonical_user_id": "01HQ2RJ3P5KV9XNCT8MZBY4YDF",
  "created_at": "2024-03-15T10:30:00.000Z",
  "updated_at": "2024-03-15T10:30:00.000Z"
}
```

**Side effects:**
1. Upserts `user_identities` row (ON CONFLICT updates `canonical_user_id`).
2. Writes `IDENTITY_LINK` audit log row in the same transaction.
3. Invalidates Redis caches: `identity:{vendor}:{vendor_user_id}` and `identity-list:{canonical_user_id}`.
4. Backfills `shots.canonical_user_id = null` for matching vendor shots (fire-and-forget, outside TX).

---

### GET /v1/users/:canonical_user_id/identities

Lists all vendor identities linked to a canonical user.

**Response — 200:**

```json
[
  {
    "id": 42,
    "vendor": "trackpro",
    "vendor_user_id": "tp_user_456",
    "canonical_user_id": "01HQ2RJ3P5KV9XNCT8MZBY4YDF",
    "created_at": "2024-03-15T10:30:00.000Z",
    "updated_at": "2024-03-15T10:30:00.000Z"
  }
]
```

Cached in Redis for 30 seconds (`identity-list:{canonical_user_id}`). Invalidated immediately on link/unlink.

---

### DELETE /v1/users/:canonical_user_id/identities/:vendor/:vendor_user_id

Unlinks a vendor identity.

**Side effects:**
1. Deletes `user_identities` row in a transaction.
2. Writes `IDENTITY_UNLINK` audit log row in the same transaction.
3. Invalidates Redis caches.
4. **Does not** update `shots.canonical_user_id` — existing shots retain their canonical user ID for audit trail integrity.

**Success:** 204 No Content

**Error — 404:**
```json
{
  "type": "urn:problem:identity-not-found",
  "error_code": "IDENTITY_NOT_FOUND",
  "status": 404,
  "correlation_id": "..."
}
```

---

## Error response format

All errors use RFC 9457 Problem Details:

```json
{
  "type": "urn:problem:payload-validation-failed",
  "error_code": "PAYLOAD_VALIDATION_FAILED",
  "title": "Request payload validation failed.",
  "status": 400,
  "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
  "issues": [
    {
      "path": "shots[0].ball_speed_mps",
      "code": "too_small",
      "message": "Number must be greater than 0"
    }
  ]
}
```

| Status | `error_code` | Cause |
|---|---|---|
| 400 | `PAYLOAD_VALIDATION_FAILED` | Zod schema failure |
| 400 | `INVALID_DATE` | Non-parseable date in query param |
| 400 | `UNIT_MISTAG_DETECTED` | ProSwing `mps` value > 120 |
| 401 | `UNAUTHORIZED` | Auth guard rejection |
| 404 | `IDENTITY_NOT_FOUND` | Unlink target does not exist |
| 422 | `CLOCK_SKEW_EXCESSIVE` | Shot timestamp > 24h past or > 5min future |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded |
| 503 | `SERVICE_UNAVAILABLE` | Queue at capacity (header: `Retry-After: 30`) |
