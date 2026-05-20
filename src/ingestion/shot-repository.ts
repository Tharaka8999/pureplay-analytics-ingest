import { Injectable, Inject } from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import type {
  Database,
  InsertableIngestionFailure,
} from "../shared/kysely/types";
import { KYSELY } from "../shared/kysely/kysely.module";
import type { NormalisedShot, Vendor } from "../shared/domain/shot";
import { computeContentHash } from "./content-hash";

export interface UpsertResult {
  inserted: boolean;
  canonical_shot_id: string;
}

const NEAR_DEDUPE_WINDOW_SECONDS = 60;

@Injectable()
export class ShotRepository {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Insert the shot and, if it is truly new, write an outbox_events row in the
   * same Kysely transaction. This guarantees that a shot.persisted event is
   * published if and only if the shot row is committed — no phantom events on
   * rollback, no missed events on process crash between the two writes.
   */
  async upsertIfNew(shot: NormalisedShot): Promise<UpsertResult> {
    return this.db.transaction().execute(async (trx) => {
      const result = await trx
        .insertInto("shots")
        .values({
          canonical_shot_id: shot.canonical_shot_id,
          vendor: shot.vendor,
          vendor_shot_id: shot.vendor_shot_id ?? null,
          idempotency_key: shot.idempotency_key,
          vendor_user_id: shot.vendor_user_id,
          canonical_user_id: shot.canonical_user_id ?? null,
          captured_at_utc: shot.captured_at_utc,
          captured_at_tz_offset_min: shot.captured_at_tz_offset_min ?? null,
          received_at_utc: shot.received_at_utc,
          club_code: shot.club_code,
          club_raw: shot.club_raw,
          ball_speed_mps: shot.ball_speed_mps,
          club_head_speed_mps: shot.club_head_speed_mps ?? null,
          launch_angle_deg: shot.launch_angle_deg,
          spin_rpm: shot.spin_rpm ?? null,
          carry_m: shot.carry_m,
          total_m: shot.total_m ?? null,
          lateral_m: shot.lateral_m,
          device_id: shot.device_id ?? null,
          session_id: shot.session_id ?? null,
          content_hash: shot.content_hash,
          raw_payload: shot.raw_payload,
          schema_version: shot.schema_version,
          parser_version: shot.parser_version,
          duplicate_of: shot.duplicate_of ?? null,
        })
        .onConflict((oc) =>
          oc.columns(["vendor", "idempotency_key"]).doNothing(),
        )
        .returning("canonical_shot_id")
        .executeTakeFirst();

      if (result) {
        // [SEC] Store the normalised shot (minus raw_payload which contains full
        // vendor PII) in the outbox so the OutboxPublisher can reconstruct the
        // event without exposing raw vendor data to in-process listeners.
        const { raw_payload: _raw, ...shotWithoutPayload } = shot;
        await trx
          .insertInto("outbox_events")
          .values({
            event_type: "shot.persisted",
            payload: shotWithoutPayload as Record<string, unknown>,
          })
          .execute();

        return { inserted: true, canonical_shot_id: result.canonical_shot_id };
      }

      // Row already existed — fetch the existing canonical_shot_id.
      // Do NOT write an outbox event for deduplicated shots.
      const existing = await trx
        .selectFrom("shots")
        .select("canonical_shot_id")
        .where("vendor", "=", shot.vendor)
        .where("idempotency_key", "=", shot.idempotency_key)
        .executeTakeFirstOrThrow();

      return { inserted: false, canonical_shot_id: existing.canonical_shot_id };
    });
  }

