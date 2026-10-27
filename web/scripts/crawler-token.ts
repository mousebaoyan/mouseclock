import { createCrawlerToken } from "../server/modules/ingest/service.ts";
import { db } from "../server/platform/db.ts";

// For running a crawler against a local site; on the server the owner makes tokens in the
// settings (design §6.2). The token is shown once: only its SHA-256 is kept.
const name = process.argv[2];
if (!name) throw new Error("Usage: pnpm crawler-token <name>");
console.log(await createCrawlerToken(name));
await db.destroy();
