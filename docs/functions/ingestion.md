# Ingestion Functions

Functions and classes in `src/ingestion/` that form the shot processing pipeline.

---

## ShotIngestionQueue

**File:** `src/ingestion/shot-ingestion.queue.ts`

Wraps a BullMQ `Queue` with backpressure guards. Used by webhook controllers to enqueue normalised shots.

### `enqueue(shot, correlationId, receivedAtUtc)`

```typescript
async enqueue(
  shot: NormalisedShot,
  correlationId: string,
  receivedAtUtc: string,
): Promise<{ jobId: string }>
```

Checks queue depth before enqueuing. Throws `ServiceUnavailableException` if `waitingCount >= MAX_QUEUE_DEPTH`.

**Job options applied:**
- `jobId = shot.idempotency_key` — BullMQ deduplicates jobs with the same `jobId`. A duplicate job is silently ignored without error.
- `attempts = 5` — exponential backoff starting at 1 second.
- `removeOnComplete = { age: 86400 }` — completed jobs removed after 1 day.
- `removeOnFail = { age: 86400 * 7 }` — failed jobs retained 7 days for ops inspection.

### `checkBatchCapacity(batchSize)`

```typescript
async checkBatchCapacity(batchSize: number): Promise<void>
```

Called by SwingMetric controller **before** `Promise.all(shots.map(enqueue))`. Reads queue depth once and rejects the whole batch if `depth + batchSize > MAX_QUEUE_DEPTH`.

Without this, a 500-shot batch can overflow by up to 499 because all per-shot `enqueue()` calls read depth before any write lands (TOCTOU race).

### Queue depth polling

`onModuleInit()` starts a `setInterval` every 10 seconds that reads `queue.getWaitingCount()` and updates the `pureplay_ingest_queue_depth` Prometheus gauge. Redis failures during polling are logged as warnings and do not crash the interval.

---

## ShotIngestionProcessor

**File:** `src/ingestion/shot-ingestion.processor.ts`

BullMQ `@Processor` that consumes jobs from the `shot-ingestion` queue. Runs in the **worker process only**.

```typescript
@Processor(SHOT_INGESTION_QUEUE, { concurrency: 16 })
```

16 concurrent jobs per worker replica. With 2 replicas the cluster processes 32 jobs simultaneously.

### `process(job)`

Full processing pipeline for each job:

```
1. hasExcessiveClockSkew?
   → yes: recordIngestionFailure, increment rejected_clock metric, return
   → no: continue

2. resolveCanonicalUserId(vendor, vendor_user_id)
   → Redis cache (60s TTL) → Postgres fallback
   → null if no mapping yet

3. upsertIfNew(resolvedShot)
   → INSERT ON CONFLICT (vendor, idempotency_key) DO NOTHING RETURNING
   → if inserted: write outbox_events in same TX
   → if duplicate: increment deduplicated metric, return

4. checkAndFlagNearDuplicates(resolvedShot)
   → SHA-256 content hash match within ±60s window
   → sets duplicate_of FK if match found

5. getShotsTotal().inc({ vendor, outcome: 'accepted', parser_version })
6. getE2eLag().observe({ vendor }, Date.now() - receivedAtUtc)
```

### `onFailed(job, error)`

Fires when a job exhausts all 5 retry attempts. Logs at `warn` level (not `error` — expected under transient DB/network issues). Increments `pureplay_ingest_jobs_failed_total`.

---

## ShotRepository

**File:** `src/ingestion/shot-repository.ts`

Kysely-based repository for the `shots` and `ingestion_failures` tables.

### `upsertIfNew(shot)`

```typescript
async upsertIfNew(shot: NormalisedShot): Promise<UpsertResult>
// UpsertResult: { inserted: boolean; canonical_shot_id: string }
```

Runs in a single Kysely transaction:

1. `INSERT INTO shots ... ON CONFLICT (vendor, idempotency_key) DO NOTHING RETURNING canonical_shot_id`
2. If row returned (new shot):
   - Strips `raw_payload` from shot object (PII isolation)
   - `INSERT INTO outbox_events (event_type='shot.persisted', payload=shotWithoutPayload)`
   - Returns `{ inserted: true, canonical_shot_id }`
