import { timingSafeEqual, createHmac } from "crypto";
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  SetMetadata,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { Env } from "../../config/env.schema";
import { getAuthFailures } from "../metrics/ingest-metrics";

export const VENDOR_KEY = "webhook_vendor";
export const Vendor = (vendor: string) => SetMetadata(VENDOR_KEY, vendor);

@Injectable()
export class WebhookAuthGuard implements CanActivate {
  // NestJS Logger is intercepted by nestjs-pino at the app level — no console.log.
  private readonly logger = new Logger(WebhookAuthGuard.name);

  constructor(
    private readonly config: ConfigService<Env>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const mode =
      this.config.get("WEBHOOK_AUTH_MODE", { infer: true }) ?? "none";

    if (mode === "none") {
      return true;
    }

    if (mode === "hmac") {
      const req = context.switchToHttp().getRequest<FastifyRequest>();
      const vendor =
        this.reflector.get<string>(VENDOR_KEY, context.getHandler()) ??
        this.reflector.get<string>(VENDOR_KEY, context.getClass());

      if (!vendor) {
        throw new UnauthorizedException(
          "No vendor metadata configured for this route.",
        );
      }

      const envSecretKey = `${vendor.toUpperCase()}_HMAC_SECRET` as keyof Env;
      const secret = this.config.get(envSecretKey, { infer: true }) as
        | string
        | undefined;
      if (!secret) {
        getAuthFailures().inc({ vendor: vendor ?? "unknown", mode: "hmac" });
        throw new UnauthorizedException(
          "HMAC secret not configured for this vendor.",
        );
      }

      const headers = req.headers as Record<string, string | undefined>;
      const tsHeader = headers["x-webhook-timestamp"];
      const sigHeader = headers["x-webhook-signature"];

      if (!tsHeader || !sigHeader) {
        throw new UnauthorizedException(
          "Missing X-Webhook-Timestamp or X-Webhook-Signature header.",
        );
      }

      // Replay window: 5 minutes
      const nowSec = Math.floor(Date.now() / 1000);
      const tsSec = parseInt(tsHeader, 10);
      if (isNaN(tsSec) || Math.abs(nowSec - tsSec) > 300) {
        throw new UnauthorizedException(
          "Request timestamp is outside the 5-minute replay window.",
        );
      }

      // rawBody is set by the Fastify content-type parser in main.api.ts
      const rawBody =
        (req as FastifyRequest & { rawBody?: Buffer }).rawBody ??
        Buffer.alloc(0);
      const signedPayload = `${tsHeader}.${rawBody.toString("utf8")}`;

      const expectedSig = `sha256=${createHmac("sha256", secret).update(signedPayload).digest("hex")}`;

      // Constant-time compare (same length required)
      const expectedBuf = Buffer.from(expectedSig, "utf8");
      const providedBuf = Buffer.from(sigHeader, "utf8");

      if (
        expectedBuf.length !== providedBuf.length ||
        !timingSafeEqual(expectedBuf, providedBuf)
      ) {
        this.logger.warn({ vendor, path: req.url }, "HMAC signature rejected");
        getAuthFailures().inc({ vendor: vendor ?? "unknown", mode: "hmac" });
        throw new UnauthorizedException("Invalid HMAC signature.");
      }

      return true;
    }

    // mode === 'api_key'
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const vendor =
      this.reflector.get<string>(VENDOR_KEY, context.getHandler()) ??
      this.reflector.get<string>(VENDOR_KEY, context.getClass());

    if (!vendor) {
      throw new UnauthorizedException(
        "No vendor metadata configured for this route.",
      );
    }

    const envKey = `${vendor.toUpperCase()}_API_KEY` as keyof Env;
    const expectedKey = this.config.get(envKey, { infer: true }) as
      | string
      | undefined;

    const providedKey = (req.headers as Record<string, string | undefined>)[
      "x-webhook-auth"
    ];

    if (!providedKey || !expectedKey) {
      getAuthFailures().inc({ vendor: vendor ?? "unknown", mode: "api_key" });
      throw new UnauthorizedException(
        "Missing or unconfigured webhook authentication key.",
      );
    }

    try {
      const expected = Buffer.from(expectedKey, "utf8");
      const provided = Buffer.from(providedKey, "utf8");

      // Constant-time comparison prevents timing attacks (T001 in threat model).
      if (
        expected.length !== provided.length ||
        !timingSafeEqual(expected, provided)
      ) {
        this.logger.warn({ vendor, path: req.url }, "API key rejected");
        getAuthFailures().inc({ vendor: vendor ?? "unknown", mode: "api_key" });
        throw new UnauthorizedException("Invalid webhook authentication key.");
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      getAuthFailures().inc({ vendor: vendor ?? "unknown", mode: "api_key" });
      throw new UnauthorizedException("Invalid webhook authentication key.");
    }

    return true;
  }
}
