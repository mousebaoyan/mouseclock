import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse, IntParam } from "../../platform/http.ts";
import { Page, RunSummary } from "../sources/schemas.ts";
import { listCrawlRuns } from "./service.ts";

export const crawlRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/crawl-runs",
    summary: "查看抓取记录",
    request: {
      query: z.object({
        source_id: IntParam.positive().optional(),
        date: z.iso.date().optional(),
        page: IntParam.min(1).max(100_000).default(1),
      }),
    },
    responses: {
      200: {
        description: "抓取记录",
        content: {
          "application/json": {
            schema: Page(
              RunSummary.extend({
                url: z.string(),
                section: z.string(),
                school_name: z.string(),
                college_name: z.string(),
                notice_failures: z.array(
                  z.object({ url: z.string(), failure: z.string(), detail: z.string().optional() }),
                ),
              }),
            ),
          },
        },
      },
      400: errorResponse("请求格式有误"),
      401: errorResponse("没有登录"),
      403: errorResponse("账号已冻结"),
    },
  }),
  async (c) => {
    authorize(c, "read");
    return c.json(await listCrawlRuns(c.req.valid("query")), 200);
  },
);
