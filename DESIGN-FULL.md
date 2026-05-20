# DESIGN.md — Pureplay Analytics Ingest

> Internal RFC for the shot ingestion service. Written for engineers inheriting this codebase. Covers schema decisions, deduplication strategy, identity unification, load behaviour, failure modes, and production instrumentation.

---

## Q1. Normalised shot schema — what and why

### The problem this schema solves

Three launch-monitor vendors send shot data. TrackPro delivers SI measurements in a flat JSON object. SwingMetric batches up to 500 shots per request in imperial units with two different sets of field names depending on API version. ProSwing wraps each shot in a typed envelope with nested `{value, unit}` measurement objects that can be in any of three unit systems, and sends time with a local timezone offset. A downstream analytics engine should not have to know any of this. The normalised schema is the contract that makes vendor specifics invisible to every consumer past the ingest boundary.

The design goal is one row per logical golf shot, all measurements in consistent units, with enough provenance stored to replay or re-derive anything dropped.

---

### The schema

**TypeScript interface — `NormalisedShot` (domain layer)**

```typescript
interface NormalisedShot {
  // Identity
  canonical_shot_id:         string;        // ULID — time-sortable, globally unique
  vendor:                    Vendor;        // 'trackpro' | 'swingmetric' | 'proswing'
  vendor_shot_id:            string | null; // vendor's own shot ID; null for SwingMetric
  idempotency_key:           string;        // per-vendor exact deduplication key

  // User
  vendor_user_id:            string;        // vendor-scoped user handle
  canonical_user_id:         string | null; // ULID; null until identity resolved

  // Time
  captured_at_utc:           string;        // ISO-8601 UTC — all queries run against this
  captured_at_tz_offset_min: number | null; // original UTC offset in minutes; for display
  received_at_utc:           string;        // server-side receipt timestamp

  // Club
  club_code:                 ClubCode;      // 'DR'|'3W'|'7I'|'PW'|'PT'|'UNKNOWN'…
  club_raw:                  string;        // original vendor string, preserved

  // Ball-flight measurements — SI throughout
  ball_speed_mps:            number;        // m/s
  club_head_speed_mps:       number | null; // m/s; not all vendors expose this
  launch_angle_deg:          number;        // degrees; signed (neg = below horizontal)
  spin_rpm:                  number | null; // whole RPM; some vendors omit this
  carry_m:                   number;        // metres
  total_m:                   number | null; // metres; not all vendors send this
  lateral_m:                 number;        // metres; right = positive (TrackMan convention)

  // Device context
  device_id:                 string | null; // launch-monitor device identifier
  session_id:                string | null; // vendor session identifier

  // Provenance
  content_hash:              string;        // SHA-256 over key fields; cross-vendor dedup
  raw_payload:               object;        // complete vendor JSON; never exposed externally
  schema_version:            number;        // incremented on breaking normalisation changes
  parser_version:            string;        // semver; which parser version produced this row
  duplicate_of:              string | null; // FK → canonical_shot_id of earlier equivalent
}
```

**PostgreSQL DDL (abridged; full DDL in `migrations/001_init.sql`)**

```sql
CREATE TABLE shots (
  -- Identity
  canonical_shot_id         VARCHAR(26)      PRIMARY KEY,        -- ULID: always 26 chars
  vendor                    vendor_enum      NOT NULL,
  vendor_shot_id            VARCHAR(255),
  idempotency_key           VARCHAR(600)     NOT NULL,

  -- User
  vendor_user_id            VARCHAR(255)     NOT NULL,
  canonical_user_id         VARCHAR(26),                         -- NULL until identity resolved

  -- Time
  captured_at_utc           TIMESTAMPTZ      NOT NULL,
  captured_at_tz_offset_min SMALLINT,                           -- minutes; −720..+840
  received_at_utc           TIMESTAMPTZ      NOT NULL,

  -- Club
  club_code                 club_code_enum   NOT NULL,
  club_raw                  VARCHAR(64)      NOT NULL,

  -- Measurements
  ball_speed_mps            DOUBLE PRECISION NOT NULL
                              CHECK (ball_speed_mps >= 0 AND ball_speed_mps < 120),
  club_head_speed_mps       DOUBLE PRECISION,
  launch_angle_deg          DOUBLE PRECISION NOT NULL
                              CHECK (launch_angle_deg BETWEEN -10 AND 70),
  spin_rpm                  INTEGER
                              CHECK (spin_rpm IS NULL OR (spin_rpm >= 0 AND spin_rpm < 15000)),
  carry_m                   DOUBLE PRECISION NOT NULL
                              CHECK (carry_m >= 0 AND carry_m < 450),
  total_m                   DOUBLE PRECISION,
  lateral_m                 DOUBLE PRECISION NOT NULL
                              CHECK (lateral_m BETWEEN -200 AND 200),

  -- Provenance
  device_id                 VARCHAR(255),
  session_id                VARCHAR(255),
  content_hash              CHAR(64)         NOT NULL,           -- SHA-256 hex, always 64 chars
  raw_payload               JSONB            NOT NULL,
  schema_version            SMALLINT         NOT NULL DEFAULT 1,
  parser_version            VARCHAR(20)      NOT NULL,
  duplicate_of              VARCHAR(26)      REFERENCES shots(canonical_shot_id),

  created_at                TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shots_vendor_idempotency_key
  ON shots (vendor, idempotency_key);
```

---

### What we chose to store, and why

**`canonical_shot_id` — ULID, not UUID**

