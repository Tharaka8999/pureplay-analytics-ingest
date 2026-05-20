import { Module, Controller, Get, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { collectDefaultMetrics, register } from 'prom-client';
import type { FastifyReply } from 'fastify';
import { InternalApiGuard } from '../auth/internal-api.guard';
import { getShotsTotal, getE2eLag, getNearDuplicates, getQueueDepth, getJobsFailed, getAuthFailures } from './ingest-metrics';

collectDefaultMetrics({ prefix: 'pureplay_node_' });
// Eagerly register ALL custom metrics so they appear in /metrics even before first data point.
// This prevents Prometheus from seeing a metric as "new" on first observation and avoids
// missing the first data point in dashboards that use increase() or rate().
getShotsTotal();
getE2eLag();
getNearDuplicates();
getQueueDepth();
getJobsFailed();
getAuthFailures();

// [SEC] /metrics is protected by InternalApiGuard.
// Prometheus text format can leak queue depths, error rates, and auth failure counts —
// all sensitive operational data that must not be publicly readable.
@ApiTags('metrics')
@ApiBearerAuth('internal_api_key')
@SkipThrottle()
@UseGuards(InternalApiGuard)
@Controller()
export class MetricsController {
  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus metrics', description: 'Returns all metrics in Prometheus text format. Scrape with your Prometheus instance. Requires Authorization: Bearer <INTERNAL_API_KEY>.' })
  @ApiResponse({ status: 200, description: 'Prometheus text exposition format', content: { 'text/plain': {} } })
  @ApiResponse({ status: 401, description: 'Missing or invalid INTERNAL_API_KEY' })
  async getMetrics(@Res() reply: FastifyReply): Promise<void> {
    const metrics = await register.metrics();
    await reply
      .header('Content-Type', register.contentType)
      .send(metrics);
  }
}

@Module({
  controllers: [MetricsController],
})
export class MetricsModule {}
