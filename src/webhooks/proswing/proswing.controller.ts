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
import { ShotIngestionQueue } from "../../ingestion/shot-ingestion.queue";
import { hasExcessiveClockSkew } from "../../ingestion/shot-repository";
import {
  ProswingValidationPipe,
  type ProswingCanonicalPayload,
} from "./proswing.schema";
import { parseProswing } from "./proswing.parser";

@ApiTags("webhooks")
@ApiBearerAuth("api_key")
@Controller("webhooks/proswing")
@UseGuards(WebhookAuthGuard)
@Vendor("proswing")
@SkipThrottle({ default: true, query: true, write: true })
@Throttle({ webhook: { ttl: 1_000, limit: 200 } })
export class ProswingController {
  constructor(private readonly queue: ShotIngestionQueue) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: "Ingest a ProSwing shot",
    description:
      "Accepts a wrapped single-shot payload from Vendor C (ProSwing). " +
      "Supports three wire formats via structural dispatch (O(1) version detection): " +
      "V1 canonical (user_token + nested {value, unit} measurement objects), " +
      "V2 flat (user_token + scalar fields: ball_speed_mph|kph|mps, launch_deg, carry_yd, deviation_yd, etc.), " +
      "V3 player/device envelope (player.id + device.id instead of user_token, scalar launch_angle, optional spin_rpm). " +
      "All measurements are normalised to SI (m, m/s) internally. " +
      "Validates unit-mistag (ball_speed_mps > 120 is physically impossible).",
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
    description: "Schema validation failed (unit-mistag, missing fields)",
    schema: {
      example: {
        error_code: "PAYLOAD_VALIDATION_FAILED",
        message: "Request payload validation failed.",
        correlation_id: "uuid",
        issues: [],
      },
    },
  })
  @ApiResponse({
    status: 422,
    description: "Shot rejected — captured_at is outside the ingestion window",
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
  })
  async receive(
    @Body(new ProswingValidationPipe())
    payload: ProswingCanonicalPayload,
    @Headers("x-correlation-id") correlationHeader?: string,
  ): Promise<{ status: string; correlation_id: string }> {
    const correlationId = correlationHeader ?? randomUUID();
    const receivedAtUtc = new Date().toISOString();
    const [shot] = parseProswing(payload, receivedAtUtc);

    if (hasExcessiveClockSkew(shot!.captured_at_utc, receivedAtUtc)) {
      throw new UnprocessableEntityException({
        error_code: 'CLOCK_SKEW_EXCESSIVE',
        message: 'captured_at is outside the allowed ingestion window (max 24h past, 5min future).',
      });
    }

    await this.queue.enqueue(shot!, correlationId, receivedAtUtc);
    return { status: "accepted", correlation_id: correlationId };
  }
}
