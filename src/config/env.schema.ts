import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Database — z.string().min(1) is intentional: boot-crash on missing value.
    // Never use .default('') for DATABASE_URL or REDIS_URL.
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    // [SEC] WEBHOOK_AUTH_MODE=none is forbidden in NODE_ENV=production (enforced below).
    WEBHOOK_AUTH_MODE: z.enum(['none', 'api_key', 'hmac']).default('none'),

    // Per-vendor API keys (required only when WEBHOOK_AUTH_MODE=api_key)
    TRACKPRO_API_KEY: z.string().optional(),
    SWINGMETRIC_API_KEY: z.string().optional(),
    PROSWING_API_KEY: z.string().optional(),

    QUEUE_NAME: z.string().min(1).default('shot-ingestion'),
    MAX_QUEUE_DEPTH: z.coerce.number().int().min(1).default(10000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(16),

    RUN_MIGRATIONS: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default(false),

    OTEL_SERVICE_NAME: z.string().default('pureplay-analytics-ingest'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // DB pool — size for high-concurrency worker processes
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),

    // CORS — allowed origin for browser clients.
    // [SEC] Must be an explicit URL in production; never '*'. Enforced in superRefine below.
    CORS_ORIGIN: z.string().default('*'),

    // HMAC webhook auth secrets (required only when WEBHOOK_AUTH_MODE=hmac)
    TRACKPRO_HMAC_SECRET: z.string().optional(),
    SWINGMETRIC_HMAC_SECRET: z.string().optional(),
    PROSWING_HMAC_SECRET: z.string().optional(),

    // Rate limiting — set THROTTLE_ENABLED=false to bypass all throttlers for local k6 runs.
    // z.coerce.boolean() CANNOT be used here: Boolean('false') === true in JS (non-empty string).
    // Mirror the RUN_MIGRATIONS pattern: enum → transform → boolean default.
    // [SEC] THROTTLE_ENABLED=false is forbidden in NODE_ENV=production (enforced below).
    THROTTLE_ENABLED: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default(true),

    // [SEC] Bearer token protecting the internal query/stats/identity/metrics endpoints.
    // Required in production. If unset in development, endpoints are unprotected (with a warning).
    INTERNAL_API_KEY: z.string().min(32).optional(),
  })
  // Cross-field production safety checks — boot-crash on misconfiguration.
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (data.WEBHOOK_AUTH_MODE === 'none') {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_AUTH_MODE'],
          message: 'WEBHOOK_AUTH_MODE cannot be "none" in production. Set to "api_key" or "hmac".',
        });
      }
      if (!data.THROTTLE_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['THROTTLE_ENABLED'],
          message: 'THROTTLE_ENABLED cannot be false in production.',
        });
      }
      if (!data.INTERNAL_API_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['INTERNAL_API_KEY'],
          message: 'INTERNAL_API_KEY must be set (min 32 chars) in production to protect query endpoints.',
        });
      }
      if (data.CORS_ORIGIN === '*') {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGIN'],
          message: 'CORS_ORIGIN cannot be "*" in production. Set to your portal origin (e.g. https://app.example.com).',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validate(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const formatted = result.error.issues
      .map((e: { path: unknown[]; message: string }) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${formatted}`);
  }
  return result.data;
}
