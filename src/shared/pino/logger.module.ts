import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { LoggerModule as PinoLoggerModule } from "nestjs-pino";
import type { Env } from "../../config/env.schema";

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>) => {
        const nodeEnv = config.get("NODE_ENV", { infer: true });
        const isProd = nodeEnv === "production";
        const isDev = nodeEnv === "development";
        return {
          pinoHttp: {
            level: isProd ? "info" : "debug",
            // pino-pretty only in development — not in test or production
            transport: isDev
              ? { target: "pino-pretty", options: { colorize: true } }
              : undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            genReqId: (req: any): string => {
              const h = req.headers?.["x-correlation-id"];
              return (
                ((Array.isArray(h) ? h[0] : h) as string | undefined) ??
                randomUUID()
              );
            },
            // [SEC] Explicit redact list — belt-and-suspenders alongside the serializer.
            // Prevents auth secrets leaking if the serializer is ever extended to log headers.
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              'req.headers["x-webhook-auth"]',
              'req.headers["x-webhook-signature"]',
              "*.password",
              "*.secret",
              "*.token",
            ],
            // [OBS] Inject OTel trace ID into every log line so logs can be correlated
            // with distributed traces in the observability backend.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customProps: (_req: any): Record<string, unknown> => {
              try {
                // Import is dynamic to avoid loading OTel in test environments where it may not be initialised.
                /* eslint-disable @typescript-eslint/no-require-imports */
                const otel =
                  require("@opentelemetry/api") as typeof import("@opentelemetry/api");
                /* eslint-enable @typescript-eslint/no-require-imports */
                const { trace, context } = otel;
                const span = trace.getSpan(context.active());
                if (span) {
                  const { traceId, spanId } = span.spanContext();
                  return { traceId, spanId };
                }
              } catch {
                // OTel not initialised — ignore.
              }
              return {};
            },
            serializers: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              req: (req: any) => ({
                method: req.method as string,
                url: req.url as string,
                remoteAddress: req.remoteAddress as string,
                // Headers intentionally excluded — use redact list above as safety net.
              }),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              res: (res: any) => ({
                statusCode: res.statusCode as number,
              }),
            },
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
