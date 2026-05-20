import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, types } from "pg";
import type { Database } from "./types";
import type { Env } from "../../config/env.schema";

export const KYSELY = Symbol("KYSELY");

// Return timestamps as ISO-8601 strings rather than Date objects.
// Keeps the entire codebase working with string timestamps consistently.
types.setTypeParser(types.builtins.TIMESTAMPTZ, (val: string) =>
  val ? new Date(val).toISOString() : null,
);
types.setTypeParser(types.builtins.TIMESTAMP, (val: string) =>
  val ? new Date(val).toISOString() : null,
);
// JSONB is returned as a parsed JS object by default — no override needed.

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>): Promise<Kysely<Database>> => {
        const databaseUrl = config.get("DATABASE_URL", { infer: true })!;
        const pool = new Pool({
          connectionString: databaseUrl,
          max: config.get("DB_POOL_MAX", { infer: true }) ?? 20,
          // Keep a minimum of 5 warm connections to avoid cold-start latency on burst traffic.
          min: 5,
          idleTimeoutMillis: 30_000,
          // Hard limit: if a connection cannot be acquired within 5 s, fail fast.
          connectionTimeoutMillis: 5_000,
          // [PROD] Per-query safety net: prevents runaway stats/shots queries from
          // blocking the pool indefinitely. 30 s covers P99 of any expected query.
          // Do NOT lower below 10 s — BullMQ processor queries can legitimately
          // run for several seconds on large datasets.
          options: `--statement_timeout=30000 --idle_in_transaction_session_timeout=10000`,
        });
        return Promise.resolve(
          new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
        );
      },
    },
  ],
  exports: [KYSELY],
})
export class KyselyModule {}