3. If no row returned (duplicate):
   - Fetches existing `canonical_shot_id` from DB
   - Returns `{ inserted: false, canonical_shot_id }`

The outbox write in the same transaction guarantees: event fires if and only if the shot row commits. No phantom events on rollback, no lost events on crash.

### `checkAndFlagNearDuplicates(shot)`

```typescript
async checkAndFlagNearDuplicates(shot: NormalisedShot): Promise<boolean>
```

Finds an earlier shot with the same `vendor_user_id` and `content_hash` within a ±60-second window of `captured_at_utc`. If found, sets `duplicate_of = origin.canonical_shot_id` on the newly inserted shot and returns `true`.

Near-duplicates are **not deleted**. The `duplicate_of` FK is a soft flag used to exclude them from stats and list queries.

### `recordIngestionFailure(failure)`

```typescript
async recordIngestionFailure(
  failure: Omit<InsertableIngestionFailure, 'id' | 'created_at'>,
): Promise<void>
```

Writes to `ingestion_failures`. `raw_body` **must** be passed through `redactPii()` before calling this method.

### `hasExcessiveClockSkew(capturedAtUtc, receivedAtUtc)`

```typescript
export function hasExcessiveClockSkew(
  capturedAtUtc: string,
  receivedAtUtc: string,
  maxPastSkewSeconds = 86400,   // 24h
  maxFutureSkewSeconds = 300,   // 5min
): boolean
```

Standalone exported function (not a class method). Asymmetric window:
- `capturedAt > receivedAt + 5min` → true (shot dated too far in the future)
- `capturedAt < receivedAt - 24h` → true (shot dated too far in the past)

**Not** `Math.abs()` — future skew and past skew have different tolerances because retransmission lag (past) is a normal vendor behaviour, while far-future timestamps indicate firmware bugs.

---

## computeContentHash

**File:** `src/ingestion/content-hash.ts`

```typescript
export function computeContentHash(input: ContentHashInput): string
```

SHA-256 over pipe-delimited string of 7 normalised fields:

```
vendor_user_id | club_code | minuteBucket(captured_at_utc) | ball_speed_mps(1dp) | launch_angle_deg(1dp) | carry_m(0dp) | lateral_m(0dp)
```

**Minute bucket:** ISO timestamp truncated to the minute — `"2024-03-15T10:30:45Z"` → `"2024-03-15T10:30"`.

**Rounding:** values are rounded (`Math.round`) before `toFixed` to avoid floating-point representation issues. `toFixed` alone on an already-calculated float can produce surprising results.

**Example input → hash:**
```
"tp_user_456|7I|2024-03-15T10:30|55.2|18.5|148|−2"
→ "a3f8c2..." (SHA-256 hex, 64 chars)
```

The 1-minute bucket is wide enough to catch same-shot retransmissions and narrow enough to not collide genuinely different shots played within the same minute.

---

## OutboxPublisherService

**File:** `src/ingestion/outbox-publisher.service.ts`

Polls `outbox_events` every 5 seconds (`POLL_INTERVAL_MS = 5_000`) and publishes events via EventEmitter2.

```
POLL_INTERVAL_MS = 5_000    (poll frequency)
BATCH_SIZE = 100            (rows per poll cycle)
```

**At-least-once delivery:** if the DELETE fails after the emit (e.g. DB timeout), the row remains and re-fires on the next poll cycle. Consumers must be idempotent.

**Runs in worker process only.** Having two publishers would race for the same outbox rows, causing double-fire. The worker module architecture prevents this.

---

## ShotPersistedEvent

**File:** `src/ingestion/events/shot-persisted.event.ts`

```typescript
export const SHOT_PERSISTED_EVENT = 'shot.persisted';

export interface ShotPersistedPayload {
  // All NormalisedShot fields except raw_payload
  canonical_shot_id: string;
  vendor: Vendor;
  // ... (full NormalisedShot minus PII)
}
```

`raw_payload` is explicitly excluded before writing the outbox row — it contains the full vendor payload including PII fields and must not propagate to downstream event consumers.