UUIDs are the default reach for globally unique identifiers and they would work. The reason to prefer ULIDs is insertion performance. UUIDs are random; random primary keys scatter inserts across B-tree leaf pages and force frequent page splits under sustained write load. ULIDs encode a millisecond-precision timestamp in the high 48 bits, so newly generated IDs cluster at the right edge of the index. Page splits become rare. The monotonic ULID factory (`ulidx.monotonicFactory`) additionally increments the sequence suffix within the same millisecond, which matters when a SwingMetric batch of 500 shots arrives in a single HTTP request — all 500 get distinct, monotonically increasing IDs without collisions.

**`idempotency_key` — the exact deduplication mechanism**

Each vendor has a different concept of what makes a shot unique:

- TrackPro provides a stable `shot_uid` per shot (`tp-YYYY-MM-DD-{8hex}`). Key: `tp|{shot_uid}`. A retransmitted payload with the same `shot_uid` is silently absorbed.
- SwingMetric has no shot-level ID. Firmware can emit duplicates within a ~1-second window when connectivity is poor. Key: `sm|{player.id}|{device_id}|{floor(ts_ms/1000)}` — a one-second bucket. This collapses in-batch double-emit and cross-batch retransmission without discarding genuinely distinct shots fired more than one second apart.
- ProSwing provides a stable `shot.id` in the data envelope. Key: `ps|{shot.id}`.

The uniqueness constraint is `(vendor, idempotency_key)`, not just `idempotency_key`, because different vendors could generate the same string independently. The database index is the deduplication mechanism; there is no application-level read-before-write and therefore no race condition under concurrent inserts.

**`captured_at_utc` and `captured_at_tz_offset_min`**

Every time-based query, window calculation, and clock-skew check runs against `captured_at_utc` in UTC. The second column — the UTC offset in minutes — exists for display only. A golfer practicing at 8 am in Melbourne (`+10:00`) sees their history grouped correctly by local session time; the analytics layer still sorts correctly across timezones because the UTC column is the source of truth for ordering.

ProSwing sends ISO-8601 with offsets (`2026-05-18T20:14:22+10:00`). The parser extracts the UTC equivalent and the offset separately. TrackPro and SwingMetric send UTC directly; their offset column is null.

Storing the offset as `SMALLINT` (minutes) keeps the column cheap. Minutes are the correct granularity — the real-world timezone database has 30-minute and 45-minute offset zones (India, Nepal, parts of Australia). Storing hours would be incorrect.

**`club_code` (enum) and `club_raw` (string)**

`club_code` is a 24-value PostgreSQL enum: drivers, woods, hybrids, irons, wedges, putter, and `UNKNOWN`. It is what the stats and query layers group on. The normalisation mapping handles the variants each vendor uses: ProSwing sends `I7` for a 7-iron (reversed format), SwingMetric sends `7iron` or `7 Iron`, TrackPro sends `7I`. The algorithm: uppercase the input, check if it is already a canonical code, try the inverted-iron pattern (`I(\d)` → `\1I`), then fall through to an alias table covering natural-language names like `"pitching wedge"` → `PW`.

`club_raw` stores the original vendor string exactly as received. When we add vendor D and discover a new alias pattern that our normaliser doesn't handle, we can back-fill `club_code` from `club_raw` without vendor re-transmission. The two columns together mean we can always trade off correctness against historical completeness: the enum gives us groupability today; the raw string gives us correctability later.

**`lateral_m` — direction matters, convention matters**

Lateral deviation is the single best signal for shot shape in the absence of trajectory data. Right-of-target is positive. This is the TrackMan convention, which all three vendors use, and the convention used in the golf coaching literature for describing ball flight. Storing it as a signed float means the statistics layer can compute mean lateral error (a bias indicator) and lateral standard deviation (a dispersion indicator) in a single pass over the column.

**`content_hash` — cross-vendor near-deduplication**

The idempotency key handles exact retransmission within a vendor. It cannot catch the same physical shot arriving from two different vendors (a player whose device uploads to both TrackPro and ProSwing simultaneously). The content hash is a SHA-256 over seven normalised fields: `(vendor_user_id, club_code, minute-bucket(captured_at_utc), ball_speed_mps rounded to 1 decimal, launch_angle_deg rounded to 1 decimal, carry_m rounded to 0 decimal, lateral_m rounded to 0 decimal)`.

The rounding is load-bearing. Different vendors apply different smoothing algorithms to their sensor data; a raw equality check would miss most cross-vendor matches. Rounding to physically meaningful precision absorbs measurement noise without collapsing genuinely distinct shots: 0.1 m/s ball speed precision is already tighter than most hardware sensors, 1m carry precision is coarser than GPS but matches the reproducibility of the physical event.

The hash check runs in the async worker, not the synchronous controller, because it requires a bounded window query against the database: find any earlier shot with the same `vendor_user_id`, same `content_hash`, and `captured_at_utc` within ±60 seconds. Matches are soft-linked via `duplicate_of`, never deleted.

**`raw_payload` — full provenance, zero external exposure**

The normalised columns are lossy. We discard fields that have no current analytical use. `raw_payload` stores the complete validated vendor JSON as JSONB so we can always re-derive any dropped field. This column is write-once: the API layer never returns it, the stats service never reads it, and it is never included in the `shot.persisted` event payload. It exists solely for audit and re-processing. When a parser bug is found, we can re-normalise the affected cohort from `raw_payload` without involving the vendor.

**`schema_version` and `parser_version`**

`schema_version` is incremented when the meaning of a column changes in a way that makes old rows incompatible with new query logic. `parser_version` records which code produced each row. Together they make it possible to identify cohorts of rows that need re-processing: `WHERE schema_version = 1 AND parser_version < '1.2.0'`. This is how we handle the inevitable discovery that a conversion constant was slightly wrong, or that a vendor changed how they encode club names.

