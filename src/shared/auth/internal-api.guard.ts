import { timingSafeEqual } from "crypto";
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest } from "fastify";
import type { Env } from "../../config/env.schema";

/**
 * InternalApiGuard — protects query / stats / identity / metrics endpoints.
 *
 * WEBHOOK_AUTH_MODE only governs ingest paths. These internal read/write endpoints
 * use a separate INTERNAL_API_KEY so that:
 *  - The Portal BFF can authenticate backend calls without sharing webhook keys.
 *  - Prometheus scrapers can reach /metrics with a dedicated secret.
 *
 * Production behaviour (enforced by env.schema.ts .superRefine()):
 *   INTERNAL_API_KEY must be set (min 32 chars) or the process refuses to start.
 *
 * Development behaviour (INTERNAL_API_KEY unset):
 *   Requests are allowed through with a warning log. Endpoints are unprotected.
 *   This matches WEBHOOK_AUTH_MODE=none semantics for dev convenience.
 *
 * [SEC] Uses timingSafeEqual — constant-time compare prevents timing side-channels.
 * [SEC] Unequal-length keys are definitively rejected before reaching the comparison.
 */
@Injectable()
export class InternalApiGuard implements CanActivate {
  // NestJS Logger is intercepted by nestjs-pino at the app level — no console.log.
  private readonly logger = new Logger(InternalApiGuard.name);

  constructor(private readonly config: ConfigService<Env>) {}

  canActivate(context: ExecutionContext): boolean {
    const key = this.config.get("INTERNAL_API_KEY", { infer: true });

    if (!key) {
      // In development, INTERNAL_API_KEY is optional. env.schema.ts superRefine()
      // blocks startup in production if the key is absent.
      this.logger.warn(
        "INTERNAL_API_KEY is not set — query/identity/metrics endpoints are unprotected. " +
          "Set INTERNAL_API_KEY (min 32 chars) before deploying to production.",
      );
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const authHeader = (req.headers as Record<string, string | undefined>)[
      "authorization"
    ];
    const provided = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

    if (!provided) {
      throw new UnauthorizedException(
        "Authorization: Bearer <INTERNAL_API_KEY> header is required for this endpoint.",
      );
    }

    const expectedBuf = Buffer.from(key, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");

    // [SEC] timingSafeEqual requires equal-length buffers.
    // Length mismatch is itself a definitive rejection — no need to compare.
    if (
      expectedBuf.length !== providedBuf.length ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      this.logger.warn({ path: req.url }, "Internal API key rejected");
      throw new UnauthorizedException("Invalid internal API key.");
    }

    return true;
  }
}
