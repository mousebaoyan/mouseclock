import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  PageParams,
} from "../../platform/http.ts";
import {
  acceptFeedback,
  getFeedback,
  giveFeedback,
  listDisputes,
  listFeedbackQueue,
  listMyFeedback,
  listProgramFeedback,
  rejectFeedback,
  resolveDispute,
  withdrawFeedback,
} from "./feedback.ts";
import {
  DisputeResolution,
  Disputes,
  Feedback,
  FeedbackInput,
  FeedbackPage,
  FeedbackQueue,
  FeedbackReview,
  ProgramFeedback,
} from "./schemas.ts";

// Feedback, edit requests and disputes (design §12.1–12.3).

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const readErrors = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结"),
};
const reviewErrors = {
  ...readErrors,
  403: errorResponse("L3 以下、修改权限被收回，或者是自己提的（`own_feedback`）"),
  404: errorResponse("没有这条待处理的反馈"),
};

export const feedbackRoutes = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/programs/{id}/feedback",
      summary: "反馈或修改申请",
      description:
        "只说哪里有问题（`problem`），或者给出改成什么（`edit`，要写理由、附依据）。说的是哪一处：字段的一部分、名称、届、类型，只说有问题的也可以说整个项目。自己对这一处已有待处理的，改那一条。上次复核以后 3 个人说这个项目不对，就标上有争议。",
      request: { params: IdParam, body: { required: true, content: json(FeedbackInput) } },
      responses: {
        201: { description: "已提交", content: json(z.object({ id: Int })) },
        ...readErrors,
        403: errorResponse("账号已冻结或禁言中"),
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "contribute");
      const result = await giveFeedback(
        { user_id: id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/programs/{id}/feedback",
      summary: "项目待处理的反馈",
      request: { params: IdParam },
      responses: {
        200: { description: "先提的在前", content: json(ProgramFeedback) },
        ...readErrors,
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await listProgramFeedback(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/feedback/{id}",
      summary: "一条反馈和它的处理结果",
      request: { params: IdParam },
      responses: {
        200: { description: "反馈", content: json(Feedback) },
        ...readErrors,
        404: errorResponse("反馈不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await getFeedback(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/feedback/{id}",
      summary: "撤回反馈",
      request: { params: IdParam },
      responses: {
        204: { description: "已撤回" },
        ...readErrors,
        404: errorResponse("自己没有这条待处理的反馈"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      await withdrawFeedback(id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/feedback",
      summary: "自己提过的反馈",
      request: { query: PageParams },
      responses: { 200: { description: "新的在前", content: json(FeedbackPage) }, ...readErrors },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      return c.json(await listMyFeedback(id, c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/feedback",
      summary: "待处理的反馈",
      description: "审核页用，先提的在前；带这一处现在的值，提了以后又变过的标出来。",
      request: { query: PageParams },
      responses: {
        200: { description: "待处理的反馈", content: json(FeedbackQueue) },
        ...readErrors,
        403: errorResponse("L3 以下，或修改权限被收回"),
      },
    }),
    async (c) => {
      authorize(c, "edit");
      return c.json(await listFeedbackQueue(c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/feedback/{id}/accept",
      summary: "通过或已改正",
      description:
        "修改申请照申请改，算审核的人的一次修改，链接到这条申请；只说有问题的，是在项目页改好了。提的人收到消息。",
      request: { params: IdParam },
      responses: { 204: { description: "已处理" }, ...reviewErrors },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      await acceptFeedback({ user_id: id, via: "web" }, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/feedback/{id}/reject",
      summary: "驳回或没问题",
      description: "写明为什么，提的人收到消息。",
      request: {
        params: IdParam,
        body: { required: true, content: json(FeedbackReview) },
      },
      responses: { 204: { description: "已处理" }, ...reviewErrors },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      const { note } = c.req.valid("json");
      await rejectFeedback({ user_id: id, via: "web" }, c.req.valid("param").id, note);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/disputes",
      summary: "有争议的项目",
      description: "先标上的在前，每个带算进争议的反馈。",
      responses: {
        200: { description: "有争议的项目", content: json(Disputes) },
        ...readErrors,
        403: errorResponse("只有管理员能看"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await listDisputes(), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/disputes/{id}/resolve",
      summary: "复核争议",
      description:
        "改正了（`corrected`）还是确认没错（`confirmed`），写上说明；这个项目待处理的反馈照它一起关掉，说明就是处理结果，之后的反馈重新计数。",
      request: { params: IdParam, body: { required: true, content: json(DisputeResolution) } },
      responses: {
        204: { description: "已复核" },
        ...readErrors,
        403: errorResponse("只有管理员能操作"),
        404: errorResponse("没有这条争议"),
        409: errorResponse("这条争议已经复核过了（`already_resolved`）"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      await resolveDispute(
        { user_id: id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.body(null, 204);
    },
  );
