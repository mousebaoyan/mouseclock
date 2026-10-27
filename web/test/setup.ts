import { randomBytes } from "node:crypto";
import { inject, vi } from "vitest";
import { adminQuery, databaseUrl } from "./database.ts";

// Each test file gets its own database, so files can run in parallel. The suffix is short enough
// for a worktree's longer database name to stay within Postgres's 63 characters.
const template = inject("template");
const name = `${template}_${randomBytes(6).toString("hex")}`;
await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${template}`);
process.env.DATABASE_URL = databaseUrl(name);

// Imported only now: the config is read once, and must see this file's database.
const { env } = await import("../server/platform/env.ts");
const { fakeMousehole } = await import("./fake-mousehole.ts");
const mousehole = fakeMousehole({
  url: env.MOUSEHOLE_URL,
  clientId: env.MOUSEHOLE_CLIENT_ID,
  clientSecret: env.MOUSEHOLE_CLIENT_SECRET,
  redirectUri: `${env.PUBLIC_URL}/login/callback`,
});

// Tests reach no other site: mousehole is the fake, and anything else fails.
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (!request.url.startsWith(`${env.MOUSEHOLE_URL}/`)) {
    throw new Error(`Tests don't reach other sites: ${request.url}`);
  }
  return mousehole.fetch(request);
});
