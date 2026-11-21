import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { can } from "../../platform/access.ts";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  IntParam,
  param,
  type AppEnv,
} from "../../platform/http.ts";
import { clearApplication, listApplications, setApplication } from "./applications.ts";
import { beijingYear } from "./time.ts";
import {
  ApplicationInput,
  Applications,
  ExportQuery,
  ProgramDetail,
  ProgramExport,
  ProgramFilterQuery,
  ProgramTable,
  ProgramVersions,
  SnapshotDetail,
  Stage,
} from "./schemas.ts";
import {
  exportCsv,
  exportPrograms,
  getAttachmentFile,
  getProgram,
  getSnapshot,
  listPrograms,
  listVersions,
  tableVersion,
  verifyProgram,
} from "./service.ts";

// Part of every ETag: a deploy can change what the table's JSON looks like, and a browser must
// not keep the old shape. Restarting only costs each browser one download.
const STARTED = Date.now().toString(36);

// A member's browser keeps the table and asks again with its ETag; while nothing changed, the
// answer is an empty 304 (design §14). Previews change with the clock, as programs close, and
// aren't tagged; nor are filtered tables, which `closed` changes with the clock too and which
// pages don't ask for, nor a request the route will turn down. The version is taken before the
// rows: if they change in between, the tag is older than the data, and the next request downloads
// them again rather than keep stale ones.
const unlessUnchanged = createMiddleware<AppEnv>(async (c, next) => {
  const query = ProgramFilterQuery.safeParse(c.req.query());
  if (!query.success || !can(c.var.viewer, "read")) return next();
  const { q, kind, closed } = query.data;
  if (q !== "" || kind !== undefined || closed !== undefined) return next();
  const etag = `"${STARTED}-${query.data.cohort}-${await tableVersion()}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return next();
});

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const errors = {
  400: errorResponse("编号的格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结"),
};

export const programsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/programs",
      middleware: [unlessUnchanged] as const,
      summary: "总表",
      description:
        "一届的项目，按截止时间排好。可以按关键词、类型和是否截止先筛，都不带是这一届的全部，很长；别的筛选和排序由调用方做。没登录或冻结的只有还没截止、截止最近的 5 条，筛选也只在这几条里。不带筛选时，登录后的响应带 ETag，数据没变时用 If-None-Match 请求会返回 304。",
      request: { query: ProgramFilterQuery },
      responses: {
        200: { description: "项目", content: json(ProgramTable) },
        400: errorResponse("届的格式有误"),
      },
    }),
    async (c) => {
      return c.json(await listPrograms(c.req.valid("query"), !can(c.var.viewer, "read")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/export",
      summary: "下载一届的项目",
      description:
        "作为文件下载。和总表一样带 ETag，数据没变时用 If-None-Match 请求会返回 304（总体设计 §13）。",
      request: { query: ExportQuery },
      responses: {
        200: {
          description: "项目",
          content: {
            "text/csv": { schema: z.string() },
            "application/json": { schema: ProgramExport },
          },
        },
        ...errors,
        400: errorResponse("届或格式不对"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      const { cohort, format } = c.req.valid("query");
      // The CSV writes dates without this year's number, so the year is part of the tag too.
      const thisYear = beijingYear(new Date());
      const etag = `"${STARTED}-${cohort}-${format}-${thisYear}-${await tableVersion()}"`;
      c.header("ETag", etag);
      c.header("Cache-Control", "private, no-cache");
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
      c.header("Content-Disposition", `attachment; filename="mouseclock-${cohort}.${format}"`);
      const data = await exportPrograms(cohort);
      if (format === "json") return c.json(data, 200);
      return c.body(exportCsv(data, thisYear), 200, { "Content-Type": "text/csv; charset=utf-8" });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/programs/{id}",
      summary: "项目详情",
      description: "字段按总体设计 §8.2 拼好，分部分的字段每部分各带证据和来自哪个版本。",
      request: { params: IdParam },
      responses: {
        200: { description: "项目、原文和字段", content: json(ProgramDetail) },
        308: {
          description: "项目并进了另一个，`Location` 是留下的那个",
          headers: z.object({ Location: z.string() }),
          content: json(z.object({ merged_into: Int })),
        },
        ...errors,
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      const program = await getProgram(c.req.valid("param").id);
      if ("merged_into" in program) {
        return c.json(program, 308, { Location: `/api/v1/programs/${program.merged_into}` });
      }
      return c.json(program, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/programs/{id}/versions",
      summary: "项目的版本",
      request: { params: IdParam },
      responses: {
        200: { description: "版本，最新的在前", content: json(ProgramVersions) },
        ...errors,
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await listVersions(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/programs/{id}/verify",
      summary: "标记已核对",
      description:
        "核对过全部字段后标记，记下是谁、什么时候；之后有新版本改了字段或有人修改，标记取消。",
      request: { params: IdParam },
      responses: {
        204: { description: "已标记" },
        ...errors,
        403: errorResponse("账号已冻结、禁言中、L3 以下，或修改权限被收回"),
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      await verifyProgram(c.req.valid("param").id, id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/programs/{id}/application",
      summary: "记报名",
      description: "记下或改掉自己对这个项目的报名进度和备注，只有自己看得到（总体设计 §9.4）。",
      request: { params: IdParam, body: { required: true, content: json(ApplicationInput) } },
      responses: {
        204: { description: "已记下" },
        ...errors,
        400: errorResponse("编号或填的内容有误"),
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read", "personal");
      await setApplication(id, c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/programs/{id}/application",
      summary: "清除报名记录",
      request: { params: IdParam },
      responses: {
        204: { description: "已清除，没记过的也一样" },
        ...errors,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read", "personal");
      await clearApplication(id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/applications",
      summary: "自己的报名记录",
      description: "带各进度的条数；总表卡片上的进度也用它。删掉的项目的记录不在里面。",
      request: { query: z.object({ stage: Stage.optional() }) },
      responses: {
        200: { description: "报名记录", content: json(Applications) },
        400: errorResponse("进度的写法有误"),
        401: errorResponse("没有登录"),
        403: errorResponse("账号已冻结"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      return c.json(await listApplications(id, c.req.valid("query").stage), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/snapshots/{id}",
      summary: "快照",
      description: "抓到的通知原文，HTML 按白名单净化过；附件的文件另外下载。",
      request: { params: IdParam },
      responses: {
        200: { description: "快照", content: json(SnapshotDetail) },
        ...errors,
        404: errorResponse("快照不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await getSnapshot(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/snapshots/{id}/attachments/{position}",
      summary: "下载附件",
      description: "总是作为下载返回，不在浏览器里直接打开：附件来自外部网站，不可信。",
      request: { params: z.object({ id: IntParam, position: param(Int.min(0)) }) },
      responses: {
        200: {
          description: "附件的文件",
          content: {
            "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
          },
        },
        ...errors,
        404: errorResponse("附件不存在，或文件还没传上来"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      const { id, position } = c.req.valid("param");
      const file = await getAttachmentFile(id, position);
      return c.body(new Uint8Array(file.data), 200, {
        "Content-Type": file.content_type,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
      });
    },
  );
