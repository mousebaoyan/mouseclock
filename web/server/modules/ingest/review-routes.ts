import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  PageParams,
  UnixSeconds,
} from "../../platform/http.ts";
import { Cohort, Evidence, Kind, StoredValue } from "../programs/schemas.ts";
import { acceptReviewItem, listReviewItems, REASONS, rejectReviewItem } from "./review-items.ts";
import { ExtractedProgram, ExtractionContext } from "./routes.ts";

// The review page's half that is about extractions (design §12.2, development.md §1); recent
// edits come from review.

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const Reason = z.enum(REASONS).openapi("ReviewReason", {
  description:
    "unparsed_date：时间原文待人工确认；" +
    "no_deadline：报名通知没有截止；conflicts_edit：和人改的值冲突；implausible：明显不对；evidence_not_found：证据找不到；low_confidence：置信度低；unknown_program：编号对不上；unknown_college：学院对不上；implausible_cohort：届不对；possible_duplicate：可能重复",
});

const ReviewItem = z
  .object({
    id: Int,
    created_at: UnixSeconds,
    notice: z.object({ title: z.string(), url: z.string(), snapshot_id: Int }),
    program: z
      .object({ id: Int, name: z.string(), college: z.string(), school: z.string() })
      .nullable()
      .openapi({ description: "条目说的项目；还没归并的为空" }),
    field: z
      .object({
        key: z.string(),
        version: Int,
        value: StoredValue,
        evidence: z.array(Evidence),
        confidence: z.number(),
        current: z
          .object({
            value: StoredValue.nullable(),
            version: Int.nullable().openapi({ description: "为空是人改的" }),
          })
          .nullable()
          .openapi({ description: "这个字段现在的值和来自哪一版；为空是表上还没有" }),
      })
      .nullable()
      .openapi({ description: "字段的条目：哪一版抽出来的什么值" }),
    extracted: ExtractionContext.omit({ published_on: true })
      .extend({ program: ExtractedProgram })
      .nullable()
      .openapi({ description: "项目的条目：抽出来的项目，以及这所学校的学院和项目，供选择" }),
  })
  .openapi("ReviewItem");

const ReviewItems = z
  .object({
    reason: Reason,
    counts: z.record(z.string(), Int).openapi({ description: "各种待审的条数，没有的不列" }),
    items: z.array(ReviewItem),
    total: Int,
    page: Int,
    per_page: Int,
  })
  .openapi("ReviewItems");

const Decision = z
  .strictObject({
    program_id: Int.optional().openapi({ description: "并进哪个项目" }),
    college_id: Int.optional(),
    cohort: Cohort.optional(),
    kind: Kind.optional(),
  })
  .openapi("ReviewDecision", {
    description:
      "编号、学院、届对不上的：选这所学校的一个项目，或者选好它的学院和届（类型不写就照抽出来的）新建，两样只写一样；可能重复的：是重复就写原来的项目，不是就不写；其他的不写",
  });

const errors = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结、禁言中、L3 以下，或修改权限被收回"),
};

export const reviewItemsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/review-items",
      summary: "待审的条目",
      description: "抽取拿不准的字段和归并，一次列一种；不指定的话列第一种有条目的。",
      request: { query: PageParams.extend({ reason: Reason.optional() }) },
      responses: {
        200: { description: "条目，先来的在前", content: json(ReviewItems) },
        ...errors,
      },
    }),
    async (c) => {
      authorize(c, "edit");
      return c.json(await listReviewItems(c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/review-items/{id}/accept",
      summary: "通过",
      description: "效果见总体设计 §12.2。",
      request: { params: IdParam, body: { required: true, content: json(Decision) } },
      responses: {
        204: { description: "已通过" },
        ...errors,
        404: errorResponse("条目不存在，或者选的项目、学院不是这所学校的"),
        409: errorResponse(
          "已经处理过了；这条通知已经是那个项目的版本；或者可能重复的项目有人改过，要先撤销",
        ),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      await acceptReviewItem(
        { user_id: id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/review-items/{id}/reject",
      summary: "驳回",
      description: "只关掉这一条，什么都不改。",
      request: { params: IdParam },
      responses: {
        204: { description: "已驳回" },
        ...errors,
        404: errorResponse("条目不存在"),
        409: errorResponse("已经处理过了"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      await rejectReviewItem({ user_id: id, via: "web" }, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
