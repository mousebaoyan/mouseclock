import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { AppError } from "../../platform/errors.ts";
import {
  bearerToken,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  IntParam,
  UnixSeconds,
} from "../../platform/http.ts";
import {
  ApplyValue,
  Cohort,
  ExtractedFields,
  IsoDate,
  Kind,
  ProgramName,
  Role,
} from "../programs/schemas.ts";
import {
  crawlerTokenId,
  markRemoved,
  recordExtraction,
  recordListing,
  recordProbe,
  recordRun,
  recordScreening,
  recordSnapshot,
  storeAttachmentFile,
  takeWork,
} from "./service.ts";

// The crawler's side of api.md §6. Requests leave out what they don't have instead of sending
// null, which is how the crawler's Pydantic models dump them; responses spell nulls out.

type CrawlerEnv = { Variables: { crawlerTokenId: number } };

const MB = 1024 * 1024;

const authenticate = createMiddleware<CrawlerEnv>(async (c, next) => {
  const token = bearerToken(c);
  const id = token === undefined ? null : await crawlerTokenId(token);
  if (id === null) throw new AppError(401, "invalid_token", "抓取节点令牌无效或已作废");
  c.set("crawlerTokenId", id);
  await next();
});

const security = [{ crawlerToken: [] }];
const unauthorized = errorResponse("抓取节点令牌无效或已作废");
const noContent = { description: "已记下" };

const Url = z.url({ protocol: /^https?$/ }).max(2000);
const Config = z
  .record(z.string(), z.unknown())
  .openapi("Config", { description: "抓取节点自己的配置，格式由抓取节点定" });
const Failure = z
  .enum([
    "timeout",
    "unreachable",
    "disallowed",
    "too_many_redirects",
    "http_status",
    "no_items",
    "error",
  ])
  .openapi("Failure", {
    description:
      "前四种和 Fetcher 的一样；http_status：状态码不对；no_items：列表里没找到条目；error：其他错误",
  });
const Detail = z.string().max(1000).openapi({ description: "具体原因，比如 HTTP 403" });
const Usage = z
  .strictObject({
    model: z.string().min(1).max(100),
    input_tokens: Int.min(0),
    output_tokens: Int.min(0),
  })
  .openapi("Usage");
const ListedItem = z
  .strictObject({
    url: Url,
    title: z.string().trim().min(1).max(500),
    published_on: IsoDate.optional(),
  })
  .openapi("ListedItem");

// One program a notice is about, as design §8.2 lays out.
const ExtractedProgram = z
  .strictObject({
    program_id: Int.optional().openapi({ description: "对照里的哪个项目；新项目不写" }),
    college_id: Int,
    cohort: Cohort,
    kind: Kind,
    name: ProgramName,
    role: Role.openapi({ description: "call：报名；update：补充；result：名单" }),
    fields: ExtractedFields,
  })
  .openapi("ExtractedProgram");

const Work = z
  .object({
    sources: z.array(
      z
        .object({
          id: Int,
          url: z.string(),
          section: z.string(),
          browser: z.boolean(),
          config: z.union([Config, z.null()]),
          backfill: z.boolean().openapi({ description: "第一次抓：往回翻页，补上前两年的通知" }),
        })
        .openapi("WorkSource"),
    ),
    probes: z.array(
      z
        .object({
          id: Int,
          url: z.string(),
          browser: z.boolean(),
          config: z.union([Config, z.null()]),
        })
        .openapi("WorkProbe"),
    ),
  })
  .openapi("Work");

const ListingResult = z
  .object({
    new_count: Int.openapi({ description: "这次交的条目里新的有几条" }),
    pending: z.array(
      z
        .object({
          id: Int,
          url: z.string(),
          title: z.string(),
          published_on: IsoDate.nullable(),
          step: z.enum(["screen", "fetch"]).openapi({
            description:
              "screen：还没初筛；fetch：要抓正文，初筛通过还没抽取的，或者项目还没截止、一天没抓过的",
          }),
        })
        .openapi("PendingNotice"),
    ),
  })
  .openapi("ListingResult");

const ExtractionContext = z
  .object({
    published_on: IsoDate.nullable(),
    colleges: z.array(z.object({ id: Int, name: z.string() }).openapi("CollegeRef")),
    programs: z.array(
      z
        .object({
          id: Int,
          college_id: Int,
          cohort: Int,
          kind: Kind,
          name: z.string(),
          apply: z.union([ApplyValue, z.null()]),
        })
        .openapi("ProgramCandidate"),
    ),
  })
  .openapi("ExtractionContext");

const SnapshotResult = z
  .object({
    snapshot_id: Int,
    missing_files: z.array(Int).openapi({ description: "还没上传文件的附件序号" }),
    extraction: z.union([ExtractionContext, z.null()]).openapi({
      description: "不为空就要抽取：对照这些学院和项目，交到 /crawler/snapshots/{id}/extraction",
    }),
  })
  .openapi("SnapshotResult");

const router = createRouter<CrawlerEnv>();
router.use(
  "/crawler/*",
  authenticate,
  bodyLimit({
    maxSize: 50 * MB,
    onError() {
      throw new AppError(413, "too_large", "内容太大");
    },
  }),
);

