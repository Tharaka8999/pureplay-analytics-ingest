import { Injectable, Inject } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { Database } from '../shared/kysely/types';
import { KYSELY } from '../shared/kysely/kysely.module';
import { VALID_CLUB_CODES, type ClubCode } from '../shared/domain/club-code';
import { VALID_VENDORS, type Vendor } from '../shared/domain/shot';
import {
  InvalidCursorError,
  InvalidDateError,
  UnknownVendorError,
  UnknownClubCodeError,
} from '../shared/errors/domain-errors';

export interface ShotsQuery {
  since?: string;
  until?: string;
  club?: string;
  cursor?: string;
  limit?: number;
  include_near_duplicates?: boolean;
}

export interface ShotsPage {
  data: unknown[];
  paging: {
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  };
  meta: {
    since: string | null;
    until: string | null;
    club: string | null;
    include_near_duplicates: boolean;
  };
}

const DEFAULT_WINDOW_DAYS = 30;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function encodeCursor(captured_at_utc: string, canonical_shot_id: string): string {
  return Buffer.from(JSON.stringify({ captured_at_utc, canonical_shot_id })).toString('base64url');
}

// [SEC] Try/catch guards against malformed base64url or JSON — previously threw 500.
function decodeCursor(cursor: string): { captured_at_utc: string; canonical_shot_id: string } {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, string>;
    const captured_at_utc = decoded['captured_at_utc'];
    const canonical_shot_id = decoded['canonical_shot_id'];
    if (!captured_at_utc || !canonical_shot_id) throw new InvalidCursorError();
    return { captured_at_utc, canonical_shot_id };
  } catch (err) {
    if (err instanceof InvalidCursorError) throw err;
    throw new InvalidCursorError();
  }
}

/**
 * Parse and validate a date window boundary.
 * Returns an ISO-8601 string, or throws BadRequestException for invalid input.
 * [SEC] Prevents non-date strings from reaching Kysely and causing silent type coercion.
 */
function parseWindowDate(value: string, fieldName: 'since' | 'until'): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new InvalidDateError(fieldName, value);
  return d.toISOString();
}

@Injectable()
export class ShotsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async listByCanonicalUser(userId: string, query: ShotsQuery): Promise<ShotsPage> {
    return this.executeQuery({ canonical_user_id: userId }, query);
  }

  async listByVendorUser(
    vendor: string,
    vendorUserId: string,
    query: ShotsQuery,
  ): Promise<ShotsPage> {
    if (!VALID_VENDORS.includes(vendor as Vendor)) {
      throw new UnknownVendorError(vendor, VALID_VENDORS);
    }
    return this.executeQuery({ vendor: vendor as Vendor, vendor_user_id: vendorUserId }, query);
  }

  private async executeQuery(
    filter: { canonical_user_id?: string; vendor?: Vendor; vendor_user_id?: string },
    query: ShotsQuery,
  ): Promise<ShotsPage> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const includeNearDuplicates = query.include_near_duplicates ?? false;

    const now = new Date().toISOString();
    const since = query.since
      ? parseWindowDate(query.since, 'since')
      : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400 * 1000).toISOString();
    const until = query.until ? parseWindowDate(query.until, 'until') : now;

    if (query.club && !(VALID_CLUB_CODES as readonly string[]).includes(query.club)) {
      throw new UnknownClubCodeError(query.club, VALID_CLUB_CODES);
    }
    // query.club is validated above — safe to cast to ClubCode for Kysely
    const club = query.club as ClubCode | undefined;

    let qb = this.db
      .selectFrom('shots')
      .selectAll()
      .where('captured_at_utc', '>=', since)
      .where('captured_at_utc', '<=', until);

    if (filter.canonical_user_id) {
      qb = qb.where('canonical_user_id', '=', filter.canonical_user_id);
    }
    if (filter.vendor) {
      qb = qb.where('vendor', '=', filter.vendor);
    }
    if (filter.vendor_user_id) {
      qb = qb.where('vendor_user_id', '=', filter.vendor_user_id);
    }
    if (club) {
      qb = qb.where('club_code', '=', club);
    }
    if (!includeNearDuplicates) {
      qb = qb.where('duplicate_of', 'is', null);
    }

    if (query.cursor) {
      const { captured_at_utc, canonical_shot_id } = decodeCursor(query.cursor);
      qb = qb.where(sql`(captured_at_utc, canonical_shot_id) < (${captured_at_utc}, ${canonical_shot_id})` as never);
    }

    qb = qb.orderBy('captured_at_utc', 'desc').orderBy('canonical_shot_id', 'desc').limit(limit + 1);

    const rows = await qb.execute();
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1]!;
      nextCursor = encodeCursor(last.captured_at_utc, last.canonical_shot_id);
    }

    // Strip raw_payload from response
    const safeData = data.map(({ raw_payload: _rp, ...rest }) => rest);

    return {
      data: safeData,
      paging: { next_cursor: nextCursor, has_more: hasMore, limit },
      meta: {
        since,
        until,
        club: query.club ?? null,
        include_near_duplicates: includeNearDuplicates,
      },
    };
  }
}
