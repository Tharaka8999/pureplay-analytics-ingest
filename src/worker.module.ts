import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { validate, type Env } from './config/env.schema';
import { KyselyModule } from './shared/kysely/kysely.module';
import { RedisModule } from './shared/redis/redis.module';
import { LoggerModule } from './shared/pino/logger.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { OutboxPublisherService } from './ingestion/outbox-publisher.service';

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
    IngestionModule,
  ],
  // OutboxPublisherService is registered here (in the Worker process only) and NOT
  // in IngestionModule. This prevents the API process from also polling the outbox,
  // which would create a race where both processes delete the same rows before the
  // worker's EventEmitter2 listeners can process them.
  providers: [OutboxPublisherService],
})
export class WorkerModule {}
