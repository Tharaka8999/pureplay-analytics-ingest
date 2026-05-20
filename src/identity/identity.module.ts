import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { AuditLogService } from '../shared/audit/audit-log.service';

@Module({
  controllers: [IdentityController],
  // AuditLogService is provided here (not exported) — it is only consumed by IdentityService.
  // KYSELY and REDIS are injected from their global modules (KyselyModule, RedisModule).
  providers: [IdentityService, AuditLogService],
  exports: [IdentityService],
})
export class IdentityModule {}
