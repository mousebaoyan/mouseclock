import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  IntParam,
} from "../../platform/http.ts";
import { followCollege, listFollows, unfollowCollege } from "./follows.ts";
import { RequestStatus } from "./schemas.ts";

// 关注学院 (design §11.4).

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const members = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结"),
};

const Follow = z
  .object({
    college: z.object({ id: Int, name: z.string() }),
    school: z.object({ id: Int, name: z.string(), logo: z.string().nullable() }),
    programs: Int.openapi({ description: "这一届的项目数" }),
    latest_notice: z.string().nullable().openapi({ description: "最近一条通知的日期，YYYY-MM-DD" }),
    crawled: z.boolean().openapi({ description: "已经在抓了没有" }),
    request: z
      .object({ id: Int, status: RequestStatus })
      .nullable()
      .openapi({ description: "还没在抓的，它的求收录" }),
  })
  .openapi("Follow");

export const followRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/colleges/{id}/follow",
      summary: "关注学院",
      description: "关注过的照样返回 204。还没在抓的学院，关注就算替它求收录：没人提过的新建一条。",
      request: { params: IdParam },
      responses: { 204: { description: "已关注" }, ...members, 404: errorResponse("学院不存在") },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "read");
      await followCollege(userId, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/colleges/{id}/follow",
      summary: "取消关注",
      description: "关注算的那一票也撤了。",
      request: { params: IdParam },
      responses: { 204: { description: "已取消，没关注过的也一样" }, ...members },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "read");
      await unfollowCollege(userId, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/follows",
      summary: "自己关注的学院",
      description:
        "按学校排；每个带这一届（`cohort`）的项目数、最近一条通知的日期，还没在抓的带求收录的进度。",
      request: { query: z.object({ cohort: IntParam.min(2000).max(2100) }) },
      responses: {
        200: { description: "关注的学院", content: json(z.object({ follows: z.array(Follow) })) },
        ...members,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read");
      return c.json({ follows: await listFollows(id, c.req.valid("query").cohort) }, 200);
    },
  );
