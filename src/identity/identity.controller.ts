import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBody, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { IdentityService } from './identity.service';
import { VALID_VENDORS, type Vendor } from '../shared/domain/shot';
import { ZodValidationPipe } from '../shared/zod-validation.pipe';
import { InternalApiGuard } from '../shared/auth/internal-api.guard';
import { UnknownVendorError } from '../shared/errors/domain-errors';
import { IdempotencyInterceptor } from '../shared/idempotency/idempotency.interceptor';

const LinkBodySchema = z.object({
  vendor: z.enum(['trackpro', 'swingmetric', 'proswing']),
  vendor_user_id: z.string().min(1).max(255),
});

type LinkBody = z.infer<typeof LinkBodySchema>;

@ApiTags('identity')
@ApiBearerAuth('internal_api_key')
@Controller('users')
@UseGuards(InternalApiGuard)
// POST/DELETE: only the 'write' throttler applies.
// Note: method-level @SkipThrottle REPLACES (not merges with) this class-level one,
// so the GET method must repeat the full skip list for its own throttler isolation.
@SkipThrottle({ default: true, webhook: true, query: true })
@Throttle({ write: { ttl: 1_000, limit: 100 } })
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Post(':canonical_user_id/identities')
  @HttpCode(HttpStatus.CREATED)
  // Idempotency-Key caching: replays the same 201 + body if the key is seen twice
  // within 24h. Prevents double-linking on network retries.
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Link a vendor user to a canonical user',
    description:
      'Creates or updates a (vendor, vendor_user_id) → canonical_user_id mapping. ' +
      'All existing shots for that vendor+user that have no canonical_user_id are backfilled immediately. ' +
      'Idempotent — re-POSTing the same mapping is a no-op. Supply an `Idempotency-Key` header ' +
      'to guarantee exactly-once processing on network retries.',
  })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID; safe to retry with same key for 24h', required: false })
  @ApiParam({ name: 'canonical_user_id', description: 'Canonical user ULID (26 chars)' })
  @ApiBody({
    schema: {
      example: { vendor: 'trackpro', vendor_user_id: 'demo-player-1' },
    },
  })
  @ApiResponse({ status: 201, description: 'Identity linked; existing shots backfilled', headers: { Location: { description: '/v1/users/:canonical_user_id/identities', schema: { type: 'string' } } } })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async linkIdentity(
    @Param('canonical_user_id') canonicalUserId: string,
    @Body(new ZodValidationPipe(LinkBodySchema)) body: LinkBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.identityService.linkIdentity(body.vendor, body.vendor_user_id, canonicalUserId);
    // RFC 9110 §10.2.2: 201 responses SHOULD include a Location header pointing
    // to the created/updated resource.
    void reply.header('Location', `/v1/users/${canonicalUserId}/identities`);
    return result;
  }

  @Get(':canonical_user_id/identities')
  // Method-level decorators replace the class-level ones — specify the full skip list.
  // GET: only the 'query' throttler (50/s); drop write/webhook/default.
  @SkipThrottle({ default: true, webhook: true, write: true })
  @Throttle({ query: { ttl: 1_000, limit: 50 } })
  @ApiOperation({
    summary: 'List vendor identities for a canonical user',
    description: 'Returns all (vendor, vendor_user_id) pairs linked to this canonical user.',
  })
  @ApiParam({ name: 'canonical_user_id', description: 'Canonical user ULID' })
  @ApiResponse({ status: 200, description: 'Linked vendor identities' })
  listIdentities(@Param('canonical_user_id') canonicalUserId: string) {
    return this.identityService.listByCanonicalUser(canonicalUserId);
  }

  @Delete(':canonical_user_id/identities/:vendor/:vendor_user_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Unlink a vendor identity from a canonical user',
    description:
      'Removes the mapping. Existing shots retain their canonical_user_id — the audit trail is preserved.',
  })
  @ApiParam({ name: 'canonical_user_id', description: 'Canonical user ULID' })
  @ApiParam({ name: 'vendor', description: 'trackpro | swingmetric | proswing' })
  @ApiParam({ name: 'vendor_user_id', description: 'Vendor-scoped user identifier' })
  @ApiResponse({ status: 204, description: 'Identity unlinked' })
  @ApiResponse({ status: 400, description: 'Unknown vendor' })
  @ApiResponse({ status: 404, description: 'Mapping not found' })
  async unlinkIdentity(
    @Param('canonical_user_id') canonicalUserId: string,
    @Param('vendor') vendor: string,
    @Param('vendor_user_id') vendorUserId: string,
  ) {
    if (!VALID_VENDORS.includes(vendor as Vendor)) {
      throw new UnknownVendorError(vendor, VALID_VENDORS);
    }
    await this.identityService.unlinkIdentity(vendor as Vendor, vendorUserId, canonicalUserId);
  }
}
