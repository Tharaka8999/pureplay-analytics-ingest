import { Injectable, Inject, Logger } from '@nestjs/common';
import { type Kysely } from 'kysely';
import type { Database } from '../shared/kysely/types';
import { KYSELY } from '../shared/kysely/kysely.module';
import { VALID_VENDORS, type Vendor } from '../shared/domain/shot';
import { IdentityNotFoundError } from '../shared/errors/domain-errors';
import { AuditLogService } from '../shared/audit/audit-log.service';
import Redis from 'ioredis';
import { REDIS } from '../shared/redis/redis.module';

export interface VendorIdentity {
  id: number;
  vendor: Vendor;
  vendor_user_id: string;
  canonical_user_id: string;
  created_at: string;
  updated_at: string;
}

// Cache resolved canonical user IDs for 60 seconds to reduce DB load on the hot
// ingestion path (resolveCanonicalUserId is called on every processed shot).
const IDENTITY_CACHE_TTL_S = 60;

// Short TTL for the identity list cache — invalidated immediately on link/unlink.
// Bounds eventual-consistency window if a DEL races with a concurrent list read.
const IDENTITY_LIST_CACHE_TTL_S = 30;

function identityCacheKey(vendor: string, vendorUserId: string): string {
  return `identity:${vendor}:${vendorUserId}`;
}

