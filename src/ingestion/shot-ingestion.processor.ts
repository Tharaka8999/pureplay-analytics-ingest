import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { ShotRepository, hasExcessiveClockSkew } from "./shot-repository";
import {
  getShotsTotal,
  getE2eLag,
  getNearDuplicates,
  getJobsFailed,
} from "../shared/metrics/ingest-metrics";
import { redactPii } from "../shared/pii-redact";
import type { ShotJob } from "./shot-ingestion.queue";
import { SHOT_INGESTION_QUEUE } from "./shot-ingestion.queue";
import { IdentityService } from "../identity/identity.service";

@Injectable()
@Processor(SHOT_INGESTION_QUEUE, { concurrency: 16 })
export class ShotIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(ShotIngestionProcessor.name);

  constructor(
    private readonly shotRepository: ShotRepository,
    // EventEmitter2 removed: shot.persisted events are now published by
    // OutboxPublisherService polling the outbox_events table, guaranteeing
    // at-least-once delivery even if the worker crashes mid-job.
    private readonly identityService: IdentityService,
  ) {
    super();
  }

  async process(job: Job<ShotJob>): Promise<void> {
    const { normalisedShot: shot, correlationId, receivedAtUtc } = job.data;
    const vendor = shot.vendor;
    const parserVersion = shot.parser_version;

    if (hasExcessiveClockSkew(shot.captured_at_utc, receivedAtUtc)) {
      this.logger.warn(
        `Clock skew > 24h — routing to ingestion_failures | ${JSON.stringify({ correlation_id: correlationId, vendor, shot_id: shot.canonical_shot_id })}`,
      );

      // [SEC] Wrap redactPii in try/catch — JSON.parse/stringify is sync and can
      // throw on malformed payloads. Fallback ensures the failure row is always written.
      let redactedBody: string;
      try {
        redactedBody = redactPii(shot.raw_payload);
      } catch (redactErr) {
        this.logger.error(
          { err: redactErr },
          "PII redaction failed — storing redaction error marker",
        );
        redactedBody = "[PII_REDACTION_ERROR]";
      }

      await this.shotRepository.recordIngestionFailure({
        vendor,
        received_at_utc: receivedAtUtc,
        raw_body: redactedBody,
        http_status: 0,
        error_code: "CLOCK_SKEW_EXCESSIVE",
        error_detail: { captured_at_utc: shot.captured_at_utc },
        correlation_id: correlationId,
      });

      getShotsTotal().inc({
        vendor,
        outcome: "rejected_clock",
        parser_version: parserVersion,
      });
      return;
    }

    // Resolve canonical user ID from the identity mapping table.
    // If no mapping exists yet the shot is stored with canonical_user_id = null
    // and will be backfilled when the Portal BFF registers the mapping.
    const canonicalUserId = await this.identityService.resolveCanonicalUserId(
      shot.vendor,
      shot.vendor_user_id,
    );
    const resolvedShot = canonicalUserId
      ? { ...shot, canonical_user_id: canonicalUserId }
      : shot;

    const { inserted, canonical_shot_id } =
      await this.shotRepository.upsertIfNew(resolvedShot);

    if (!inserted) {
      getShotsTotal().inc({
        vendor,
        outcome: "duplicate_exact",
        parser_version: parserVersion,
      });
      this.logger.debug(
        `Shot deduplicated (exact) | ${JSON.stringify({ correlation_id: correlationId, vendor, canonical_shot_id })}`,
      );
      return;
    }

    // Near-dedupe check runs only on newly inserted shots.
    // Returns the origin canonical_shot_id when a near-dup is found so we can
    // update the outbox event payload before the publisher reads it.
    const nearDupOriginId =
      await this.shotRepository.checkAndFlagNearDuplicates(resolvedShot);
    if (nearDupOriginId !== null) {
      getNearDuplicates().inc({ vendor });
      getShotsTotal().inc({
        vendor,
        outcome: "duplicate_near",
        parser_version: parserVersion,
      });
      // Propagate duplicate_of into the outbox payload so downstream consumers
      // see the correct relationship even before the row is polled.
      await this.shotRepository.updateOutboxEventDuplicateOf(
        canonical_shot_id,
        nearDupOriginId,
      );
      this.logger.debug(
        `Shot flagged near-duplicate | ${JSON.stringify({ correlation_id: correlationId, vendor, canonical_shot_id, duplicate_of: nearDupOriginId })}`,
      );
    } else {
      getShotsTotal().inc({
        vendor,
        outcome: "accepted",
        parser_version: parserVersion,
      });
    }

    // shot.persisted event is published by OutboxPublisherService (transactional outbox).
    // The outbox row was written atomically with the shot INSERT in upsertIfNew().

    const lagMs = Date.now() - new Date(receivedAtUtc).getTime();
    getE2eLag().observe({ vendor }, lagMs);

    this.logger.log(
      `Shot persisted | ${JSON.stringify({ correlation_id: correlationId, vendor, canonical_shot_id, outcome: "accepted" })}`,
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ShotJob> | undefined, error: Error): void {
    const vendor = job?.data?.normalisedShot?.vendor ?? "unknown";
    const parserVersion =
      job?.data?.normalisedShot?.parser_version ?? "unknown";
    const correlationId = job?.data?.correlationId ?? "unknown";
    const jobId = job?.id ?? "unknown";

    // Use warn, not error — permanent job failures are expected under transient vendor
    // issues (network timeouts, DB restarts) and should not trigger error-level alerts.
    // The getJobsFailed() counter is the right signal for alerting; log is for context.
    this.logger.warn(
      `Job permanently failed after all retries — shot lost | ${JSON.stringify({
        job_id: jobId,
        correlation_id: correlationId,
        vendor,
        error: error.message,
        attempts_made: job?.attemptsMade ?? 0,
      })}`,
    );

    getJobsFailed().inc({ vendor });
    getShotsTotal().inc({
      vendor,
      outcome: "failed",
      parser_version: parserVersion,
    });
  }
}
