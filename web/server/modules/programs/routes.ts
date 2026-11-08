import { createRoute } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { can } from "../../platform/access.ts";
import { createRouter, errorResponse, type AppEnv } from "../../platform/http.ts";
import { ProgramTable, ProgramTableQuery } from "./schemas.ts";
import { listPrograms, tableVersion } from "./service.ts";

// Part of every ETag: a deploy can change what the table's JSON looks like, and a browser must
// not keep the old shape. Restarting only costs each browser one download.
const STARTED = Date.now().toString(36);

// A member's browser keeps the table and asks again with its ETag; while nothing changed, the
// answer is an empty 304 (design §14). Previews change with the clock, as programs close, and
// aren't tagged. The version is taken before the rows: if they change in between, the tag is
// older than the data, and the next request downloads them again rather than keep stale ones.
const unlessUnchanged = createMiddleware<AppEnv>(async (c, next) => {
  if (!can(c.var.viewer, "read")) return next();
  const etag = `"${STARTED}-${await tableVersion()}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return next();
});

export const programsRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/programs",
    middleware: [unlessUnchanged] as const,
    summary: "总表",
    description:
      "一届的全部项目，按截止时间排好；筛选、排序和搜索由调用方做。没登录或冻结的只有还没截止、截止最近的 5 条。登录后的响应带 ETag，数据没变时用 If-None-Match 请求会返回 304。",
    request: { query: ProgramTableQuery },
    responses: {
      200: { description: "项目", content: { "application/json": { schema: ProgramTable } } },
      400: errorResponse("届的格式有误"),
    },
  }),
  async (c) => {
    const { cohort } = c.req.valid("query");
    return c.json(await listPrograms(cohort, !can(c.var.viewer, "read")), 200);
  },
);
