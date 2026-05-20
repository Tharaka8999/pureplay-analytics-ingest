import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import Redis from 'ioredis';
import { validate, type Env } from './config/env.schema';
import { KyselyModule } from './shared/kysely/kysely.module';
import { RedisModule, REDIS } from './shared/redis/redis.module';
import { LoggerModule } from './shared/pino/logger.module';
import { MetricsModule } from './shared/metrics/metrics.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ShotsModule } from './shots/shots.module';
import { StatsModule } from './stats/stats.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { GlobalExceptionFilter } from './shared/global-exception.filter';
import { RequestIdInterceptor } from './shared/request-id.interceptor';
import { WebhookAuthGuard } from './shared/auth/webhook-auth.guard';
import { InternalApiGuard } from './shared/auth/internal-api.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ validate, isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>) => ({
        connection: new Redis(config.get('REDIS_URL', { infer: true })!, {
          maxRetriesPerRequest: null,
        }),
      }),
    }),
    LoggerModule,
    RedisModule,
    KyselyModule,
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [REDIS, ConfigService],
      useFactory: (redis: Redis, config: ConfigService<Env>) => ({
        throttlers: [
          { name: 'default', ttl: 60_000, limit: 1000 },  // catch-all
          { name: 'webhook', ttl: 1_000,  limit: 200  },  // 200 req/s for ingest
          { name: 'query',   ttl: 1_000,  limit: 50   },  // 50 req/s for reads
          { name: 'write',   ttl: 1_000,  limit: 100  },  // 100 req/s for mutations
        ],
        storage: new ThrottlerStorageRedisService(redis),
        // Set THROTTLE_ENABLED=false in .env to bypass all throttlers during k6 load tests.
        // Never set false in production.
        skipIf: () => !(config.get('THROTTLE_ENABLED', { infer: true }) ?? true),
      }),
    }),
    HealthModule,
    MetricsModule,
    WebhooksModule,
    ShotsModule,
    StatsModule,
    IdentityModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    // WebhookAuthGuard is applied per-controller via @UseGuards; registered here for DI.
    WebhookAuthGuard,
    // InternalApiGuard protects query/stats/identity/metrics endpoints.
    InternalApiGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
