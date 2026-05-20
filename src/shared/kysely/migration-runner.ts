import { readFileSync } from "fs";
import { join } from "path";
import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

/**
 * Split a SQL file into individual statements.
 *
 * Handles three contexts correctly:
 *  1. Dollar-quoted blocks ($$...$$) — semicolons inside PL/pgSQL DO blocks
 *     are not treated as statement terminators.
 *  2. Single-quoted string literals ('...') — a ';' or '--' inside a string
 *     literal is part of the literal, not a terminator or comment marker.
 *  3. Single-line comments (-- ...) — everything from '--' to end-of-line is
 *     ignored, including any ';' characters the comment may contain.
 */
function splitStatements(content: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;
  let inStringLiteral = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    // Inside a dollar-quoted block: only $$ can close it; nothing else matters.
    if (inDollarQuote) {
      if (ch === "$" && content[i + 1] === "$") {
        inDollarQuote = false;
        current += "$$";
        i++;
      } else {
        current += ch;
      }
      continue;
    }

    // Inside a single-quoted string literal: only closing ' (accounting for '') ends it.
    if (inStringLiteral) {
      current += ch;
      if (ch === "'") {
        if (content[i + 1] === "'") {
          // Escaped quote inside literal — consume the second one too.
          current += "'";
          i++;
        } else {
          inStringLiteral = false;
        }
      }
      continue;
    }

    // Open a dollar-quoted block.
    if (ch === "$" && content[i + 1] === "$") {
      inDollarQuote = true;
      current += "$$";
      i++;
      continue;
    }

    // Open a single-quoted string literal.
    if (ch === "'") {
      inStringLiteral = true;
      current += ch;
      continue;
    }

    // Single-line comment: skip to end of line (do not emit the comment text).
    if (ch === "-" && content[i + 1] === "-") {
      while (i < content.length && content[i] !== "\n") i++;
      // Leave the newline itself to be consumed on the next iteration,
      // keeping line-ending whitespace consistent.
      continue;
    }

    // Statement terminator (outside all quoted contexts).
    if (ch === ";") {
      const stmt = current.trim();
      if (stmt.length > 0) statements.push(stmt);
      current = "";
      continue;
    }

    current += ch;
  }

  const remaining = current.trim();
  if (remaining.length > 0) statements.push(remaining);

  return statements;
}

async function executeSqlFile(
  db: Kysely<Database>,
  filePath: string,
): Promise<void> {
  const content = readFileSync(filePath, "utf-8");
  const statements = splitStatements(content);

  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}

export async function runMigrations(
  db: Kysely<Database>,
  migrationDir?: string,
): Promise<void> {
  const dir = migrationDir ?? join(process.cwd(), "migrations");
  await executeSqlFile(db, join(dir, "001_init.sql"));
  await executeSqlFile(db, join(dir, "002_club_data.sql"));
  await executeSqlFile(db, join(dir, "003_identity_perf.sql"));
}
