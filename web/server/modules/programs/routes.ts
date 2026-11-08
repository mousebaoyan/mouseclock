import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { can } from "../../platform/access.ts";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  IntParam,
  type AppEnv,
} from "../../platform/http.ts";
import {
  ProgramDetail,
  ProgramTable,
  ProgramTableQuery,
  ProgramVersions,
  SnapshotDetail,
} from "./schemas.ts";
import {
  getAttachmentFile,
  getProgram,
  getSnapshot,
  listPrograms,
  listVersions,
  tableVersion,
} from "./service.ts";

// Part of every ETag: a deploy can change what the table's JSON looks like, and a browser must
// not keep the old shape. Restarting only costs each browser one download.
const STARTED = Date.now().toString(36);

// A member's browser keeps the table and asks again with its ETag; while nothing changed, the
// answer is an empty 304 (design §14). Previews change with the clock, as programs close, and
// aren't tagged; a request the route will turn down isn't either. The version is taken before the
// rows: if they change in between, the tag is older than the data, and the next request downloads
// them again rather than keep stale ones.
const unlessUnchanged = createMiddleware<AppEnv>(async (c, next) => {
  const query = ProgramTableQuery.safeParse(c.req.query());
  if (!query.success || !can(c.var.viewer, "read")) return next();
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
        "一届的全部项目，按截止时间排好；筛选、排序和搜索由调用方做。没登录或冻结的只有还没截止、截止最近的 5 条。登录后的响应带 ETag，数据没变时用 If-None-Match 请求会返回 304。",
      request: { query: ProgramTableQuery },
      responses: {
        200: { description: "项目", content: json(ProgramTable) },
        400: errorResponse("届的格式有误"),
      },
    }),
    async (c) => {
      const { cohort } = c.req.valid("query");
      return c.json(await listPrograms(cohort, !can(c.var.viewer, "read")), 200);
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
        ...errors,
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await getProgram(c.req.valid("param").id), 200);
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
      request: { params: z.object({ id: IntParam, position: IntParam }) },
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
