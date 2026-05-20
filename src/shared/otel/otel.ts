// This file must be required/imported BEFORE any other module.
// In production: node -r ./dist/shared/otel/otel.js dist/main.api.js
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .catch((err: unknown) => {
      process.stderr.write(`OTel shutdown error: ${String(err)}\n`);
    })
    .finally(() => process.exit(0));
});