**`duplicate_of` — soft deduplication, never hard delete**

When a near-duplicate is found, the newer row's `duplicate_of` is set to the earlier row's `canonical_shot_id`. Analytics queries that want unique shots filter `WHERE duplicate_of IS NULL`. Shots are never deleted because:

1. The near-dedup heuristic can produce false positives (two genuinely distinct shots with identical physics). False positives must be reversible: `UPDATE shots SET duplicate_of = NULL WHERE …` is always safe.
2. Identity resolution is asynchronous. A shot that looks like a duplicate of another player's shot today may belong to the same canonical user tomorrow, making it a true duplicate. Or it may belong to a different user, making it a false positive. We cannot know until the identity graph is populated.

---

### What we chose to drop

**Player email (SwingMetric envelope)**

SwingMetric sends an optional `player.email` in the session envelope. It is consumed by the PII-redaction function before anything is written to the database and does not appear in any stored column. The ingest service is not an identity store. `vendor_user_id` (the player ID) is sufficient for the identity resolution flow. Email belongs in the Portal BFF's user table where it is properly secured; it does not belong in a high-throughput ingest table where it would appear in every shot row.

**Session-level aggregates**

SwingMetric sends a `session_id`; ProSwing sends device metadata beyond a device identifier. We store `session_id` and `device_id` as opaque strings but build no session table and no FK. This service has no current requirement to query or aggregate at the session level. If session analytics become a product requirement — total shots per session, warm-up vs main-set classification — that is a separate read model built on top of the shot rows, not a concern of the ingest service.

**Calculated fields: smash factor, strokes gained, dispersion radius**

Smash factor (`ball_speed / club_head_speed`) is derivable at query time from two stored columns. Strokes-gained requires a course-and-conditions baseline that this service does not hold. Dispersion radius is computed by the stats service at read time from `lateral_m` and `carry_m`. Storing derived values would create a consistency risk: if the input columns are ever corrected by re-processing, derived columns would need to be invalidated and recomputed. Storing only the inputs and deriving at read time keeps the schema honest.

---

### What we would add later

**`face_angle_deg` and `path_deg`**

These are the two numbers that explain *why* a shot went where it did — the relative orientation of the clubface and the direction of the swing at impact. Both TrackPro and ProSwing's hardware records them; neither includes them in the current webhook payload. They would be the first addition when we negotiate extended payloads with vendors.

**`altitude_m` and `air_density_kg_m3`**

Carry distance decreases significantly at high altitude and in humid air. Without environmental context, comparing a player's carry numbers at sea level to their numbers in Denver is meaningless. This requires vendors to supply environmental conditions at capture time, which none of the current three do.

**`shot_shape` (enum: DRAW | STRAIGHT | FADE | PULL | PUSH | HOOK | SLICE)**

A derived classification from the combination of lateral deviation, launch direction, and face angle. Currently computable only as a rough proxy from `lateral_m` alone, which conflates aim error with shot shape. Proper classification requires the full trajectory data that launch monitors record internally.

**Table partitioning by `captured_at_utc`**

At current projected volume (~30M shots/year across expected user growth), the shots table will reach ~50–100M rows within 18–24 months. The primary access patterns — stats window queries and player history — all filter on `captured_at_utc`. Monthly range partitioning would let these queries scan a single partition. Kysely treats partitioned tables transparently; this would be a migration-only change with no application code modifications.

---

### Defending the unit choices

**Why SI (metres, m/s) and not the vendor's native units?**

The three vendors use three incompatible unit systems. TrackPro sends SI natively. SwingMetric sends miles-per-hour for speed and yards for distance. ProSwing sends a configurable unit per measurement field: `mph`, `kph`, or `mps` for speed; `yd`, `m`, or `ft` for distance. If we stored measurements in source units, every aggregation query would need to branch on vendor:

```sql
CASE vendor
  WHEN 'trackpro'    THEN ball_speed_mps
  WHEN 'swingmetric' THEN ball_speed_mph * 0.44704
  WHEN 'proswing'    THEN -- depends on which unit the device was configured for
END
```

This is unmaintainable and breaks the moment vendor D ships. By converting at the ingest boundary — inside the vendor parsers — every column has exactly one meaning regardless of source. The stats service does not know which vendor produced a row; it queries `ball_speed_mps` and gets a meaningful number.

**Why metres and not yards?**

Golf is culturally imperial in the English-speaking markets this product targets. Players think in yards. The choice to store in metres is entirely internal. Metres and m/s are the units used in the physics literature, in the sensor calibration documentation of every major launch monitor manufacturer, and in the ISO standards that govern angular measurement. Ball flight physics is expressed in SI. Storing in SI means our constants, our conversion factors, and our range checks are directly verifiable against published physics without a mental unit conversion step.

The display layer converts `carry_m × 1.09361` to yards at render time. That conversion belongs in the presentation layer, not the data model. Storing in yards, then converting to metres for physics, then back to yards for display would accumulate floating-point rounding error on every round trip.

**Why `DOUBLE PRECISION` and not `NUMERIC(p, s)`?**

`NUMERIC` in PostgreSQL is arbitrary-precision decimal arithmetic — exact, but implemented in software. It is correct for financial amounts where $10.00 must never silently become $9.999999996. Ball speed at 0.1 m/s precision and carry at 1-metre precision: the physically meaningful precision of any consumer or professional launch monitor is far coarser than the 15–16 significant decimal digits that `DOUBLE PRECISION` provides. IEEE 754 double-precision floating point is hardware-native on every modern CPU and GPU; PostgreSQL's aggregate functions (mean, standard deviation) run significantly faster on it than on `NUMERIC`. Given that the stats endpoint runs a sort-based percentile calculation over up to 10,000 rows in the Node process, maintaining numeric precision throughout the pipeline at hardware speed is the correct choice.

