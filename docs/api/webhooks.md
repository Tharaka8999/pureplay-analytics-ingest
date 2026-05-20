# Webhook API

Webhook endpoints receive shot telemetry from hardware vendors. All three vendors post to separate endpoints; the payload schema and idempotency key scheme differ per vendor.

**Base URL:** `POST /v1/webhooks/{vendor}`
**Auth:** `WebhookAuthGuard` (mode controlled by `WEBHOOK_AUTH_MODE` env var)
**Rate limit:** 200 requests/second per endpoint (throttler tier `webhook`)

---

## Authentication

Controlled by `WEBHOOK_AUTH_MODE` env var. Three modes:

| Mode | Header | Verification |
|---|---|---|
| `none` | — | Always passes (dev only; blocked in production) |
| `api_key` | `X-Webhook-Auth: <key>` | Constant-time compare against `{VENDOR}_API_KEY` |
| `hmac` | `X-Webhook-Signature: sha256=<hex>` + `X-Webhook-Timestamp: <unix-sec>` | HMAC-SHA256 of `"<timestamp>.<raw-body>"` against `{VENDOR}_HMAC_SECRET`; 5-minute replay window |

HMAC mode requires capturing the raw request body before JSON parsing. This is done via a Fastify `preParsing` hook in `src/main.api.ts`.

**Error responses for auth failure:**

```json
{
  "type": "urn:problem:unauthorized",
  "error_code": "UNAUTHORIZED",
  "title": "Authentication failed.",
  "status": 401,
  "correlation_id": "550e8400-..."
}
```

---

## POST /v1/webhooks/trackpro

**File:** `src/webhooks/trackpro/`

TrackPro sends a single shot per request with flat SI units.

**Idempotency key scheme:** `tp|{shot_uid}`

### Request body

