import { createRoute } from "@hono/zod-openapi";
import { can } from "../../platform/access.ts";
import { createRouter, errorResponse } from "../../platform/http.ts";
import { ProgramTable, ProgramTableQuery } from "./schemas.ts";
import { listPrograms } from "./service.ts";

export const programsRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/programs",
    summary: "总表",
    description:
      "一届的全部项目，按截止时间排好；筛选、排序和搜索由调用方做。没登录或冻结的只有还没截止、截止最近的 5 条。",
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