**Why `INTEGER` for `spin_rpm`?**

No launch monitor reports fractional RPM. The measurement granularity of optical spin detection — the technique all three current vendors use — is typically ±50 RPM at the sensor level. Storing `spin_rpm` as `DOUBLE PRECISION` would assert a precision that does not exist in the physical measurement. `INTEGER` is honest about what the data actually contains. The column is nullable rather than `NOT NULL DEFAULT 0` because zero RPM is a physically meaningful value (a knuckleball or a completely mis-hit shot), and the distinction between "the vendor did not measure spin" and "spin was measured at zero" matters for the `vendors_excluded` field in the stats response.

---

## Q2. Deduplication

### Two layers

**Layer 1 — Exact dedup via `idempotency_key`**

Each vendor gets a deterministic key scheme:

| Vendor | Key construction | Rationale |
|---|---|---|
| TrackPro | `tp\|<shot_uid>` | TrackPro sends a stable `shot_uid`; second transmission of the same shot has the same UID. |
| SwingMetric | `sm\|<player.id>\|<device_id>\|<floor(ts_ms/1000)>` | SwingMetric has no shot ID. The tuple (player, device, 1-second-bucketed timestamp) is stable across retransmissions — SwingMetric doesn't vary the timestamp when retransmitting. |
| ProSwing | `ps\|<user_token>\|<shot.id>` | ProSwing sends a stable `shot.id`. |

The `idempotency_key` is stored as a `UNIQUE` index. A retransmit triggers an `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` — the row is skipped, the BullMQ job is acknowledged, and we return `202 accepted` so the vendor doesn't retry forever.

**Layer 2 — Near-dedup via `content_hash`**

A shot with the same physical outcome but a different `idempotency_key` (e.g. SwingMetric retransmits with a slightly different `ts_ms`) gets a new row but is flagged with `duplicate_of` pointing to the earliest matching shot. The query endpoint excludes near-duplicates by default (`include_near_duplicates=false`).

Near-dedup is implemented in the processor, not the database, to keep the dedup logic testable without a DB constraint race. The window is ±60 seconds on `captured_at_utc`; matching is on `content_hash`.

### Where this breaks

The weakest point is SwingMetric's 1-second bucket key. If a player hits two shots within the same second with an identical `content_hash` (same club, same physics to rounding precision), the second is treated as an exact duplicate and silently dropped. This could happen on a mat with automated ball-return systems firing shots in rapid succession. I'd address it in the next iteration by:

1. Using the raw `ts_ms` without bucketing for the idempotency key, and relying solely on near-dedup (with a tighter ±10-second window) to handle genuine firmware retransmissions.
2. Tracking false-positive rate via a `pureplay_ingest_near_duplicates_total{confidence=low}` metric label.

---

## Q3. Cross-vendor user identity unification

### The problem

A player uses TrackPro at home (`user_external_id: "alice_123"`) and SwingMetric at their club (`player.id: "a.smith@email.com"`). Their shot history is split across two `vendor_user_id` values with no shared key.

### Approach: asynchronous identity graph

The service already stores `canonical_user_id` (nullable). The unification pipeline works in three steps:

**Step 1 — Signals collected at ingestion.** Every shot is stored with its `vendor_user_id`. Separately, a player profile service maintains a graph of `(vendor, vendor_user_id) → canonical_user_id` mappings. When a player links their TrackPro account in the app, the mapping is written to the graph.

**Step 2 — Backfill on link.** When `POST /users/:canonical_user_id/identities` is called, the service immediately runs an UPDATE to set `canonical_user_id` on all existing shots for that `(vendor, vendor_user_id)` pair where `canonical_user_id IS NULL`. This is an idempotent index-scan UPDATE.

**Step 3 — Real-time lookup at ingest time.** `IdentityService.resolveCanonicalUserId(vendor, vendor_user_id)` queries the `user_identities` table before each upsert. If a mapping exists, `canonical_user_id` is set on the shot at write time — no backfill needed for new shots. Backfill still runs on identity link creation for pre-existing shots.

### Why not join at query time

A JOIN on the identity graph at every `/shots` request would make query latency dependent on the identity service being healthy. Denormalising `canonical_user_id` onto the shot row means the query endpoint never talks to identity — a full outage of the identity service doesn't affect read latency.

### Edge case: the same player under three vendors

`canonical_user_id` is a single string per shot. If alice has TrackPro (`tp_alice`), SwingMetric (`sm_a.smith`), and ProSwing (`ps_tok_abc`), all three `vendor_user_id` values map to the same `canonical_user_id`. The identity graph is the source of truth for that mapping.

---

## Q4. Service under load

### What happens at 200 simultaneous launch monitors

The HTTP process (Fastify + NestJS) is stateless and CPU-light — it validates the Zod schema and enqueues a BullMQ job. A single Node process handles hundreds of concurrent webhook requests without I/O blocking.

The bottleneck is **Redis** under high enqueue rate. At 200 simultaneous shots, each enqueue is one `XADD` to the Redis stream. Redis handles ~100K ops/sec on modest hardware; 200 concurrent enqueues is trivial.

The real bottleneck is the **worker** (Postgres writes). At `WORKER_CONCURRENCY=16`, the worker processes 16 shots simultaneously. Each shot is one `INSERT ... ON CONFLICT DO NOTHING` + one `SELECT` for near-dedup. At P99, this is ~5ms per shot on Postgres with the right indexes. 16 shots × 200ms/shot = 3.2 seconds to drain a 200-shot burst — well within the BullMQ queue buffer.

