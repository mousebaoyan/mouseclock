import { Kysely, PostgresDialect } from "kysely";
import { Pool, types } from "pg";
import type { DB } from "../../db/types.ts";
import { env } from "./env.ts";
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
