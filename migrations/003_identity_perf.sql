-- Pureplay Analytics Ingest — identity performance indexes
-- Idempotent (IF NOT EXISTS / IF EXISTS). Safe to run on every startup.

-- ──────────────────────────────────────────────────────────────
-- SHOTS — partial index for identity backfill UPDATE
--
-- The fire-and-forget backfill in IdentityService.linkIdentity executes:
--   UPDATE shots SET canonical_user_id = $3
--   WHERE vendor = $1 AND vendor_user_id = $2 AND canonical_user_id IS NULL
--
-- The existing shots_vendor_vendor_user_id_captured index covers vendor +
-- vendor_user_id but is not partial, so it includes already-linked shots.
-- This partial index is smaller (only unlinked rows) and is a perfect match
-- for the predicate, letting PostgreSQL skip the canonical_user_id IS NULL
-- heap filter entirely.
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS shots_vendor_user_id_unlinked
  ON shots (vendor, vendor_user_id)
  WHERE canonical_user_id IS NULL;

-- ──────────────────────────────────────────────────────────────
-- USER_IDENTITIES — composite covering index for listByCanonicalUser
--
-- IdentityService.listByCanonicalUser executes:
--   SELECT * FROM user_identities
--   WHERE canonical_user_id = $1
--   ORDER BY created_at ASC
--
-- The original single-column index (canonical_user_id) satisfies the WHERE
-- clause but not the ORDER BY, so PostgreSQL adds a sort step.  The composite
-- index (canonical_user_id, created_at ASC) allows an index scan that returns
-- rows in the required order with no separate sort.  Because canonical_user_id
-- is the leading column the composite fully supersedes the single-column index
-- for all equality lookups on canonical_user_id.
-- ──────────────────────────────────────────────────────────────

DROP INDEX CONCURRENTLY IF EXISTS user_identities_canonical_user_id;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_identities_canonical_user_id_created
  ON user_identities (canonical_user_id, created_at ASC);
