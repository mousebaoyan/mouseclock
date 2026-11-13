import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  Int,
  IntParam,
  Page,
  PageParams,
  UnixSeconds,
} from "../../platform/http.ts";
import { IsoDate } from "../programs/schemas.ts";
import { crawlDay } from "./dashboard.ts";
import { RunSummary } from "../sources/schemas.ts";
import { NoticeFailure } from "./routes.ts";
import { PURPOSES } from "./service.ts";

// The crawl dashboard (design §7.5), for members.

const Tokens = z.object({ input_tokens: Int, output_tokens: Int });

const CrawlRun = RunSummary.extend({
  notice_failures: z.array(NoticeFailure).openapi({ description: "没抓成的通知，最多列 20 条" }),
}).openapi("CrawlRun");

const CrawlDay = Page(
  z.object({
    id: Int,
    url: z.string(),
    section: z.string(),
    college: z.string(),
    school: z.string(),
    failing: z.boolean().openapi({ description: "到这一天为止最近 2 轮都没读到列表" }),
    stale: z.boolean().openapi({ description: "旺季里 30 天没有新通知" }),
    runs: z.array(CrawlRun).openapi({ description: "这一天的各轮，先抓的在前" }),
    usage: Tokens.openapi({ description: "这一天这个来源的模型用量" }),
  }),
)
  .extend({
    date: IsoDate,
    crawler_seen_at: UnixSeconds.nullable().openapi({
      description: "抓取节点上次来领活的时间；为空是还没来过",
    }),
    usage: z
      .array(Tokens.extend({ purpose: z.enum(PURPOSES), model: z.string(), calls: Int }))
      .openapi({ description: "这一天按用途和模型的总用量" }),
    failing: Int.openapi({ description: "标红的来源数" }),
    stale: Int.openapi({ description: "标黄的来源数" }),
  })
  .openapi("CrawlDay");

export const dashboardRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/crawl-runs",
    summary: "抓取看板",
    description:
      "某天（北京时间，默认今天）抓过的来源和各轮的结果、用量，标红、标黄的在前（总体设计 §7.5）。",
    request: {
      query: PageParams.extend({ date: IsoDate.optional(), source_id: IntParam.optional() }),
    },
    responses: {
      200: { description: "这一天的抓取", content: { "application/json": { schema: CrawlDay } } },
      401: errorResponse("没有登录"),
      403: errorResponse("账号已冻结"),
    },
  }),
  async (c) => {
    authorize(c, "read");
    return c.json(await crawlDay(c.req.valid("query")), 200);
  },
);
