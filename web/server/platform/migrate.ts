import { readdir, readFile } from "node:fs/promises";
import { sql } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import { db } from "./db.ts";

// Relative to the working directory, because this file is bundled into build/ in production.
const dir = "db/migrations";

export async function migrate() {
  const migrations: Record<string, Migration> = {};
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".sql")) continue;
    const text = await readFile(`${dir}/${file}`, "utf8");
    migrations[file] = {
      async up(trx) {
        await sql.raw(text).execute(trx);
      },
    };
  }
  // Kysely holds a PostgreSQL advisory lock and runs everything in one transaction.
  const { error } = await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  }).migrateToLatest();
  if (error) throw new Error("Migration failed", { cause: error });
}
