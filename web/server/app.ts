import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { sql } from "kysely";
import { accountsRoutes, authenticate, autoLogin, loginRoutes } from "./modules/accounts/routes.ts";
import { ingestRoutes } from "./modules/ingest/routes.ts";
import { crawlRoutes } from "./modules/ingest/crawl-routes.ts";
import { sourcesRoutes } from "./modules/sources/routes.ts";
import { db } from "./platform/db.ts";
import { env } from "./platform/env.ts";
import { bearerToken, createRouter, handleError, type AppEnv } from "./platform/http.ts";
import { SITE_NAME } from "./platform/site.ts";

const api = createRouter()
  .route("/", accountsRoutes)
  .route("/", ingestRoutes)
  .route("/", sourcesRoutes)
  .route("/", crawlRoutes);

export type ApiType = typeof api;

api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: SITE_NAME, version: "1" } });

api.all("*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));

const checkOrigin = csrf({ origin: env.PUBLIC_URL });

// Mounted into the outer server, so the middleware here also runs for page requests.
export const app = new Hono<AppEnv>()
  .get("/healthz", async (c) => {
    await sql`select 1`.execute(db);
    return c.text("ok");
  })
  // A cross-site page can make the browser send our cookie, but not a bearer token.
  .use((c, next) => (bearerToken(c) ? next() : checkOrigin(c, next)))
  .use(authenticate, autoLogin)
  .route("/", loginRoutes)
  .route("/api/v1", api)
  .onError(handleError);
