import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  Inject,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { type Kysely } from "kysely";
import type { Database } from "../shared/kysely/types";
import { KYSELY } from "../shared/kysely/kysely.module";
import {
  SHOT_PERSISTED_EVENT,
  ShotPersistedEvent,
} from "./events/shot-persisted.event";
import type { NormalisedShot } from "../shared/domain/shot";

// Poll the outbox table every 5 seconds.
const POLL_INTERVAL_MS = 5_000;

// Process at most 100 events per poll cycle to bound memory and DB round-trip time.
const BATCH_SIZE = 100;

/**
 * Transactional Outbox Publisher.
 *
 * Polls the outbox_events table, re-emits each event via EventEmitter2, then
 * deletes the row. Runs ONLY in the Worker process — registered in WorkerModule,
 * NOT in IngestionModule — to prevent dual-process races where the API process
 * and the worker both consume and delete the same outbox rows.
 *
 * Failure semantics: if emit succeeds but the DELETE fails, the event will be
 * re-emitted on the next poll cycle (at-least-once delivery). Downstream
 * handlers must tolerate duplicate events (idempotency via canonical_shot_id).
 */
@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private pollInterval: NodeJS.Timeout | undefined;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    // Fire immediately on startup to drain any events that accumulated while
    // the worker was restarting, then enter the regular polling cadence.
    void this.publishPending();
    this.pollInterval = setInterval(() => {
      this.publishPending().catch((err: unknown) => {
        this.logger.error(
          { err },
          "Outbox publish cycle failed — will retry next interval",
        );
      });
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /**
   * Fetch up to BATCH_SIZE pending outbox events, emit each, then delete them.
   *
   * Runs inside a transaction so FOR UPDATE SKIP LOCKED holds row-level locks
   * across the entire batch — two worker replicas each claim a disjoint set of
   * rows and never process the same event. Without a transaction, auto-commit
   * mode releases the lock immediately after SELECT, making SKIP LOCKED useless.
   *
   * Rows that emit successfully are bulk-deleted at commit time. Rows that fail
   * to emit are left in the table and retried on the next poll cycle.
   */
  async publishPending(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("outbox_events")
        .selectAll()
        .orderBy("created_at", "asc")
        .limit(BATCH_SIZE)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return;

      this.logger.debug(`Outbox: publishing ${rows.length} pending event(s)`);

      const successfulIds: number[] = [];

      for (const row of rows) {
        try {
          if (row.event_type === "shot.persisted") {
            // The outbox payload was written without raw_payload (PII exclusion).
            // Listeners that need raw_payload must fetch the shot from DB by canonical_shot_id.
            const shot = { ...row.payload, raw_payload: {} } as NormalisedShot;
            this.eventEmitter.emit(
              SHOT_PERSISTED_EVENT,
              new ShotPersistedEvent(shot),
            );
          } else {
            this.logger.warn(
              { event_type: row.event_type, outbox_id: row.id },
              "Unknown outbox event type — skipping",
            );
          }
          successfulIds.push(row.id);
        } catch (err: unknown) {
          this.logger.error(
            { err, outbox_id: row.id, event_type: row.event_type },
            "Failed to publish outbox event — row retained for next cycle",
          );
          // Do not rethrow — continue processing remaining rows in the batch.
        }
      }

      if (successfulIds.length > 0) {
        await trx
          .deleteFrom("outbox_events")
          .where("id", "in", successfulIds)
          .execute();
      }
    });
  }
}