  /**
   * Flag the shot as a near-duplicate if a shot from the same vendor+user exists
   * within ±60 seconds with the same content hash.
   *
   * Also checks the adjacent minute bucket hash to handle shots straddling a
   * minute boundary (e.g. 12:00:59 and 12:01:01 are 2s apart but hash to
   * different minute buckets). Without this, ~16% of boundary-crossing pairs are
   * missed.
   *
   * Returns the origin canonical_shot_id if flagged, null otherwise.
   */
  async checkAndFlagNearDuplicates(
    shot: NormalisedShot,
  ): Promise<string | null> {
    const capturedMs = new Date(shot.captured_at_utc).getTime();
    const windowMs = NEAR_DEDUPE_WINDOW_SECONDS * 1000;
    const lowerBound = new Date(capturedMs - windowMs).toISOString();
    const upperBound = new Date(capturedMs + windowMs).toISOString();

    // Compute the adjacent-minute bucket hash: if this shot is at e.g. 12:01:01
    // its minute bucket is "12:01", but a shot at 12:00:59 hashed to "12:00".
    // Checking both buckets catches that pair.
    const prevMinuteUtc = new Date(capturedMs - 60_000).toISOString();
    const adjacentHash = computeContentHash({
      vendor_user_id: shot.vendor_user_id,
      club_code: shot.club_code,
      captured_at_utc: prevMinuteUtc,
      ball_speed_mps: shot.ball_speed_mps,
      launch_angle_deg: shot.launch_angle_deg,
      carry_m: shot.carry_m,
      lateral_m: shot.lateral_m,
    });

    // Find an earlier shot with the same vendor+user and matching content hash
    // within the ±60s window.  The vendor filter prevents cross-vendor false
    // deduplication when two vendors share the same vendor_user_id string.
    const origin = await this.db
      .selectFrom("shots")
      .select("canonical_shot_id")
      .where("vendor", "=", shot.vendor)
      .where("vendor_user_id", "=", shot.vendor_user_id)
      .where((eb) =>
        eb.or([
          eb("content_hash", "=", shot.content_hash),
          eb("content_hash", "=", adjacentHash),
        ]),
      )
      .where("canonical_shot_id", "!=", shot.canonical_shot_id)
      .where("captured_at_utc", ">=", lowerBound)
      .where("captured_at_utc", "<=", upperBound)
      .orderBy("captured_at_utc", "asc")
      .limit(1)
      .executeTakeFirst();

    if (origin) {
      await this.db
        .updateTable("shots")
        .set({ duplicate_of: origin.canonical_shot_id })
        .where("canonical_shot_id", "=", shot.canonical_shot_id)
        .execute();
      return origin.canonical_shot_id;
    }
    return null;
  }

  /**
   * Update the outbox event payload to include the duplicate_of field.
   * Called after checkAndFlagNearDuplicates sets it on the shots table,
   * so downstream consumers see the correct relationship in the event.
   */
  async updateOutboxEventDuplicateOf(
    canonicalShotId: string,
    duplicateOf: string,
  ): Promise<void> {
    await this.db
      .updateTable("outbox_events")
      .set(
        sql`payload = payload || ${JSON.stringify({ duplicate_of: duplicateOf })}::jsonb` as never,
      )
      .where("event_type", "=", "shot.persisted")
      .where(sql`payload->>'canonical_shot_id' = ${canonicalShotId}` as never)
      .execute();
  }

  async recordIngestionFailure(
    failure: Omit<InsertableIngestionFailure, "id" | "created_at">,
  ): Promise<void> {
    await this.db.insertInto("ingestion_failures").values(failure).execute();
  }

  async findByIdempotencyKey(
    vendor: Vendor,
    idempotencyKey: string,
  ): Promise<{ canonical_shot_id: string } | undefined> {
    return this.db
      .selectFrom("shots")
      .select("canonical_shot_id")
      .where("vendor", "=", vendor)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
  }
}

// Standalone clock-skew predicate — used by the processor before calling upsertIfNew.
// Allows shots up to 24h in the past (retransmission lag) but only 5min in the
// future (NTP drift tolerance — prevents firmware year-bugs from passing through).
export function hasExcessiveClockSkew(
  capturedAtUtc: string,
  receivedAtUtc: string,
  maxPastSkewSeconds = 86400, // 24h past — retransmission lag
  maxFutureSkewSeconds = 300, // 5min future — NTP drift tolerance
): boolean {
  const capturedMs = new Date(capturedAtUtc).getTime();
  const receivedMs = new Date(receivedAtUtc).getTime();
  const deltaMs = capturedMs - receivedMs; // positive = future-dated

  if (deltaMs > maxFutureSkewSeconds * 1000) return true; // too far in future
  if (deltaMs < -(maxPastSkewSeconds * 1000)) return true; // too far in past
  return false;
}
