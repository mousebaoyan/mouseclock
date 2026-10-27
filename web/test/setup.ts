import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { adminQuery, databaseUrl } from "./database.ts";

// Each test file gets its own database, so files can run in parallel. The suffix is short enough
// for a worktree's longer database name to stay within Postgres's 63 characters.
const template = inject("template");
const name = `${template}_${randomBytes(6).toString("hex")}`;
await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${template}`);
process.env.DATABASE_URL = databaseUrl(name);
