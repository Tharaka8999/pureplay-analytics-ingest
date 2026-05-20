# Architecture Overview

## System context

Pureplay Analytics Ingest is a backend microservice that receives golf shot telemetry from three hardware vendors (TrackPro, SwingMetric, ProSwing), normalises and deduplicates the data, stores it in PostgreSQL, and exposes query/stats endpoints to the Portal BFF.

```mermaid
graph TB
    TP[TrackPro device]
    SM[SwingMetric device]
    PS[ProSwing device]
    BFF[Portal BFF]
    SVC[pureplay-analytics-ingest]
    DB[(PostgreSQL)]
    RD[(Redis 7)]
    OTL[OTel collector]

    TP -->|POST /v1/webhooks/trackpro| SVC
    SM -->|POST /v1/webhooks/swingmetric| SVC
    PS -->|POST /v1/webhooks/proswing| SVC
    BFF -->|GET /v1/users/:id/shots| SVC
    BFF -->|GET /v1/users/:id/stats| SVC
    BFF -->|POST /v1/users/:id/identities| SVC
    SVC --> DB
    SVC --> RD
    SVC --> OTL
```

---

## Two-process architecture

The service is deployed as **two independent Node.js processes** compiled from the same codebase:

| Process | Entry point | Module | Role |
|---|---|---|---|
| API | `src/main.api.ts` | `AppModule` | Receives HTTP requests; enqueues shots |
| Worker | `src/main.worker.ts` | `WorkerModule` | Processes BullMQ jobs; writes to DB |

Separating the processes means:
- API latency is never blocked by slow DB writes.
- Worker can be scaled independently (more concurrency, more replicas).
- The outbox publisher runs only in the worker — no race between two publishers.

```mermaid
graph LR
    subgraph API[:3000]
        WH[Webhook controllers]
        QS[ShotIngestionQueue]
    end
    subgraph Worker[BullMQ worker]
        PR[ShotIngestionProcessor]
        SR[ShotRepository]
        OP[OutboxPublisherService]
    end
    RD[(Redis)]
    DB[(PostgreSQL)]

    WH --> QS
    QS -->|add job jobId=idempotency_key| RD
    RD -->|dequeue| PR
    PR --> SR
    SR --> DB
    SR -->|outbox row in TX| DB
    OP -->|poll 5s| DB
    OP -->|EventEmitter2| OP
```

---

## Request lifecycle — single shot (TrackPro)

```mermaid
sequenceDiagram
    participant V as Vendor device
    participant A as API process
    participant Q as BullMQ / Redis
    participant W as Worker process
    participant D as PostgreSQL

    V->>A: POST /v1/webhooks/trackpro (JSON)
    A->>A: WebhookAuthGuard (api_key or hmac)
    A->>A: ZodValidationPipe (schema parse)
    A->>A: parseTrackPro() → NormalisedShot
    A->>Q: enqueue(shot, jobId=idempotency_key)
    Q-->>A: { jobId }
    A-->>V: 202 Accepted { canonical_shot_id }

    Q->>W: dequeue job (concurrency 16)
    W->>W: hasExcessiveClockSkew?
    W->>D: resolveCanonicalUserId (Redis cache first)
    W->>D: upsertIfNew() — INSERT ON CONFLICT DO NOTHING RETURNING
    alt inserted = true
        W->>D: INSERT outbox_events (same TX)
        W->>W: checkAndFlagNearDuplicates
        W->>W: getE2eLag().observe()
    else duplicate
        W->>W: shots_total{outcome=deduplicated}
    end

    Note over W,D: OutboxPublisherService polls every 5s
    W->>D: SELECT outbox_events LIMIT 100
    W->>W: EventEmitter2.emit('shot.persisted')
    W->>D: DELETE outbox_events
```

---

## Batch ingestion (SwingMetric)

SwingMetric sends batches of 1–500 shots in one POST.

```mermaid
sequenceDiagram
    participant V as SwingMetric device
    participant A as API
    participant Q as Redis

    V->>A: POST /v1/webhooks/swingmetric [{...}, {...}, ...]
    A->>A: parseSwingmetric() → NormalisedShot[]
    A->>Q: checkBatchCapacity(n) — TOCTOU guard
    loop each shot
        A->>Q: enqueue(shot)
    end
    A-->>V: 202 { accepted: n, rejected: [] }
```

The `checkBatchCapacity(n)` call reads the current queue depth once and rejects the whole batch if `depth + n > MAX_QUEUE_DEPTH`. Without this, a 500-shot batch can overflow by up to 499 because all per-shot depth reads happen before any write lands.

---

## Transactional outbox pattern

```mermaid
sequenceDiagram
    participant W as Worker
    participant D as PostgreSQL
    participant E as EventEmitter2

    W->>D: BEGIN TX
    W->>D: INSERT INTO shots ... ON CONFLICT DO NOTHING RETURNING
    W->>D: INSERT INTO outbox_events (event_type='shot.persisted', payload)
    W->>D: COMMIT

    Note over D,E: OutboxPublisher runs separately every 5s
    D-->>W: SELECT id, event_type, payload FROM outbox_events LIMIT 100
    W->>E: emit('shot.persisted', payload)
    W->>D: DELETE FROM outbox_events WHERE id IN (...)
```

If the worker crashes between COMMIT and DELETE, the outbox row remains and the event re-fires on the next poll cycle. Consumers must be idempotent (they already are — shot ULID is the key).

---

## Deduplication — two layers

```mermaid
flowchart TD
    A[Shot arrives] --> B{jobId already in BullMQ?}
    B -->|yes| C[Job skipped by BullMQ]
    B -->|no| D[Job enqueued]
    D --> E[Worker processes]
    E --> F{INSERT ON CONFLICT\nvendor, idempotency_key\nDO NOTHING}
    F -->|row returned = new| G[Near-dedup check]
    F -->|no row = exact dup| H[outcome=deduplicated]
    G --> I{content_hash match\nwithin ±60s?}
    I -->|yes| J[duplicate_of FK set\nnear_duplicates_total++]
    I -->|no| K[outcome=accepted]
```

**Layer 1 — Exact dedup:** BullMQ `jobId = idempotency_key` prevents duplicate jobs from entering the queue. The database `UNIQUE(vendor, idempotency_key)` constraint is a second backstop.

**Layer 2 — Near dedup:** SHA-256 content hash over 7 normalised fields (see [functions/ingestion.md](../functions/ingestion.md#computecontenthash)). Shots with the same hash within ±60 seconds of each other are soft-flagged via `duplicate_of` FK. No rows are deleted.

---

## Identity resolution

```mermaid
sequenceDiagram
    participant W as Worker
    participant R as Redis
    participant D as PostgreSQL

    W->>R: GET identity:trackpro:user123
    alt cache hit
        R-->>W: canonical_user_id (60s TTL)
    else cache miss
        W->>D: SELECT canonical_user_id FROM user_identities
        D-->>W: row (or null)
        W->>R: SET identity:trackpro:user123 EX 60
    end
    W->>W: shot.canonical_user_id = resolved (or null)
```

If no mapping exists, `canonical_user_id` is stored as `null`. The Portal BFF registers the mapping later; `linkIdentity` backfills all matching shots in a fire-and-forget UPDATE after the transaction commits.
