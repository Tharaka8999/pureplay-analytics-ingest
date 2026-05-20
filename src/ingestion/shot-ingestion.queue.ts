import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit, OnModuleDestroy, ServiceUnavailableException, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { NormalisedShot } from '../shared/domain/shot';
import { getQueueDepth } from '../shared/metrics/ingest-metrics';

export const SHOT_INGESTION_QUEUE = 'shot-ingestion';

export interface ShotJob {
  vendor: string;
  normalisedShot: NormalisedShot;
  correlationId: string;
  receivedAtUtc: string;
}

@Injectable()
export class ShotIngestionQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShotIngestionQueue.name);
  private depthPollInterval: NodeJS.Timeout | undefined;

  constructor(
    @InjectQueue(SHOT_INGESTION_QUEUE) private readonly queue: Queue<ShotJob>,
    private readonly config: ConfigService<Env>,
  ) {}

  onModuleInit(): void {
    this.depthPollInterval = setInterval(() => {
      this.queue.getWaitingCount()
        .then((count) => {
          getQueueDepth().set(count);
        })
        .catch((err: unknown) => {
          // Redis may be temporarily unavailable — log but do not crash the interval.
          // Queue depth metrics stop updating until Redis recovers; this is acceptable.
          this.logger.warn(
            { err },
            'Queue depth poll failed — metric stale until Redis recovers',
          );
        });
    }, 10_000);
  }

  onModuleDestroy(): void {
    if (this.depthPollInterval) clearInterval(this.depthPollInterval);
  }

  async enqueue(
    shot: NormalisedShot,
    correlationId: string,
    receivedAtUtc: string,
  ): Promise<{ jobId: string }> {
    const maxDepth = this.config.get('MAX_QUEUE_DEPTH', { infer: true }) ?? 10000;
    const waiting = await this.queue.getWaitingCount();

    if (waiting >= maxDepth) {
      throw new ServiceUnavailableException({
        error_code: 'SERVICE_UNAVAILABLE',
        message: 'Queue is at capacity. Retry after 30 seconds.',
        retryAfter: 30,
      });
    }

    const job = await this.queue.add(
      'normalise',
      { vendor: shot.vendor, normalisedShot: shot, correlationId, receivedAtUtc },
      {
        jobId: shot.idempotency_key,
        // NOTE: BullMQ priority queue requires `enablePriorityQueue: true` on both
        // the Queue registration AND the Worker/Processor configuration. Without that
        // flag, jobs with a `priority` value are placed in a sorted-set structure that
        // the default Processor never drains, effectively stalling them.
        // SLA-tiered priority (real-time=1 vs batch=2) is deferred to a follow-up
        // once we add `enablePriorityQueue: true` to the BullModule and @Processor config.
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 86400 },
        // Keep failed jobs for 7 days (vs 1 day for completed) so ops can inspect
        // permanently-failed shots without needing to restore from logs.
        removeOnFail: { age: 86400 * 7 },
      },
    );

    return { jobId: job.id! };
  }

  /**
   * [SEC] Batch capacity check — call BEFORE Promise.all(batch.map(enqueue)).
   *
   * The individual enqueue() check has a TOCTOU race when all shots in a
   * batch read the queue depth concurrently before any write lands. A 500-shot
   * batch can overflow MAX_QUEUE_DEPTH by up to 499 if only the per-shot check
   * is used. Pre-checking the entire batch size atomically prevents this.
   *
   * Note: there is still a soft race between concurrent workers/requests, but
   * this is a best-effort cap; truly atomic overflow prevention would require
   * Redis MULTI/EXEC, which is not worth the complexity for this use case.
   */
  async checkBatchCapacity(batchSize: number): Promise<void> {
    const maxDepth = this.config.get('MAX_QUEUE_DEPTH', { infer: true }) ?? 10000;
    const waiting = await this.queue.getWaitingCount();

    if (waiting + batchSize > maxDepth) {
      throw new ServiceUnavailableException({
        error_code: 'SERVICE_UNAVAILABLE',
        message: `Queue is at capacity (depth ${waiting}, batch ${batchSize}, max ${maxDepth}). Retry after 30 seconds.`,
        retryAfter: 30,
      });
    }
  }

  async isJobIdKnown(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    return job != null;
  }
}
