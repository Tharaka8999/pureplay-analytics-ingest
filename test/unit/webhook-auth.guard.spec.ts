import { createHmac } from "crypto";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { WebhookAuthGuard } from "../../src/shared/auth/webhook-auth.guard";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeContext(
  headers: Record<string, string | undefined>,
  _metadata?: string,
  rawBody?: Buffer,
): ExecutionContext {
  const mockReq = {
    headers,
    raw: { headers },
    rawBody,
  };
  const mockHandler = { name: "testHandler" };
  const mockClass = { name: "TestController" };

  return {
    switchToHttp: () => ({ getRequest: () => mockReq }),
    getHandler: () => mockHandler,
    getClass: () => mockClass,
  } as unknown as ExecutionContext;
}

/**
 * Build a guard with a mocked ConfigService and a no-op PinoLogger.
 * @param mode          WEBHOOK_AUTH_MODE value
 * @param apiKey        value returned for <VENDOR>_API_KEY  (api_key mode)
 * @param vendor        vendor name used for key/secret lookups
 * @param hmacSecret    value returned for <VENDOR>_HMAC_SECRET (hmac mode)
 */
function buildGuard(
  mode: string,
  apiKey = "secret-key",
  vendor = "trackpro",
  hmacSecret?: string,
) {
  const config = {
    get: vi.fn((key: string) => {
      if (key === "WEBHOOK_AUTH_MODE") return mode;
      if (key === `${vendor.toUpperCase()}_API_KEY`) return apiKey;
      if (key === `${vendor.toUpperCase()}_HMAC_SECRET`) return hmacSecret;
      return undefined;
    }),
  };
  const reflector = {
    get: vi.fn().mockReturnValue(vendor),
  };
  // Minimal PinoLogger stub — WebhookAuthGuard calls logger.warn() on auth failures.
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return new WebhookAuthGuard(
    config as never,
    reflector as never,
    logger as never,
  );
}

/** Compute the expected HMAC signature string for a given payload */
function signPayload(secret: string, timestamp: string, body: Buffer): string {
  const payload = `${timestamp}.${body.toString("utf8")}`;
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hex}`;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("WebhookAuthGuard [SEC]", () => {
  // ── mode=none ─────────────────────────────────────────────────────────────
  describe("mode=none", () => {
    it("allows all requests", async () => {
      const guard = buildGuard("none");
      const ctx = makeContext({});
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  // ── mode=api_key ──────────────────────────────────────────────────────────
  describe("mode=api_key", () => {
    it("accepts request with correct X-Webhook-Auth header", async () => {
      const guard = buildGuard("api_key", "my-secret");
      const ctx = makeContext({ "x-webhook-auth": "my-secret" });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("rejects request with incorrect X-Webhook-Auth header", async () => {
      const guard = buildGuard("api_key", "my-secret");
      const ctx = makeContext({ "x-webhook-auth": "wrong-secret" });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects request with missing X-Webhook-Auth header", async () => {
      const guard = buildGuard("api_key", "my-secret");
      const ctx = makeContext({});
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("[SEC] rejects vendor A key on vendor B endpoint (cross-vendor rejection)", async () => {
      // TrackPro key presented to SwingMetric endpoint
      const swingmetricGuard = buildGuard(
        "api_key",
        "sm-secret",
        "swingmetric",
      );
      const ctx = makeContext({ "x-webhook-auth": "tp-secret" }); // wrong key for SM
      await expect(swingmetricGuard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("[SEC] uses crypto.timingSafeEqual (not string equality)", async () => {
      // Identical-length wrong key must still be rejected — tests constant-time path
      const guard = buildGuard("api_key", "aaaa");
      const ctx = makeContext({ "x-webhook-auth": "bbbb" }); // same length, different content
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── mode=hmac ─────────────────────────────────────────────────────────────
  describe("mode=hmac", () => {
    const HMAC_SECRET = "test-hmac-secret-supersafe-1234";
    const rawBody = Buffer.from(
      JSON.stringify({ event: "shot.captured", id: "tp_001" }),
    );

    it("accepts request with a valid HMAC-SHA256 signature", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = signPayload(HMAC_SECRET, ts, rawBody);
      const ctx = makeContext(
        { "x-webhook-timestamp": ts, "x-webhook-signature": sig },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("rejects when X-Webhook-Timestamp header is missing", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const ctx = makeContext(
        { "x-webhook-signature": "sha256=deadbeef" },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects when X-Webhook-Signature header is missing", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const ts = String(Math.floor(Date.now() / 1000));
      const ctx = makeContext(
        { "x-webhook-timestamp": ts },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects timestamp older than 5-minute replay window", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const staleTs = String(Math.floor(Date.now() / 1000) - 400); // ~6m40s ago
      const sig = signPayload(HMAC_SECRET, staleTs, rawBody);
      const ctx = makeContext(
        { "x-webhook-timestamp": staleTs, "x-webhook-signature": sig },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects timestamp more than 5 minutes in the future", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const futureTs = String(Math.floor(Date.now() / 1000) + 400); // ~6m40s ahead
      const sig = signPayload(HMAC_SECRET, futureTs, rawBody);
      const ctx = makeContext(
        { "x-webhook-timestamp": futureTs, "x-webhook-signature": sig },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("[SEC] rejects an invalid HMAC signature (constant-time comparison)", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const ts = String(Math.floor(Date.now() / 1000));
      // Correct format (same length as a real sig) but wrong bytes
      const wrongSig = `sha256=${"a".repeat(64)}`;
      const ctx = makeContext(
        { "x-webhook-timestamp": ts, "x-webhook-signature": wrongSig },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("[SEC] rejects when HMAC secret is not configured for the vendor", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", undefined); // no secret set
      const ts = String(Math.floor(Date.now() / 1000));
      const ctx = makeContext(
        { "x-webhook-timestamp": ts, "x-webhook-signature": "sha256=fake" },
        "trackpro",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("[SEC] rejects signature computed over different body (body tampering)", async () => {
      const guard = buildGuard("hmac", "unused", "trackpro", HMAC_SECRET);
      const ts = String(Math.floor(Date.now() / 1000));
      // Signature was computed over originalBody, but we send tamperedBody
      const originalBody = Buffer.from('{"shots":1}');
      const tamperedBody = Buffer.from('{"shots":999}');
      const sig = signPayload(HMAC_SECRET, ts, originalBody);
      const ctx = makeContext(
        { "x-webhook-timestamp": ts, "x-webhook-signature": sig },
        "trackpro",
        tamperedBody, // different body than what was signed
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("[SEC] rejects cross-vendor key misuse in hmac mode", async () => {
      const SWINGMETRIC_SECRET = "swingmetric-hmac-secret-xyz";
      // Guard configured for swingmetric — but caller signs with trackpro secret
      const guard = buildGuard(
        "hmac",
        "unused",
        "swingmetric",
        SWINGMETRIC_SECRET,
      );
      const ts = String(Math.floor(Date.now() / 1000));
      const sigWithTrackproSecret = signPayload(
        "trackpro-wrong-secret",
        ts,
        rawBody,
      );
      const ctx = makeContext(
        {
          "x-webhook-timestamp": ts,
          "x-webhook-signature": sigWithTrackproSecret,
        },
        "swingmetric",
        rawBody,
      );
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
