# Stats Functions

**File:** `src/stats/stats.service.ts`

`StatsService` computes per-club shot statistics for a user over a time window. Aggregation is done in TypeScript (not SQL) to avoid PostgreSQL-specific functions (`PERCENTILE_CONT`) and to keep the query engine portable.

---

## `getStats(userId, query)`

```typescript
async getStats(userId: string, query: StatsQuery): Promise<StatsResponse>
```

Entry point for canonical user lookup. Delegates to `executeStatsQuery` with `{ canonical_user_id: userId }`.

---

## `getStatsByVendorUser(vendor, vendorUserId, query)`

```typescript
async getStatsByVendorUser(vendor: string, vendorUserId: string, query: StatsQuery): Promise<StatsResponse>
```

Entry point for vendor user lookup. Validates `vendor` is in `VALID_VENDORS` (throws `UnknownVendorError` → 400 if not), then delegates to `executeStatsQuery`.

---

## `executeStatsQuery(filter, userLabel, query)` (private)

### Query construction

```sql
SELECT club_code, vendor, ball_speed_mps, launch_angle_deg, carry_m, lateral_m, spin_rpm
FROM shots
WHERE canonical_user_id = ?          -- or vendor + vendor_user_id
  AND captured_at_utc >= ?           -- since (default: 30 days ago)
  AND captured_at_utc <= ?           -- until (default: now)
  AND duplicate_of IS NULL           -- exclude near-duplicates
  AND club_code != 'PT'             -- exclude putters from distance stats
  [AND club_code = ?]               -- optional club filter
ORDER BY captured_at_utc DESC
LIMIT 10000                         -- safety cap
```

**Safety cap:** `MAX_STATS_ROWS = 10_000`. Users with more shots in the window receive stats computed over the 10,000 most-recent shots. This prevents runaway in-memory aggregation on large datasets.

### Grouping

Rows are grouped by `club_code` in a `Map<string, rows[]>` in Node.js.

### Per-club aggregation

For each club group, the service computes:

| Metric | Method |
|---|---|
| `carry_m.mean` | `sum / n` |
| `carry_m.stdev` | Population stddev (`sqrt(sum(x-mean)^2 / n)`) |
| `carry_m.p50` | `percentile(sorted, 50)` — null if `n < 10` |
| `carry_m.p90` | `percentile(sorted, 90)` — null if `n < 10` |
| `lateral_m.*` | Same as carry |
| `ball_speed_mps.mean / stdev` | No percentiles — speed distribution is less actionable |
| `launch_angle_deg.mean / stdev` | No percentiles |
| `spin_rpm.*` | Computed only over shots where `spin_rpm IS NOT NULL`; `vendors_excluded` lists vendors with no spin data |
| `dispersion.lateral_sigma_m` | Same as `lateral_m.stdev` |
| `dispersion.carry_sigma_m` | Same as `carry_m.stdev` |

### Helper functions

#### `percentile(sorted, p)`

```typescript
function percentile(sorted: number[], p: number): number
```

Linear interpolation between adjacent values:
```
idx = (p / 100) * (n - 1)
lower = floor(idx)
upper = ceil(idx)
result = sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower)
```

Returns `0` for empty arrays. Note `noUncheckedIndexedAccess` is enabled — all array accesses use non-null assertion (`!`) which is safe because `lower` and `upper` are bounded by `n`.

#### `stddev(values)`

```typescript
function stddev(values: number[]): number
```

Population standard deviation. Returns `0` for empty arrays.

#### `parseWindowDate(value, fieldName)`

```typescript
function parseWindowDate(value: string, fieldName: 'since' | 'until'): string
```

Parses and validates a date string. Throws `InvalidDateError` (→ 400) if `new Date(value).getTime()` is NaN. Returns an ISO-8601 string. Prevents non-date strings from reaching Kysely.

---

## StatsQuery interface

```typescript
export interface StatsQuery {
  since?: string;   // ISO-8601 date string
  until?: string;   // ISO-8601 date string
  club?: string;    // club code (validated against VALID_CLUB_CODES)
}
```

---

## Response shape

```typescript
{
  user_id: string;
  window: { since: string; until: string };
  club: string | null;
  totals: { shot_count: number };
  by_club: Array<{
    club_code: string;
    sample_size: number;
    carry_m: { mean: number; stdev: number; p50: number | null; p90: number | null };
    lateral_m: { mean: number; stdev: number; p50: number | null; p90: number | null };
    ball_speed_mps: { mean: number; stdev: number };
    launch_angle_deg: { mean: number; stdev: number };
    spin_rpm: { mean: number | null; stdev: number | null; sample_size: number; vendors_excluded: string[] };
    dispersion: { lateral_sigma_m: number; carry_sigma_m: number };
    low_sample_size: boolean;   // true when sample_size < 10
  }>;
}
```

---

## Design notes

**Why TypeScript aggregation instead of SQL?**
- `PERCENTILE_CONT` is PostgreSQL-specific and would break SQLite-based test environments.
- Keeping aggregation in TypeScript allows adding new metrics without schema changes.
- The 10,000-row safety cap bounds memory usage.

**`low_sample_size` flag**
When fewer than 10 shots exist for a club, percentiles are statistically unreliable. The flag lets the frontend display a "limited data" warning instead of misleadingly precise p50/p90 numbers.
