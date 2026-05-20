import { Injectable, Inject } from "@nestjs/common";
import { type Kysely } from "kysely";
import type { Database } from "../shared/kysely/types";
import { KYSELY } from "../shared/kysely/kysely.module";
import { VALID_CLUB_CODES, type ClubCode } from "../shared/domain/club-code";
import { VALID_VENDORS, type Vendor } from "../shared/domain/shot";
import {
  InvalidDateError,
  UnknownVendorError,
  UnknownClubCodeError,
} from "../shared/errors/domain-errors";

export interface StatsQuery {
  since?: string;
  until?: string;
  club?: string;
}

interface NumericStats {
  mean: number;
  stdev: number;
  p50: number | null;
  p90: number | null;
}

interface ClubAggregate {
  club_code: string;
  sample_size: number;
  carry_m: NumericStats;
  lateral_m: NumericStats;
  ball_speed_mps: { mean: number; stdev: number };
  launch_angle_deg: { mean: number; stdev: number };
  spin_rpm: {
    mean: number | null;
    stdev: number | null;
    sample_size: number;
    vendors_excluded: string[];
  };
  dispersion: { lateral_sigma_m: number; carry_sigma_m: number };
  low_sample_size: boolean;
}

const LOW_SAMPLE_SIZE_THRESHOLD = 10;
const DEFAULT_WINDOW_DAYS = 30;
// Safety cap: never pull more than 10 000 rows into the Node process for in-memory aggregation.
// Any user with more shots in the window will receive stats computed over the 10 000 most recent.
const MAX_STATS_ROWS = 10_000;

/**
 * Parse and validate a date window boundary.
 * Returns an ISO-8601 string, or throws BadRequestException for invalid input.
 * [SEC] Prevents non-date strings from reaching Kysely and causing silent type coercion.
 */
function parseWindowDate(value: string, fieldName: "since" | "until"): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new InvalidDateError(fieldName, value);
  return d.toISOString();
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (idx - lower);
}