**What I'd change first:**
1. ~~Horizontal worker scaling~~ — **done**: two worker replicas run with BullMQ distributed locking. 32 concurrent jobs total.
2. Batch Postgres writes — instead of one INSERT per job, buffer 100ms of jobs and write in a single multi-row INSERT. Reduces DB round-trips by 10–100×.
3. ~~Connection pool tuning~~ — **done**: `DB_POOL_MAX` env var (default 20) controls the pool size at runtime. Set to `WORKER_CONCURRENCY + 4` for worker processes, lower for API processes.

**Backpressure gate:**
The controller checks `queue.getWaitingCount() >= MAX_QUEUE_DEPTH` and returns `503 + Retry-After: 30` before enqueuing. This keeps the queue from growing unboundedly if the worker falls behind. The vendor's client retries after 30 seconds.

---

## Q5. Failure modes I most worried about

### 1. Silent near-duplicate false positives at race conditions

**The scenario:** two shots from the same player arrive within 60 seconds with the same content hash — but they are genuinely different shots (e.g. two identical 7-irons off a mat). The second is flagged as a near-duplicate and excluded from stats.

**Why it worries me:** it silently corrupts statistics with no error log. A player's carry P50 shifts because half their 7-iron data is invisible.

**Detection:** a Prometheus counter `pureplay_ingest_near_duplicates_total{vendor, club_code}` exposes the rate. Alert if the rate for any single (vendor, club) exceeds 10/minute — that's likely a false-positive storm, not genuine retransmissions.

**Recovery:** `include_near_duplicates=true` on the query endpoint allows us to inspect the flagged shots. A data repair job can `UPDATE shots SET duplicate_of = NULL WHERE <criteria>` without losing the original data.

**Prevention:** tighten the near-dedup window from 60 seconds to 10 seconds and add a minimum physical dissimilarity threshold (>5m carry difference = never a duplicate).

### 2. Content hash collision across vendors

**The scenario:** two different players (different `vendor_user_id`) hit shots with identical `(club, captured_at_minute, ball_speed, carry, lateral)`. The content hash matches. The second shot is erroneously flagged as a near-duplicate of the first.

**Why it worries me:** the near-dedup query scopes to `(vendor_user_id, content_hash, time window)`. I already include `vendor_user_id` in the hash inputs, so a cross-player collision requires the same vendor user ID — which is impossible by definition. I verified this in the implementation: the hash function receives `vendor_user_id` as its first argument.

**Detection:** if this somehow occurs, `duplicate_of` would point to a shot with a different `vendor_user_id`. A daily audit query would surface this:
```sql
SELECT s1.canonical_shot_id, s2.vendor_user_id
FROM shots s1 JOIN shots s2 ON s1.duplicate_of = s2.canonical_shot_id
WHERE s1.vendor_user_id != s2.vendor_user_id;
```

### 4. Future-dated shots from firmware bugs

**The scenario:** a launch monitor with a broken RTC sends shots dated year 2099. The original symmetric `Math.abs` clock-skew check would have passed these (23h in the future = |delta| < 24h threshold if the bug produces, say, a 1-day offset).

**Fix:** `hasExcessiveClockSkew` now uses an asymmetric window. Shots more than 5 minutes in the future are rejected to `ingestion_failures` with `error_code: CLOCK_SKEW_EXCESSIVE`. The 24h past window is preserved for legitimate retransmission lag.

**Why 5 minutes future?** NTP-synchronised devices may drift by seconds. A 5-minute forward tolerance covers the worst-case NTP re-sync gap without admitting shots from clock-bug devices.

### 3. Worker crash mid-job leaving shots in `active` state

**The scenario:** the worker picks up a job, starts the Postgres INSERT, and the Node process crashes (OOM, SIGKILL). The job is still in BullMQ's `active` state. BullMQ's stalled-job detector (runs every 30 seconds) moves it back to `waiting` and re-queues it.

**Why it worries me:** the INSERT might have succeeded before the crash. The re-queued job runs the INSERT again — but because of `ON CONFLICT DO NOTHING`, the duplicate is safely ignored. This is fine for exact dedup. Near-dedup runs again and produces the same result. The `shot.persisted` event is emitted twice — any downstream consumers must be idempotent.

**Detection:** BullMQ's `stalled` event is logged with `level: warn` and the `canonical_shot_id`. Alert if stalled rate exceeds 1/minute.

**Prevention:** the `shot.persisted` event carries the `canonical_shot_id` and `outcome: 'accepted' | 'duplicate'`. Downstream consumers key on `canonical_shot_id` to deduplicate.

---

## Q6. Instrumentation

### Three things I'd want in production

**1. `pureplay_ingest_e2e_lag_ms` (histogram, p50/p95/p99 by vendor)**

This measures the wall-clock time from `received_at_utc` (when the API accepted the HTTP request) to when the BullMQ worker finishes writing the shot row to the database — the complete queue-to-persistence latency. A sudden spike on a specific vendor means the worker is falling behind on that vendor's workload, either because their SDK is sending bursts the queue cannot drain fast enough, or because Postgres write latency has increased.

Implemented as `Date.now() - new Date(receivedAtUtc).getTime()` in the processor after the upsert completes. At p99, I'd alert at >60 seconds: anything longer means new shot data is sitting in the queue long enough to be stale by the time a player opens the app.

What it tells you when something is wrong: "TrackPro's p99 lag jumped from 400ms to 55s at 10:14 UTC. Queue depth gauge spiked simultaneously — the worker can't keep up with their burst rate."

