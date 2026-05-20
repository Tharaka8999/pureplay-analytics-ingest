import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  UseGuards,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from "@nestjs/swagger";
import { Throttle, SkipThrottle } from "@nestjs/throttler";
import { randomUUID } from "crypto";
import { WebhookAuthGuard, Vendor } from "../../shared/auth/webhook-auth.guard";
import { ZodValidationPipe } from "../../shared/zod-validation.pipe";
import { ShotIngestionQueue } from "../../ingestion/shot-ingestion.queue";
import { hasExcessiveClockSkew } from "../../ingestion/shot-repository";
import {
  TrackproPayloadSchema,
  type TrackproPayload,
} from "./trackpro.schema";
import { parseTrackpro } from "./trackpro.parser";

@ApiTags("webhooks")
@ApiBearerAuth("api_key")
@Controller("webhooks/trackpro")
@UseGuards(WebhookAuthGuard)
@Vendor("trackpro")
// Only the 'webhook' throttler should apply here.
// @Throttle overrides the webhook bucket; @SkipThrottle drops the other three
// so the most-restrictive-wins logic cannot silently cap this at 10 req/s.
@SkipThrottle({ default: true, query: true, write: true })
@Throttle({ webhook: { ttl: 1_000, limit: 200 } })
export class TrackproController {
  constructor(private readonly queue: ShotIngestionQueue) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: "Ingest a TrackPro shot",
    description:
      "Accepts a single-shot payload from Vendor A (TrackPro). All measurements in SI units. " +
      "Validated with a single Zod schema (TrackPro has one wire format). " +
      "Returns 202 immediately; processing is async via BullMQ.",
  })
  @ApiHeader({
    name: "x-correlation-id",
    description: "Caller-supplied trace ID; auto-generated if absent",
    required: false,
  })
  @ApiResponse({
    status: 202,
    description: "Shot enqueued for processing",
    schema: { example: { status: "accepted", correlation_id: "uuid" } },
  })
  @ApiResponse({
    status: 400,
    description: "Schema validation failed",
    schema: {
      example: {
        error_code: "PAYLOAD_VALIDATION_FAILED",
        message: "Request payload validation failed.",
        correlation_id: "uuid",
        issues: [
          {
            path: "ball_speed_mps",
            code: "too_small",
            message: "Number must be >= 0",
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: "Shot rejected — captured_at is more than 24h in the past or 5min in the future",
    schema: {
      example: {
        error_code: "CLOCK_SKEW_EXCESSIVE",
        message: "captured_at is outside the allowed ingestion window (max 24h past, 5min future).",
        correlation_id: "uuid",
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: "Queue at capacity — retry after 30s",
    headers: {
      "Retry-After": { description: "30", schema: { type: "integer" } },
    },
  })
  async receive(
    @Body(new ZodValidationPipe(TrackproPayloadSchema))
    payload: TrackproPayload,
    @Headers("x-correlation-id") correlationHeader?: string,
  ): Promise<{ status: string; correlation_id: string }> {
    const correlationId = correlationHeader ?? randomUUID();
    const receivedAtUtc = new Date().toISOString();

    const [shot] = parseTrackpro(payload, receivedAtUtc);

    if (hasExcessiveClockSkew(shot!.captured_at_utc, receivedAtUtc)) {
      throw new UnprocessableEntityException({
        error_code: 'CLOCK_SKEW_EXCESSIVE',
        message: 'captured_at is outside the allowed ingestion window (max 24h past, 5min future).',
      });
    }

    // BullMQ deduplicates by jobId silently — no exception is thrown when the
    // same idempotency_key is re-submitted; the existing job is returned as-is.
    // The 503 from ShotIngestionQueue.enqueue() (backpressure) is the only
    // exception that can propagate here, and it is handled by the global filter.
    await this.queue.enqueue(shot!, correlationId, receivedAtUtc);
    return { status: "accepted", correlation_id: correlationId };
  }
}
