import { writeFile } from "node:fs/promises";
import { ingestRoutes } from "../server/modules/ingest/routes.ts";
import { db } from "../server/platform/db.ts";

// The crawler's half of the API, from which the crawler generates its types (api.md §6).
const doc = ingestRoutes.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "鼠钟抓取节点接口", version: "1" },
  servers: [{ url: "/api/v1" }],
});
await writeFile("openapi/crawler.json", `${JSON.stringify(doc, null, 2)}\n`);
await db.destroy();
