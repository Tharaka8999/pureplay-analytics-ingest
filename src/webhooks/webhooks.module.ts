import { Module } from '@nestjs/common';
import { TrackproController } from './trackpro/trackpro.controller';
import { SwingmetricController } from './swingmetric/swingmetric.controller';
import { ProswingController } from './proswing/proswing.controller';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [IngestionModule],
  controllers: [TrackproController, SwingmetricController, ProswingController],
})
export class WebhooksModule {}
