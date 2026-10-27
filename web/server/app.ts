import { Hono } from "hono";
import { sql } from "kysely";
import { db } from "./platform/db.ts";
import { createRouter, handleError } from "./platform/http.ts";
import { SITE_NAME } from "./platform/site.ts";

const api = createRouter();

api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: SITE_NAME, version: "1" } });

api.all("*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));

export const app = new Hono()
  .get("/healthz", async (c) => {
    await sql`select 1`.execute(db);
    return c.text("ok");
  })
  .route("/api/v1", api)
  .onError(handleError);