export const ingestRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/crawler/work",
      summary: "领活",
      security,
      responses: {
        200: { description: "要做的事", content: { "application/json": { schema: Work } } },
        401: unauthorized,
      },
    }),
    async (c) => c.json(await takeWork(c.var.crawlerTokenId, new Date()), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/sources/{id}/listing",
      summary: "交来源列表页上的条目",
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z.strictObject({ items: z.array(ListedItem).max(5000) }).openapi("Listing"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "这个来源要接着处理的通知：没初筛的，要抓正文的",
          content: { "application/json": { schema: ListingResult } },
        },
        401: unauthorized,
        404: errorResponse("来源不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await recordListing(id, c.req.valid("json").items), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/sources/{id}/screening",
      summary: "交初筛的分数",
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .strictObject({
                  results: z
                    .array(
                      z
                        .strictObject({
                          notice_id: Int,
                          score: z.number().min(0).max(1),
                          screened_in: z.boolean(),
                        })
                        .openapi("ScreeningResult"),
                    )
                    .min(1)
                    .max(5000),
                  usage: z.array(Usage).max(5000),
                })
                .openapi("Screening"),
            },
          },
        },
      },
      responses: { 204: noContent, 401: unauthorized, 404: errorResponse("来源不存在") },
    }),
    async (c) => {
      const { results, usage } = c.req.valid("json");
      await recordScreening(c.req.valid("param").id, results, usage);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/notices/{id}/snapshot",
      summary: "交抓到的正文和附件的文字",
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .strictObject({
                  fetched_at: UnixSeconds,
                  html: z.string().max(10 * MB),
                  text: z.string().max(2 * MB),
                  attachments: z
                    .array(
                      z
                        .strictObject({
                          name: z.string().min(1).max(500),
                          url: Url,
                          content_type: z.string().min(1).max(200),
                          text: z.string().max(2 * MB),
                        })
                        .openapi("AttachmentInfo"),
                    )
                    .max(50),
                })
                .openapi("Snapshot"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "快照的编号、还缺的附件文件，要抽取时附上对照",
          content: { "application/json": { schema: SnapshotResult } },
        },
        401: unauthorized,
        404: errorResponse("通知不存在"),
      },
    }),
    async (c) => {
      const { fetched_at, ...snapshot } = c.req.valid("json");
      const result = await recordSnapshot(c.req.valid("param").id, {
        ...snapshot,
        fetched_at: new Date(fetched_at * 1000),
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/crawler/snapshots/{id}/attachments/{position}",
      summary: "上传一个附件的文件，请求体就是文件本身",
      security,
      request: {
        params: z.object({ id: IntParam, position: IntParam }),
        body: {
          content: {
            "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
          },
        },
      },
      responses: {
        204: noContent,
        401: unauthorized,
        404: errorResponse("附件不存在"),
        413: errorResponse("文件太大"),
      },
    }),
    async (c) => {
      const { id, position } = c.req.valid("param");
      await storeAttachmentFile(id, position, Buffer.from(await c.req.arrayBuffer()));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/snapshots/{id}/extraction",
      summary: "交抽取的结果",
      description: "网站按总体设计 §8.3 检查、§8.4 归并；过不了检查的进审核页。重复交只算第一次",
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .strictObject({
                  programs: z
                    .array(ExtractedProgram)
                    .max(50)
                    .refine((programs) => {
                      const ids = programs.flatMap((p) => p.program_id ?? []);
                      return new Set(ids).size === ids.length;
                    }, "同一个项目只能出现一次"),
                  usage: z.array(Usage).max(100),
                })
                .openapi("Extraction", { description: "通知涉及的项目；一个都没有就是无关" }),
            },
          },
        },
      },
      responses: { 204: noContent, 401: unauthorized, 404: errorResponse("快照不存在") },
    }),
    async (c) => {
      const { programs, usage } = c.req.valid("json");
      await recordExtraction(c.req.valid("param").id, programs, usage);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/notices/{id}/removed",
      summary: "通知打不开了（404、410）",
      security,
      request: { params: IdParam },
      responses: { 204: noContent, 401: unauthorized, 404: errorResponse("通知不存在") },
    }),
    async (c) => {
      await markRemoved(c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/runs",
      summary: "交一个来源这一轮的结果",
      security,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .strictObject({
                  source_id: Int,
                  started_at: UnixSeconds,
                  finished_at: UnixSeconds,
                  failure: Failure.optional().openapi({ description: "不写就是列表读到了" }),
                  detail: Detail.optional(),
                  listed: Int.min(0),
                  new_count: Int.min(0),
                  useful_count: Int.min(0).openapi({ description: "新通知里抽取出项目的" }),
                  notice_failures: z
                    .array(
                      z
                        .strictObject({ url: Url, failure: Failure, detail: Detail.optional() })
                        .openapi("NoticeFailure"),
                    )
                    .max(5000),
                })
                .openapi("Run"),
            },
          },
        },
      },
      responses: { 204: noContent, 401: unauthorized, 404: errorResponse("来源不存在") },
    }),
    async (c) => {
      const { started_at, finished_at, ...run } = c.req.valid("json");
      await recordRun({
        ...run,
        started_at: new Date(started_at * 1000),
        finished_at: new Date(finished_at * 1000),
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/crawler/probes/{id}",
      summary: "交试抓的结果",
      security,
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .strictObject({
                  items: z.array(ListedItem).max(5000),
                  suggested_config: Config.optional(),
                  failure: Failure.optional(),
                  detail: Detail.optional(),
                  usage: z.array(Usage).max(100),
                })
                .openapi("ProbeReport"),
            },
          },
        },
      },
      responses: { 204: noContent, 401: unauthorized, 404: errorResponse("试抓不存在") },
    }),
    async (c) => {
      await recordProbe(c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

ingestRoutes.openAPIRegistry.registerComponent("securitySchemes", "crawlerToken", {
  type: "http",
  scheme: "bearer",
});
