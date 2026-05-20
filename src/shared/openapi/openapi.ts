import { type INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

// [SEC] OpenAPI is only mounted in development (gated in main.api.ts).
// Never expose Swagger in production — it leaks the full API surface and
// the "Try it out" feature can be used to drive real traffic against the service.
export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Pureplay Analytics Ingest')
    .setDescription(
      `Multi-vendor golf shot ingestion and query service.

Accepts webhooks from TrackPro, SwingMetric, and ProSwing launch monitors,
normalises all data to one canonical shot schema, deduplicates retransmits,
and exposes shot history and per-club stats for query.

**Webhook authentication**: controlled by \`WEBHOOK_AUTH_MODE\` env var.
- \`none\` — development only, all requests accepted (never use in production)
- \`api_key\` — \`X-Webhook-Auth: <key>\` header verified with constant-time compare
- \`hmac\` — \`X-Webhook-Signature: sha256=<sig>\` + \`X-Webhook-Timestamp\` headers

**Internal endpoint authentication**: query / stats / identity / metrics endpoints
require \`Authorization: Bearer <INTERNAL_API_KEY>\` in production.

**IDOR trust boundary**: query endpoints trust the caller to supply a correctly-scoped
user_id. The Portal BFF is responsible for access control; this service must never be
exposed directly to the public internet.`,
    )
    .setVersion('1.0.0')
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Webhook-Auth', description: 'Per-vendor webhook API key (WEBHOOK_AUTH_MODE=api_key)' },
      'webhook_api_key',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'Internal API key for query/stats/identity/metrics (INTERNAL_API_KEY)' },
      'internal_api_key',
    )
    .addTag('webhooks', 'Ingest endpoints for launch monitor vendors')
    .addTag('shots', 'Query normalised shot records')
    .addTag('stats', 'Per-club aggregate statistics')
    .addTag('identity', 'Manage vendor → canonical user identity mappings')
    .addTag('health', 'Liveness and readiness probes')
    .addTag('metrics', 'Prometheus metrics')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    yamlDocumentUrl: 'api/docs-yaml',
    swaggerOptions: {
      // [SEC] persistAuthorization: false — prevents credentials being stored
      // in localStorage where they could be exfiltrated by XSS or extensions.
      persistAuthorization: false,
      // [SEC] tryItOutEnabled: false — "Try it out" sends real requests to the
      // live service. Disable in dev docs to prevent accidental production traffic.
      tryItOutEnabled: false,
      filter: true,
      displayRequestDuration: true,
    },
  });
}
