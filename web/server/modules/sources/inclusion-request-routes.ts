import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse, IdParam, Int } from "../../platform/http.ts";
import {
  askForCollege,
  listRequests,
  mergeRequest,
  updateRequest,
  voteFor,
  withdrawVote,
} from "./inclusion-requests.ts";
import {
  InclusionRequestInput,
  InclusionRequestList,
  InclusionRequestPatch,
  RequestQuery,
} from "./schemas.ts";

// 求收录 (design §10.1).

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const members = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结或禁言中"),
};
const admins = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("只有管理员能操作"),
};

export const inclusionRequestRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/inclusion-requests",
      summary: "求收录的列表",
      description:
        "一栏一栏地看：排队中的按同求人数从多到少，一样多的先提的在前；接入中的先提的在前；已收录和暂时抓不了的新结果在前。带各栏的条数。",
      request: { query: RequestQuery },
      responses: {
        200: { description: "这一栏的一页", content: json(InclusionRequestList) },
        400: errorResponse("进度或页码有误"),
        401: errorResponse("没有登录"),
        403: errorResponse("账号已冻结"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      return c.json(await listRequests(id, c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/inclusion-requests",
      summary: "求收录",
      description:
        "选清单里的学院（`college_id`），或者写上学院的名字（学校选清单里的 `school_id`，或者也写名字 `school_name`）。有人提过、还没收录的算同求，返回那一条。",
      request: { body: { required: true, content: json(InclusionRequestInput) } },
      responses: {
        200: { description: "有人提过，算你同求", content: json(z.object({ id: Int })) },
        201: { description: "新提了一条", content: json(z.object({ id: Int })) },
        ...members,
        404: errorResponse("学校或学院不存在"),
        409: errorResponse("这个学院已经收录了（already_included）"),
      },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "contribute");
      const { id, created } = await askForCollege(userId, c.req.valid("json"));
      return created ? c.json({ id }, 201) : c.json({ id }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/inclusion-requests/{id}/vote",
      summary: "同求",
      description: "每人一票，同求过的照样返回 204。",
      request: { params: IdParam },
      responses: {
        204: { description: "已同求" },
        ...members,
        404: errorResponse("求收录不存在"),
        409: errorResponse("已经收录了"),
      },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "contribute");
      await voteFor(userId, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/inclusion-requests/{id}/vote",
      summary: "撤回同求",
      description: "排队中的没人同求了，就从列表上去掉。",
      request: { params: IdParam },
      responses: { 204: { description: "已撤回，没同求过的也一样" }, ...members },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "contribute");
      await withdrawVote(userId, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/inclusion-requests/{id}",
      summary: "处理求收录",
      description:
        "改进度（暂时抓不了要写原因），或者对上清单里的学院（`college_id`）、学校（`school_id`）。变成已收录或暂时抓不了时，提的和同求的人收到消息；对上的学院已经在抓的，算已收录。记进操作日志。",
      request: { params: IdParam, body: { required: true, content: json(InclusionRequestPatch) } },
      responses: {
        204: { description: "已改" },
        ...admins,
        404: errorResponse("求收录、学校或学院不存在"),
        409: errorResponse(
          "这个学院已经有求收录了，要合并（`duplicate`）；已经对上了学院，不用再对学校（`already_matched`）；还没对上学院，不能算已收录（`not_matched`）",
        ),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      await updateRequest(
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
      path: "/admin/inclusion-requests/{id}/merge",
      summary: "合并求收录",
      description: "把这一条并进 `into`，同求合在一起，同一个人只算一次。记进操作日志。",
      request: {
        params: IdParam,
        body: { required: true, content: json(z.strictObject({ into: Int.positive() })) },
      },
      responses: {
        204: { description: "已合并" },
        ...admins,
        404: errorResponse("求收录不存在"),
        409: errorResponse("这条对上了学院、那条没有，要反过来并（`merge_into_matched`）"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      const { into } = c.req.valid("json");
      await mergeRequest({ user_id: id, via: "web" }, c.req.valid("param").id, into);
      return c.body(null, 204);
    },
  );
