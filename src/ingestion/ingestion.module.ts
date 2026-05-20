import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ShotRepository } from './shot-repository';
import { ShotIngestionQueue, SHOT_INGESTION_QUEUE } from './shot-ingestion.queue';
import { ShotIngestionProcessor } from './shot-ingestion.processor';
import { IdentityModule } from '../identity/identity.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: SHOT_INGESTION_QUEUE }),
    IdentityModule,
  ],
  providers: [ShotRepository, ShotIngestionQueue, ShotIngestionProcessor],
  exports: [ShotIngestionQueue, ShotRepository],
})
export class IngestionModule {}
