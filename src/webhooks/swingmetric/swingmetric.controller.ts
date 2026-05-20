import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  UseGuards,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { WebhookAuthGuard, Vendor } from '../../shared/auth/webhook-auth.guard';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { ShotIngestionQueue } from '../../ingestion/shot-ingestion.queue';
import { hasExcessiveClockSkew } from '../../ingestion/shot-repository';
import {
  SwingmetricPayloadSchema,
  type SwingmetricPayload,
} from './swingmetric.schema';
import { parseSwingmetric } from './swingmetric.parser';

@ApiTags('webhooks')
@ApiBearerAuth('api_key')
@Controller('webhooks/swingmetric')
@UseGuards(WebhookAuthGuard)
@Vendor('swingmetric')
@SkipThrottle({ default: true, query: true, write: true })
@Throttle({ webhook: { ttl: 1_000, limit: 200 } })
export class SwingmetricController {
  constructor(private readonly queue: ShotIngestionQueue) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Ingest a SwingMetric batch',
    description:
      'Accepts a batch of 1–500 shots from Vendor B (SwingMetric). ' +
      'Accepts both V1 (club_used / launch_deg / carry_yds / offline_yds) and ' +
      'V2 (club / launch_angle / carry_yd / offline_yd) wire formats via field-name ' +
      'normalisation in the schema — no separate adapter layer needed. ' +
      'Enqueues one BullMQ job per shot. Within-batch duplicates are soft-flagged.',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    description: 'Caller-supplied trace ID; auto-generated if absent',
    required: false,
  })
  @ApiResponse({
    status: 202,
    description: 'All shots in batch enqueued',
    schema: { example: { status: 'accepted', correlation_id: 'uuid' } },
  })
  @ApiResponse({
    status: 400,
    description: 'Schema validation failed (empty batch, field type errors)',
    schema: {
      example: {
        error_code: 'PAYLOAD_VALIDATION_FAILED',
        message: 'Request payload validation failed.',
        correlation_id: 'uuid',
        issues: [],
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: "One or more shots rejected — captured_at is outside the ingestion window",
    schema: {
      example: {
        error_code: "CLOCK_SKEW_EXCESSIVE",
        message: "captured_at is outside the allowed ingestion window (max 24h past, 5min future).",
        correlation_id: "uuid",
      },
    },
  })
  @ApiResponse({ status: 503, description: 'Queue at capacity — retry after 30s' })
  async receive(
    @Body(new ZodValidationPipe(SwingmetricPayloadSchema))
    payload: SwingmetricPayload,
    @Headers('x-correlation-id') correlationHeader?: string,
  ): Promise<{ status: string; correlation_id: string }> {
    const correlationId = correlationHeader ?? randomUUID();
    const receivedAtUtc = new Date().toISOString();
    const shots = parseSwingmetric(payload, receivedAtUtc);

    const skewedShot = shots.find((s) => hasExcessiveClockSkew(s.captured_at_utc, receivedAtUtc));
    if (skewedShot) {
      throw new UnprocessableEntityException({
        error_code: 'CLOCK_SKEW_EXCESSIVE',
        message: 'captured_at is outside the allowed ingestion window (max 24h past, 5min future).',
      });
    }

    // [SEC] TOCTOU guard: check capacity for the entire batch BEFORE enqueueing.
    await this.queue.checkBatchCapacity(shots.length);

    await Promise.all(
      shots.map((shot) => this.queue.enqueue(shot, correlationId, receivedAtUtc)),
    );

    return { status: 'accepted', correlation_id: correlationId };
  }
}
