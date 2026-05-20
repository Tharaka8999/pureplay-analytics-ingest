import { Module } from '@nestjs/common';
import { ShotsService } from './shots.service';
import { ShotsController } from './shots.controller';

@Module({
  providers: [ShotsService],
  controllers: [ShotsController],
})
export class ShotsModule {}
