import { writeFile } from "node:fs/promises";
import { crawlerApiDocument } from "../server/modules/ingest/routes.ts";
import { db } from "../server/platform/db.ts";

await writeFile("openapi/crawler.json", crawlerApiDocument());
await db.destroy();