**2. `pureplay_ingest_near_duplicates_total` labelled by `vendor` and `club_code`**

The near-dedup rate is a leading indicator of two distinct problems: vendor SDK bugs (retransmission storms) and my own algorithm being too aggressive. A sharp increase on a single vendor at all clubs = SDK issue. A sharp increase on a single club at all vendors = my hash function is too coarse for that club (e.g. putter shots cluster at very similar distances).

**3. Structured log at `WARN` for every shot that lands in `ingestion_failures`**

The failure table records clock-skew violations (>24h), parse errors, and DB write failures. Each entry should have `correlation_id`, `vendor`, `vendor_user_id`, `failure_reason`. Without this, a vendor sending malformed payloads is silent — we see 400s in the HTTP access log but lose the context of which player is affected. With it, a support query takes one grep.

---

## Q7. What I'd build next

This answer has three layers: what's genuinely done right now, what's required before any vendor can send real shots (the MVP gate), and what goes on the post-MVP backlog.

---

### What's actually shipped

The following was built and verified during this engagement:

| Area | Status | Detail |
|---|---|---|
| Ingest pipeline | ✅ Complete | TrackPro, SwingMetric (batch), ProSwing — all three formats, full Zod validation, SI normalisation |
| Webhook auth | ✅ Complete | Three-mode guard (`none` dev / `api_key` / `hmac`). HMAC-SHA256 over `<ts>.<raw-body>`, 5-min replay window, `timingSafeEqual` constant-time compare |
| Identity service | ✅ Complete | `POST/GET/DELETE /v1/users/:id/identities`. Redis-cached resolution (60s TTL), shot backfill on link, audit log written atomically in transaction |
| Deduplication | ✅ Complete | Exact: `idempotency_key` UNIQUE + BullMQ `jobId`. Near: `content_hash` ± 60s per vendor user. `duplicate_of` FK, soft-flag only — no deletes |
| Async processing | ✅ Complete | BullMQ, 2 worker replicas × 16 concurrency = 32 concurrent jobs, AOF Redis, 5 retries with exponential backoff |
| Backpressure | ✅ Complete | `getWaitingCount() >= MAX_QUEUE_DEPTH` → `503 Retry-After: 30` before enqueue |
| Rate limiting | ✅ Complete | Redis-backed throttler, 4 tiers: `webhook` 200/s · `query` 50/s · `write` 100/s · `default` 1000/min. Shared across all API replicas |
| PII redaction | ✅ Complete | `ingestion_failures.raw_body` written via `redactPii()` — strips `email`, `user_token`, `data.user_token` |
| Health / readiness | ✅ Complete | `/healthz` liveness, `/readyz` pings Postgres + Redis |
| Metrics | ✅ Complete | 6 Prometheus metrics: `shots_total`, `e2e_lag_ms`, `near_duplicates_total`, `queue_depth`, `jobs_failed_total`, `auth_failures_total` |
| OpenTelemetry | ✅ Complete | Auto-instrumentation, OTLP exporter configurable via env |
| Container hardening | ✅ Complete | `read_only` filesystem, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges: true` |
| Load testing | ✅ Complete | k6 script, 5 scenarios (smoke/nft/peak/load/stress), thresholds at NFR floor |

---

### Stage 1 — MVP gate (must complete before any vendor sends real shots)

These are the four blockers between the current local prototype and a live production service. None of them require changes to the core ingest logic; they are infrastructure and integration work.

---

#### 1. CI/CD pipeline

**What's missing:** there is no automated gate on PRs. Tests pass locally but a developer can merge broken code.

**What to build:**

```yaml
# .github/workflows/ci.yml (example)
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env: { POSTGRES_PASSWORD: test }
        options: --health-cmd pg_isready
      redis:
        image: redis:7-alpine
        options: --health-cmd "redis-cli ping"
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm tsc --noEmit
      - run: pnpm lint
      - run: pnpm test           # unit tests
      - run: pnpm test:e2e       # E2E against real Postgres + Redis
      - run: pnpm build
```

**Required secrets in CI:** `DATABASE_URL`, `REDIS_URL` (provided by the service containers above — no external secrets needed for test runs).

**Deploy job (staging only, on merge to `main`):**

```yaml
  deploy-staging:
    needs: test
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy API to staging
        run: |
          docker build -t pureplay-ingest:${{ github.sha }} --target api .
          # push to your registry, then rolling-update the ECS/GKE service
```

---

#### 2. Public HTTPS endpoint + TLS termination

**Why it blocks vendor webhooks:** vendors call your URL from the internet. They cannot reach `http://localhost:3000`. They also require HTTPS — TrackPro and ProSwing both reject non-TLS webhook targets.

**Minimum viable path (AWS):**

```
Internet → ALB (HTTPS :443, ACM cert) → Target Group (HTTP :3000) → ECS Task / EC2
```

The service listens on plain HTTP; TLS is terminated at the ALB. `keepAliveTimeout: 65s` in `main.api.ts` is already set longer than the ALB's 60s idle timeout — no mid-request resets.

**During development (before staging infra is ready):** use `ngrok` to expose your local service for initial vendor webhook testing:

```bash
ngrok http 3000
# gives you: https://abc123.ngrok-free.app
# register this as your webhook URL in the vendor dashboard
```

**DNS:** point a stable subdomain (`ingest.yourapp.com`) at the ALB. Use this in all vendor registrations — not the ngrok URL, which changes.

---

#### 3. Portal BFF auth integration

**The architecture:** this service does not validate JWTs or user sessions. That is intentional and documented in `README.md` as the IDOR trust boundary. The Portal BFF holds the user's auth session and is the only authorised caller of the query, stats, and identity endpoints.

