import { Injectable, Inject } from "@nestjs/common";
import { type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely/types";
import { KYSELY } from "../kysely/kysely.module";

export type AuditAction = "IDENTITY_LINK" | "IDENTITY_UNLINK" | "IDENTITY_LIST";

export interface AuditEntry {
  action: AuditAction;
  actor: string;
  canonical_user_id?: string;
  vendor?: string;
  vendor_user_id?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /**
   * Write an audit entry.
   * If a Kysely transaction is provided, the write participates in that transaction
   * (used for atomic link/unlink + audit in a single DB round-trip).
   */
  async record(entry: AuditEntry, trx?: Transaction<Database>): Promise<void> {
    const db = (trx ?? this.db) as Kysely<Database>;
    await db
      .insertInto("audit_log")
      .values({
        action: entry.action,
        actor: entry.actor,
        canonical_user_id: entry.canonical_user_id ?? null,
        vendor: entry.vendor ?? null,
        vendor_user_id: entry.vendor_user_id ?? null,
        metadata: entry.metadata ?? null,
      })
      .execute();
  }
}
