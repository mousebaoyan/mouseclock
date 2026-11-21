import { Kysely, PostgresDialect, type SelectQueryBuilder } from "kysely";
import { DatabaseError, Pool, types } from "pg";
import type { DB } from "../../db/types.ts";
import { env } from "./env.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";

// Bigint ids and counts stay far below 2^53, so int8 is safe as a JS number.
types.setTypeParser(types.builtins.INT8, Number);
// Dates are calendar days in Beijing; a JS Date would shift them by the server's time zone.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
// Idle connections break when PostgreSQL restarts. pg drops them from the pool,
// but crashes the process if nobody listens for the error.
pool.on("error", (error) => log("error", "Idle database connection failed", { error }));

export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

type Conflict = [status: AppError["status"], code: string, message: string];

// A write turned down by one of the constraints in `conflicts`, as the error that tells the person
// what was wrong. Any other error stays as it was: a constraint a request can't break, such as the
// one on who did it, is a bug.
export function explainConflict(error: unknown, conflicts: Partial<Record<string, Conflict>>) {
  const conflict =
    error instanceof DatabaseError && error.constraint !== undefined
      ? conflicts[error.constraint]
      : undefined;
  return conflict ? new AppError(...conflict, error) : error;
}

// A page of a list (api.md §1), and how many rows the whole list has.
export async function pageOf<TB extends keyof DB, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  { page, per_page }: { page: number; per_page: number },
) {
  const [items, { total }] = await Promise.all([
    query
      .limit(per_page)
      .offset((page - 1) * per_page)
      .execute(),
    query
      .clearSelect()
      .clearOrderBy()
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .executeTakeFirstOrThrow(),
  ]);
  return { items, total, page, per_page };
}