```json
{
  "shot_uid": "tp-2024-03-15-abc1def2",
  "user_external_id": "tp_user_456",
  "device_id": "device_789",
  "session_id": "session_001",
  "captured_at": "2024-03-15T10:30:00Z",
  "club": "7I",
  "ball_speed_mps": 55.2,
  "club_head_speed_mps": 40.1,
  "launch_angle_deg": 18.5,
  "carry_distance_m": 148.3,
  "total_distance_m": 161.0,
  "side_deviation_m": -2.1,
  "spin_rpm": 6800
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `shot_uid` | string | Yes | Format: `tp-YYYY-MM-DD-{8 hex chars}` |
| `user_external_id` | string | Yes | Vendor user identifier |
| `device_id` | string | No | Hardware device identifier |
| `session_id` | string | No | Session grouping identifier |
| `captured_at` | ISO-8601 string | Yes | Captured time; UTC or with offset |
| `club` | string | Yes | Raw club string (normalised by parser) |
| `ball_speed_mps` | number | Yes | `0–120 m/s` |
| `club_head_speed_mps` | number | No | Nullable |
| `launch_angle_deg` | number | Yes | `-10–70°` |
| `carry_distance_m` | number | Yes | `0–450 m` |
| `total_distance_m` | number | No | Nullable |
| `side_deviation_m` | number | Yes | Signed: negative = left, positive = right |
| `spin_rpm` | integer | No | `0–15 000 rpm` |

### Success response — 202

```json
{
  "status": "accepted",
  "correlation_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Error responses

| Status | `error_code` | Cause |
|---|---|---|
| 400 | `PAYLOAD_VALIDATION_FAILED` | Schema validation failure |
| 401 | `UNAUTHORIZED` | Auth guard rejection |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded |
| 503 | `SERVICE_UNAVAILABLE` | Queue at capacity (`Retry-After: 30`) |

---

## POST /v1/webhooks/swingmetric

**File:** `src/webhooks/swingmetric/`

SwingMetric sends batches of 1–500 shots. Supports V1 and V2 field name schemes — V1 names are aliased to V2 by a Zod preprocessor.

**Idempotency key scheme:** `sm|{player.id}|{device_id}|{floor(timestamp_ms / 1000)}`

The 1-second bucket means two identical SwingMetric shots within the same second are treated as exact duplicates. Shots in different seconds with the same content are caught by near-dedup.

### Request body

```json
{
  "session_id": "sm_session_001",
  "player": {
    "id": "sm_player_789",
    "email": "player@example.com"
  },
  "device": "sm_device_001",
  "shots": [
    {
      "ts_ms": 1710494400000,
      "club": "7I",
      "ball_speed_mph": 122.6,
      "swing_speed_mph": 89.7,
      "launch_deg": 19.2,
      "carry_yd": 159.3,
      "total_yd": 174.0,
      "offline_yd": 1.5,
      "spin_rpm": 6800
    }
  ]
}
```

**V1 → V2 field aliases (handled transparently):**

| V1 field | V2 field |
|---|---|
| `club_used` | `club` |
| `carry_yds` | `carry_yd` (then converted to metres) |
| `offline_yds` | `offline_yd` (then converted to metres) |
| `launch_angle` | `launch_deg` |

### Success response — 202

```json
{
  "status": "accepted",
  "correlation_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Batch capacity

Before enqueuing, the controller calls `queue.checkBatchCapacity(shots.length)`. If `waitingCount + shots.length > MAX_QUEUE_DEPTH`, the entire batch is rejected with 503.

---

## POST /v1/webhooks/proswing

**File:** `src/webhooks/proswing/`

ProSwing sends a single shot per request. Supports three schema versions, auto-detected by payload shape.

**Idempotency key scheme:** `ps|{user_token}|{shot.id}`

### Version detection

```
V3: payload.data.player exists
V2: payload has flat scalar ball_speed_mph / ball_speed_kph / ball_speed_mps fields
V1: payload has nested { value, unit } objects for each measurement
```

### Request body — V3 (latest)

```json
{
  "type": "shot.recorded",
  "data": {
    "player": {
      "id": "ps_user_abc"
    },
    "device": {
      "id": "ps_device_xyz"
    },
    "shot": {
      "id": "ps-shot-12345",
      "occurred_at": "2024-03-15T20:30:00+10:00",
      "club_code": "pitching wedge",
      "ball_speed": { "value": 120.5, "unit": "mph" },
      "club_speed": { "value": 92.3, "unit": "mph" },
      "launch_angle": 24.1,
      "carry": { "value": 138.2, "unit": "yd" },
      "total": { "value": 151.0, "unit": "yd" },
      "deviation": { "value": -1.5, "unit": "yd" },
      "spin_rpm": 8200
    }
  }
}
```

### Unit support

ProSwing can send measurements in multiple units. The parser converts all values to SI:

| Measurement | Accepted units | Conversion |
|---|---|---|
| Ball speed | `mph`, `kph`, `mps` | `× 0.44704`, `× 0.27778`, as-is |
| Club head speed | `mph`, `kph`, `mps` | Same |
| Carry / lateral | `yd`, `m` | `× 0.9144`, as-is |
| Launch angle | `deg` | As-is |
| Spin | `rpm` | As-is |

**Unit-mistag guard:** if `unit === 'mps'` and `value > 120`, the payload is rejected with 400 (`error_code: PAYLOAD_VALIDATION_FAILED`). A ball speed of 120 m/s is physically impossible — this signals the vendor sent mph or kph but labelled it as mps.

### Timezone handling

ProSwing timestamps include a UTC offset (`+10:00`). The parser:
1. Extracts and stores `captured_at_tz_offset_min` (e.g. `+10:00` → `600`).
2. Converts to UTC for `captured_at_utc`.

Both values are stored in the database to allow reconstructing the local time for display.

### Clock-skew rejection

The worker rejects shots where `captured_at_utc` is:
- More than **24 hours in the past** (retransmission lag exceeded)
- More than **5 minutes in the future** (NTP drift tolerance)

Rejected shots are written to `ingestion_failures` with `error_code: CLOCK_SKEW_EXCESSIVE` and `http_status: 0` (the sentinel value for worker-originated failures — there is no HTTP response at that point).