**What the Portal BFF must do:**

```
User request (JWT in cookie/header)
    │
    ▼
Portal BFF
    ├─ Validates JWT (Auth0 / Cognito / your auth service)
    ├─ Extracts canonical_user_id from JWT claims
    └─ Calls this service with:
         Authorization: Bearer <INTERNAL_API_KEY>
         X-Actor-ID: <canonical_user_id>         ← for audit trail
         X-Correlation-ID: <request-trace-id>    ← for log correlation
```

**What needs to be built in this service:**

Currently `audit_log.actor` is hardcoded to `'internal-api'` — every identity link/unlink/list looks like it was performed by the same actor. To get meaningful audit trails, the identity controller must read the `X-Actor-ID` header and pass it to `IdentityService`:

```typescript
// identity.controller.ts
@Post(':canonical_user_id/identities')
async linkIdentity(
  @Param('canonical_user_id') canonicalUserId: string,
  @Body(new ZodValidationPipe(LinkBodySchema)) body: LinkBody,
  @Headers('x-actor-id') actorHeader: string | undefined,
  @Res({ passthrough: true }) reply: FastifyReply,
) {
  const actor = actorHeader ?? 'internal-api';
  const result = await this.identityService.linkIdentity(
    body.vendor, body.vendor_user_id, canonicalUserId, actor,
  );
  void reply.header('Location', `/v1/users/${canonicalUserId}/identities`);
  return result;
}
```

The same change applies to `GET` (list) and `DELETE` (unlink). `IdentityService` already accepts `actor` as a parameter — it just isn't being passed from the HTTP layer yet.

**What the auth service must provide:**

| Claim / header | Source | Used for |
|---|---|---|
| `INTERNAL_API_KEY` | Shared secret in secrets manager | `InternalApiGuard` — constant-time bearer token check |
| `X-Actor-ID` | JWT `sub` or `user_id` claim extracted by BFF | `audit_log.actor` |
| `X-Correlation-ID` | Trace ID from BFF request | Log correlation across services |

**What does NOT change:** `WEBHOOK_AUTH_MODE` and the per-vendor HMAC/API-key secrets are completely separate from the BFF auth. Vendors authenticate with their own credentials; the BFF authenticates users with `INTERNAL_API_KEY`.

---

#### 4. Vendor webhook registration and end-to-end testing

This is the step that confirms the real vendor payloads match the Zod schemas. The local fixture tests cover the formats described in the spec; real vendor SDKs sometimes produce edge cases not in the spec.

**For each vendor, in order:**

**Step 1 — Get your public URL ready** (see item 2 above). Staging URL preferred; ngrok acceptable for initial testing.

**Step 2 — Set `WEBHOOK_AUTH_MODE` in your staging `.env`:**

For `hmac` mode (recommended for production):
```bash
WEBHOOK_AUTH_MODE=hmac
TRACKPRO_HMAC_SECRET=<generate: openssl rand -hex 32>
SWINGMETRIC_HMAC_SECRET=<generate: openssl rand -hex 32>
PROSWING_HMAC_SECRET=<generate: openssl rand -hex 32>
```

