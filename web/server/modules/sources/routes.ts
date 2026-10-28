import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { AppError } from "../../platform/errors.ts";
import {
  authorize,
  bearerToken,
  createRouter,
  errorResponse,
  IdParam,
  unix,
  type AppEnv,
} from "../../platform/http.ts";
import { latestRuns } from "../ingest/service.ts";
import {
  College,
  CollegeInput,
  CollegePatch,
  CollegeQuery,
  Page,
  PageQuery,
  RunSummary,
  School,
  SchoolInput,
  SchoolPatch,
  Source,
  SourceDetail,
  SourceInput,
  SourcePatch,
  SourceQuery,
} from "./schemas.ts";
import {
  createCollege,
  createSchool,
  createSource,
  getCollege,
  getSchool,
  getSource,
  listColleges,
  listSchools,
  listSources,
  updateCollege,
  updateSchool,
  updateSource,
} from "./service.ts";

const errors = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("需要管理员网页会话"),
  404: errorResponse("学校、学院或来源不存在"),
  409: errorResponse("名称或网址重复"),
};
function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const router = createRouter();
router.use(
  "/admin/*",
  createMiddleware<AppEnv>(async (c, next) => {
    // A bearer must not turn a cookie-authenticated write into a CSRF-exempt request.
    if (bearerToken(c)) throw new AppError(403, "forbidden", "管理操作只支持网页会话");
    authorize(c, "admin");
    await next();
  }),
);
export const sourcesRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/schools",
      summary: "管理学校清单",
      request: { query: PageQuery },
      responses: { 200: { description: "学校清单", content: json(Page(School)) }, ...errors },
    }),
    async (c) => c.json(await listSchools(c.req.valid("query")), 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/schools/{id}",
      summary: "学校详情",
      request: { params: IdParam },
      responses: { 200: { description: "学校", content: json(School) }, ...errors },
    }),
    async (c) => c.json(await getSchool(c.req.valid("param").id), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/schools",
      summary: "新增学校",
      request: { body: { required: true, content: json(SchoolInput) } },
      responses: { 201: { description: "已新增", content: json(School) }, ...errors },
    }),
    async (c) => {
      const row = await createSchool(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      return c.json(row, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/schools/{id}",
      summary: "修改学校",
      request: { params: IdParam, body: { required: true, content: json(SchoolPatch) } },
      responses: { 200: { description: "已修改", content: json(School) }, ...errors },
    }),
    async (c) =>
      c.json(
        await updateSchool(
          { user_id: authorize(c, "admin").id, via: "web" },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/colleges",
      summary: "管理学院清单",
      request: { query: CollegeQuery },
      responses: { 200: { description: "学院清单", content: json(Page(College)) }, ...errors },
    }),
    async (c) => c.json(await listColleges(c.req.valid("query")), 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/colleges/{id}",
      summary: "学院详情",
      request: { params: IdParam },
      responses: { 200: { description: "学院", content: json(College) }, ...errors },
    }),
    async (c) => c.json(await getCollege(c.req.valid("param").id), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/colleges",
      summary: "新增学院",
      request: { body: { required: true, content: json(CollegeInput) } },
      responses: { 201: { description: "已新增", content: json(College) }, ...errors },
    }),
    async (c) => {
      const id = await createCollege(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      return c.json(await getCollege(id), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/colleges/{id}",
      summary: "修改学院",
      request: { params: IdParam, body: { required: true, content: json(CollegePatch) } },
      responses: { 200: { description: "已修改", content: json(College) }, ...errors },
    }),
    async (c) => {
      const id = await updateCollege(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(await getCollege(id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/sources",
      summary: "管理来源清单",
      request: { query: SourceQuery },
      responses: {
        200: {
          description: "来源及最近抓取摘要",
          content: json(Page(Source.extend({ last_run: RunSummary.nullable() }))),
        },
        ...errors,
      },
    }),
    async (c) => {
      const page = await listSources(c.req.valid("query"));
      const runs = await latestRuns(page.items.map((s) => s.id));
      return c.json(
        {
          ...page,
          items: page.items.map((s) => ({
            ...s,
            crawled_at: s.crawled_at ? unix(s.crawled_at) : null,
            last_run: runs.find((r) => r.source_id === s.id) ?? null,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/sources/{id}",
      summary: "来源配置详情",
      request: { params: IdParam },
      responses: { 200: { description: "来源详情", content: json(SourceDetail) }, ...errors },
    }),
    async (c) => {
      const source = await getSource(c.req.valid("param").id);
      return c.json(
        { ...source, crawled_at: source.crawled_at ? unix(source.crawled_at) : null },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/sources",
      summary: "接入来源",
      request: { body: { required: true, content: json(SourceInput) } },
      responses: { 201: { description: "已接入", content: json(SourceDetail) }, ...errors },
    }),
    async (c) => {
      const id = await createSource(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      const source = await getSource(id);
      return c.json(
        { ...source, crawled_at: source.crawled_at ? unix(source.crawled_at) : null },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/sources/{id}",
      summary: "修改来源、暂停或恢复抓取",
      request: { params: IdParam, body: { required: true, content: json(SourcePatch) } },
      responses: { 200: { description: "已修改", content: json(SourceDetail) }, ...errors },
    }),
    async (c) => {
      const id = await updateSource(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      const source = await getSource(id);
      return c.json(
        { ...source, crawled_at: source.crawled_at ? unix(source.crawled_at) : null },
        200,
      );
    },
  );