@Injectable()
export class StatsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async getStats(
    userId: string,
    query: StatsQuery,
  ): Promise<{
    user_id: string;
    window: { since: string; until: string };
    club: string | null;
    totals: { shot_count: number; capped: boolean };
    by_club: ClubAggregate[];
  }> {
    return this.executeStatsQuery({ canonical_user_id: userId }, userId, query);
  }

  async getStatsByVendorUser(
    vendor: string,
    vendorUserId: string,
    query: StatsQuery,
  ): Promise<{
    user_id: string;
    window: { since: string; until: string };
    club: string | null;
    totals: { shot_count: number; capped: boolean };
    by_club: ClubAggregate[];
  }> {
    if (!VALID_VENDORS.includes(vendor as Vendor)) {
      throw new UnknownVendorError(vendor, VALID_VENDORS);
    }
    return this.executeStatsQuery(
      { vendor: vendor as Vendor, vendor_user_id: vendorUserId },
      `${vendor}/${vendorUserId}`,
      query,
    );
  }

  private async executeStatsQuery(
    filter: {
      canonical_user_id?: string;
      vendor?: Vendor;
      vendor_user_id?: string;
    },
    userLabel: string,
    query: StatsQuery,
  ): Promise<{
    user_id: string;
    window: { since: string; until: string };
    club: string | null;
    totals: { shot_count: number; capped: boolean };
    by_club: ClubAggregate[];
  }> {
    const now = new Date().toISOString();
    const since = query.since
      ? parseWindowDate(query.since, "since")
      : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400 * 1000).toISOString();
    const until = query.until ? parseWindowDate(query.until, "until") : now;

    if (since >= until) {
      throw new InvalidDateError(
        "since",
        `since (${since}) must be before until (${until})`,
      );
    }

    if (
      query.club &&
      !(VALID_CLUB_CODES as readonly string[]).includes(query.club)
    ) {
      throw new UnknownClubCodeError(query.club, VALID_CLUB_CODES);
    }

    const rows = await this.db
      .selectFrom("shots")
      .select([
        "club_code",
        "vendor",
        "ball_speed_mps",
        "launch_angle_deg",
        "carry_m",
        "lateral_m",
        "spin_rpm",
      ])
      .$if(filter.canonical_user_id !== undefined, (qb) =>
        qb.where("canonical_user_id", "=", filter.canonical_user_id!),
      )
      .$if(filter.vendor !== undefined, (qb) =>
        qb.where("vendor", "=", filter.vendor!),
      )
      .$if(filter.vendor_user_id !== undefined, (qb) =>
        qb.where("vendor_user_id", "=", filter.vendor_user_id!),
      )
      .where("captured_at_utc", ">=", since)
      .where("captured_at_utc", "<=", until)
      .where("duplicate_of", "is", null)
      .where("club_code", "!=", "PT" as ClubCode)
      .$if(query.club !== undefined, (qb) =>
        qb.where("club_code", "=", query.club as ClubCode),
      )
      // [PROD] Safety cap: prevents runaway in-memory aggregation on large datasets.
      // Rows are ordered newest-first so the most recent shots are always included.
      .orderBy("captured_at_utc", "desc")
      .limit(MAX_STATS_ROWS)
      .execute();

    // Group by club_code
    const byClub = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!byClub.has(row.club_code)) byClub.set(row.club_code, []);
      byClub.get(row.club_code)!.push(row);
    }

    const aggregates: ClubAggregate[] = [];

    for (const [clubCode, shots] of byClub.entries()) {
      const n = shots.length;
      const isLowSample = n < LOW_SAMPLE_SIZE_THRESHOLD;

      const carryVals = shots
        .map((s) => Number(s.carry_m))
        .sort((a, b) => a - b);
      const lateralVals = shots
        .map((s) => Number(s.lateral_m))
        .sort((a, b) => a - b);
      const speedVals = shots.map((s) => Number(s.ball_speed_mps));
      const angleVals = shots.map((s) => Number(s.launch_angle_deg));

      const spinShots = shots.filter((s) => s.spin_rpm != null);
      const spinVals = spinShots
        .map((s) => Number(s.spin_rpm))
        .sort((a, b) => a - b);
      const spinVendorsExcluded = [
        ...new Set(
          shots.filter((s) => s.spin_rpm == null).map((s) => s.vendor),
        ),
      ];

      const carryMean = carryVals.reduce((a, b) => a + b, 0) / n;
      const lateralMean = lateralVals.reduce((a, b) => a + b, 0) / n;

      aggregates.push({
        club_code: clubCode,
        sample_size: n,
        carry_m: {
          mean: carryMean,
          stdev: stddev(carryVals),
          p50: isLowSample ? null : percentile(carryVals, 50),
          p90: isLowSample ? null : percentile(carryVals, 90),
        },
        lateral_m: {
          mean: lateralMean,
          stdev: stddev(lateralVals),
          p50: isLowSample ? null : percentile(lateralVals, 50),
          p90: isLowSample ? null : percentile(lateralVals, 90),
        },
        ball_speed_mps: {
          mean: speedVals.reduce((a, b) => a + b, 0) / n,
          stdev: stddev(speedVals),
        },
        launch_angle_deg: {
          mean: angleVals.reduce((a, b) => a + b, 0) / n,
          stdev: stddev(angleVals),
        },
        spin_rpm: {
          mean:
            spinVals.length > 0
              ? spinVals.reduce((a, b) => a + b, 0) / spinVals.length
              : null,
          stdev: spinVals.length > 0 ? stddev(spinVals) : null,
          sample_size: spinVals.length,
          vendors_excluded: spinVendorsExcluded,
        },
        dispersion: {
          lateral_sigma_m: stddev(lateralVals),
          carry_sigma_m: stddev(carryVals),
        },
        low_sample_size: isLowSample,
      });
    }

    return {
      user_id: userLabel,
      window: { since, until },
      club: query.club ?? null,
      totals: {
        shot_count: rows.length,
        // True when the user has more shots in the window than MAX_STATS_ROWS.
        // The frontend should display a "limited data" warning in this case.
        capped: rows.length === MAX_STATS_ROWS,
      },
      by_club: aggregates,
    };
  }
}