function identityListCacheKey(canonicalUserId: string): string {
  return `identity-list:${canonicalUserId}`;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Resolve canonical_user_id for a (vendor, vendor_user_id) pair.
   * Result is cached in Redis for IDENTITY_CACHE_TTL_S seconds to reduce DB load.
   * Returns null if no mapping exists — callers store the shot with null canonical_user_id.
   */
  async resolveCanonicalUserId(vendor: string, vendorUserId: string): Promise<string | null> {
    if (!VALID_VENDORS.includes(vendor as Vendor)) return null;

    const cacheKey = identityCacheKey(vendor, vendorUserId);

    // Cache hit
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) {
      return cached === '' ? null : cached;
    }

    // Cache miss — query DB
    const row = await this.db
      .selectFrom('user_identities')
      .select('canonical_user_id')
      .where('vendor', '=', vendor as Vendor)
      .where('vendor_user_id', '=', vendorUserId)
      .executeTakeFirst();

    const result = row?.canonical_user_id ?? null;

    // Cache: store '' for null so we distinguish "cached null" from "not cached"
    await this.redis.set(cacheKey, result ?? '', 'EX', IDENTITY_CACHE_TTL_S);

    return result;
  }

  /**
   * Link a vendor user to a canonical user.
   *
   * The critical path (upsert + audit) runs in a short transaction.  RETURNING *
   * on the upsert eliminates the separate SELECT that was previously step 3,
   * reducing the transaction from 3 DB round-trips to 2.
   *
   * The historical backfill — which UPDATEs potentially many shots rows — runs
   * AFTER the transaction commits so it does not hold the user_identities row
   * lock across a potentially slow scan.  Any shot processed AFTER the commit
   * will have its canonical_user_id resolved at processing time via
   * resolveCanonicalUserId(); the backfill only repairs pre-existing shots.
   */
  async linkIdentity(
    vendor: Vendor,
    vendorUserId: string,
    canonicalUserId: string,
    actor = 'internal-api',
  ): Promise<VendorIdentity> {
    // ── Short transaction: upsert (with RETURNING) + audit ──────────────────
    const result = await this.db.transaction().execute(async (trx) => {
      // 1. Upsert + return in one statement — RETURNING * eliminates step 3 SELECT
      const row = await trx
        .insertInto('user_identities')
        .values({ vendor, vendor_user_id: vendorUserId, canonical_user_id: canonicalUserId })
        .onConflict((oc) =>
          oc.columns(['vendor', 'vendor_user_id']).doUpdateSet({
            canonical_user_id: canonicalUserId,
            updated_at: new Date().toISOString(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Audit log — inside TX for atomicity with the mapping upsert
      await this.auditLog.record(
        {
          action: 'IDENTITY_LINK',
          actor,
          canonical_user_id: canonicalUserId,
          vendor,
          vendor_user_id: vendorUserId,
        },
        trx,
      );

      return row;
    });

    // Invalidate the per-vendor resolve cache and the list cache so both
    // resolveCanonicalUserId and listByCanonicalUser return fresh data immediately.
    await this.redis.del(
      identityCacheKey(vendor, vendorUserId),
      identityListCacheKey(canonicalUserId),
    );

    // ── Backfill — outside transaction, fire-and-forget ────────────────────
    // UPDATE shots WHERE canonical_user_id IS NULL can scan many rows and is
    // slow under contention.  Running it after the transaction commits prevents
    // it from blocking other identity-link or identity-list operations.
    void this.db
      .updateTable('shots')
      .set({ canonical_user_id: canonicalUserId })
      .where('vendor', '=', vendor)
      .where('vendor_user_id', '=', vendorUserId)
      .where('canonical_user_id', 'is', null)
      .execute()
      .catch((err: unknown) => {
        // Log but do not surface — the identity link itself succeeded.
        // A subsequent linkIdentity call will re-attempt the backfill.
        this.logger.error({ err, vendor, vendorUserId, canonicalUserId }, 'identity backfill failed');
      });

    return result as VendorIdentity;
  }

  async listByCanonicalUser(canonicalUserId: string, actor = 'internal-api'): Promise<VendorIdentity[]> {
    const listKey = identityListCacheKey(canonicalUserId);

    // Cache hit — skip DB round-trip entirely
    const cached = await this.redis.get(listKey);
    if (cached !== null) {
      const rows = JSON.parse(cached) as VendorIdentity[];
      void this.auditLog.record({
        action: 'IDENTITY_LIST',
        actor,
        canonical_user_id: canonicalUserId,
        metadata: { result_count: rows.length },
      });
      return rows;
    }

    const rows = await this.db
      .selectFrom('user_identities')
      .selectAll()
      .where('canonical_user_id', '=', canonicalUserId)
      .orderBy('created_at', 'asc')
      .execute();

    // Cache the list; invalidated immediately on link/unlink so stale reads are bounded
    // to IDENTITY_LIST_CACHE_TTL_S seconds only if a DEL races with this write.
    void this.redis
      .set(listKey, JSON.stringify(rows), 'EX', IDENTITY_LIST_CACHE_TTL_S)
      .catch((err: unknown) => {
        this.logger.warn({ err, canonicalUserId }, 'identity list cache write failed');
      });

    // Fire-and-forget audit write — a read does not need to block on its own audit entry.
    // SOC2 CC6 / ISO A.8.15 requires capturing the access; timing within a few seconds
    // is acceptable and prevents a slow INSERT from adding latency to every GET response.
    void this.auditLog.record({
      action: 'IDENTITY_LIST',
      actor,
      canonical_user_id: canonicalUserId,
      metadata: { result_count: rows.length },
    });

    return rows as VendorIdentity[];
  }

  /**
   * Unlink a vendor identity.
   * Audit entry and delete run in the same transaction.
   * Existing shots retain their canonical_user_id — the audit trail is immutable.
   */
  async unlinkIdentity(
    vendor: Vendor,
    vendorUserId: string,
    canonicalUserId: string,
    actor = 'internal-api',
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const deleteResult = await trx
        .deleteFrom('user_identities')
        .where('vendor', '=', vendor)
        .where('vendor_user_id', '=', vendorUserId)
        .where('canonical_user_id', '=', canonicalUserId)
        .executeTakeFirst();

      if (!deleteResult || deleteResult.numDeletedRows === BigInt(0)) {
        throw new IdentityNotFoundError(vendor, vendorUserId, canonicalUserId);
      }

      await this.auditLog.record(
        {
          action: 'IDENTITY_UNLINK',
          actor,
          canonical_user_id: canonicalUserId,
          vendor,
          vendor_user_id: vendorUserId,
        },
        trx,
      );
    });

    // Evict per-vendor resolve cache and list cache
    await this.redis.del(
      identityCacheKey(vendor, vendorUserId),
      identityListCacheKey(canonicalUserId),
    );
  }
}