For `api_key` mode (simpler if HMAC isn't supported by the vendor):
```bash
WEBHOOK_AUTH_MODE=api_key
TRACKPRO_API_KEY=<generate: openssl rand -hex 32>
SWINGMETRIC_API_KEY=<generate: openssl rand -hex 32>
PROSWING_API_KEY=<generate: openssl rand -hex 32>
```

**Step 3 — Register the webhook URL with each vendor:**

| Vendor | Where to register | URL to register | Auth to provide |
|---|---|---|---|
| TrackPro | TrackPro developer portal → Webhooks | `https://ingest.yourapp.com/v1/webhooks/trackpro` | HMAC secret or API key |
| SwingMetric | SwingMetric partner dashboard → Integrations | `https://ingest.yourapp.com/v1/webhooks/swingmetric` | HMAC secret or API key |
| ProSwing | ProSwing API settings → Webhook endpoints | `https://ingest.yourapp.com/v1/webhooks/proswing` | HMAC secret or API key |

**Step 4 — Trigger a test shot from the vendor:**

Most vendors have a "send test event" button in their dashboard, or a sandbox environment that generates a real shot. Watch the service logs:

```bash
# Watch ingestion in real time
docker compose logs -f api worker

# Or if deployed:
kubectl logs -f deployment/pureplay-ingest-api
```

A successful ingestion produces:
```json
{"level":"info","msg":"shot enqueued","vendor":"trackpro","correlation_id":"..."}
{"level":"info","msg":"shot processed","vendor":"trackpro","canonical_shot_id":"...","inserted":true}
```

A vendor payload mismatch produces:
```json
{"level":"warn","msg":"validation failed","error_code":"PAYLOAD_VALIDATION_FAILED","issues":[...]}
```

**Step 5 — Verify the shot landed in the database:**

```sql
SELECT canonical_shot_id, vendor, club_code, ball_speed_mps, captured_at_utc, received_at_utc
FROM shots
WHERE vendor = 'trackpro'
ORDER BY received_at_utc DESC
LIMIT 5;
```

**Step 6 — Run the k6 smoke scenario against staging:**

```bash
k6 run \
  -e BASE_URL=https://ingest.yourapp.com \
  -e INTERNAL_API_KEY=<your staging key> \
  -e SCENARIO=smoke \
  k6-load-test.js
```

This takes 30 seconds and confirms the full journey (ingest → queue → worker → persist → query → stats) works end-to-end on real infrastructure.

**Common failure modes at this step:**

| Symptom | Cause | Fix |
|---|---|---|
| `401 Invalid HMAC signature` | HMAC secret mismatch or wrong signing format | Print the raw expected signature in `webhook-auth.guard.ts` temporarily and compare with vendor's test tool |
| `400 PAYLOAD_VALIDATION_FAILED` | Vendor's real payload has a field the spec didn't describe | Add the field to the Zod schema (`z.unknown().optional()` to start, then refine) |
| `422 CLOCK_SKEW_EXCESSIVE` | Vendor's test shot has a hardcoded `captured_at` in the past | Pass or retry; this is the skew guard working correctly |
| `503` immediately | Container not running or `readyz` failing | `docker compose ps` or `kubectl get pods` |
| `200 OK` on ingest but shot missing from DB | Worker not running, Redis not persisted | Check `docker compose logs worker`; check `pureplay_ingest_queue_depth` metric |

---

### Stage 2 — Post-MVP backlog

Once real shots are flowing from all three vendors:

**1. X-Actor-ID propagation** (small, high value)

See Stage 1 item 3 — pass the authenticated user ID from the BFF through to `audit_log.actor`. Until this lands, all audit entries show `actor: internal-api`, which makes the audit log useless for per-user accountability.

**2. Monitoring and alerting**

The six Prometheus metrics are exposed but no alerts are configured. Wire them to your alerting platform (Grafana Alertmanager / PagerDuty / Datadog):

| Metric | Alert condition | Severity |
|---|---|---|
| `pureplay_ingest_e2e_lag_ms` p99 | > 60 000 ms (60 s) | P1 — queue not draining |
| `pureplay_ingest_queue_depth` | > 8 000 (80% of `MAX_QUEUE_DEPTH`) | P2 — worker falling behind |
| `pureplay_ingest_jobs_failed_total` rate | > 5/min sustained | P2 — DLQ filling |
| `pureplay_ingest_near_duplicates_total` rate | > 10/min per vendor | P3 — possible SDK retransmission storm |
| `pureplay_ingest_auth_failures_total` rate | > 20/min | P2 — possible vendor misconfiguration or attack |

**3. Soft-delete + re-derivation pipeline**

Every shot's raw vendor payload is stored in `shots.raw_payload`. When the parser changes (normalisation formula fix, new field added), historical shots need to be re-normalised. The current service stores the raw payload but has no tooling to replay it:

- Background job: `SELECT * FROM shots WHERE parser_version < <current>` → re-parse `raw_payload` → UPDATE normalised fields
- Needs: `parser_version` column in shots table (migration), re-parse entry point in `shot-ingestion.processor.ts`, admin endpoint to trigger

**4. Key rotation procedure**

HMAC secrets and `INTERNAL_API_KEY` are long-lived static values. If a secret is rotated, there is a brief window where the old secret is invalid but the vendor hasn't yet switched. Handle by:

1. Add `*_HMAC_SECRET_PREV` env vars accepted alongside the current secret
2. `WebhookAuthGuard` tries the current secret first, falls back to `_PREV`, logs a warning
3. Rotate the vendor secret → deploy → wait for old requests to drain → remove `_PREV`

**5. Batch Postgres writes**

At high throughput (200+ shots/s), each BullMQ job issues one `INSERT`. Buffer 100ms of processed jobs and write them as a single multi-row `INSERT ... VALUES (...), (...)`. Reduces DB round-trips by 10–100× under burst load. Not needed until sustained throughput exceeds 100 shots/s.

---

## AI usage disclosure

### Tools used

- **Claude Code (claude-sonnet-4-6)** via the Claude Code CLI — used throughout:
  - Generated the initial project scaffold (NestJS module structure, Kysely setup, BullMQ wiring, Zod schemas)
  - Generated the SQL migration files and migration runner
  - Generated the test suite (unit specs for parsers, content hash, PII redaction)
  - Assisted with Dockerfile multi-stage build and docker-compose memory tuning

### Example of AI output I rewrote

**Original AI output for `splitStatements` in `migration-runner.ts`:**

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

**Why it was wrong:**

This strips full-line comments but ignores inline comments. The SQL migration file has columns like:

```sql
tz_offset_min SMALLINT,   -- UTC offset in minutes; range −720..+840
```

The semicolon inside the inline comment becomes a statement terminator. The splitter produces a broken statement `"range −720..+840"` and passes it to `sql.raw()` which throws a Postgres syntax error: `error: syntax error at end of input`.

**What I wrote instead:**

A character-by-character state machine tracking three contexts: dollar-quoted PL/pgSQL blocks (`$$...$$`), single-quoted string literals (`'...'`), and single-line comments (`-- ...`). When `--` is encountered outside a quoted context, the parser skips to end-of-line without emitting the comment text. Semicolons inside comments are never treated as statement terminators.

This is ~90 lines vs the original 8 lines, but correct.

### Where the AI misled me

The AI generated `import pg from 'pg'` (default import) in `kysely.module.ts`. This compiles fine locally — TypeScript with `esModuleInterop: true` (the default in ts-node) makes the default import work. But in the compiled Docker output (Node running `dist/main.api.js` directly without ts-node), the CommonJS `require('pg')` returns the module object, not a default export. So `pg.types` was `undefined` and the service crashed on startup with:

```
TypeError: Cannot read properties of undefined (reading 'types')
```

I caught it by reading the Docker container logs (`docker compose logs api`) after seeing the healthcheck fail. The fix was switching to named imports: `import { Pool, types } from 'pg'` — which work identically in both environments.

The lesson: AI doesn't distinguish between "code that works under ts-node" and "code that works in compiled Node". Always verify the compiled output in the target runtime, not just locally.
