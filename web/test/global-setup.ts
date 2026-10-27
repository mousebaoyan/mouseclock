import type { TestProject } from "vitest/node";
import { z } from "zod";
import { adminQuery, databaseUrl } from "./database.ts";

declare module "vitest" {
  export interface ProvidedContext {
    template: string;
  }
}

// Named after the database in DATABASE_URL, so test runs in worktrees with databases of their own
// leave each other's alone. test/setup.ts copies it for each test file.
const template = `${new URL(z.url().parse(process.env.DATABASE_URL)).pathname.slice(1)}_test`;

// The template and its copies, <template>_<12 hex digits>, left by this run or one that was killed.
async function dropTestDatabases() {
  for (const { datname } of await adminQuery("SELECT datname FROM pg_database")) {
    const suffix = datname.slice(template.length);
    if (datname.startsWith(template) && (suffix === "" || /^_[0-9a-f]{12}$/.test(suffix))) {
      await adminQuery(`DROP DATABASE "${datname}" WITH (FORCE)`);
    }
  }
}

// Migrate a template once.
export async function setup(project: TestProject) {
  await dropTestDatabases();
  await adminQuery(`CREATE DATABASE ${template}`);
  process.env.DATABASE_URL = databaseUrl(template);
  const { migrate } = await import("../server/platform/migrate.ts");
  const { db } = await import("../server/platform/db.ts");
  await migrate();
  await db.destroy();
  project.provide("template", template);
}

export const teardown = dropTestDatabases;
