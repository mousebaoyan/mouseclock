import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  IntParam,
} from "../../platform/http.ts";
import {
  clearTag,
  createTag,
  deleteTag,
  listTags,
  removeVote,
  tagCollege,
  tagVotes,
  untagCollege,
  updateTag,
} from "./college-tags.ts";
import { AdminTag, TagInput, TagPatch, TagVote } from "./schemas.ts";

// 学院标签 (design §9.3): members tag colleges; admins remove what was put on at random and keep
// the presets.

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const CollegeTagParams = z.object({ id: IntParam, tag: IntParam });

const members = {
  400: errorResponse("编号的格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结或禁言中"),
};
const admins = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("只有管理员能操作"),
};

export const collegeTagRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/colleges/{id}/tags/{tag}",
      summary: "贴学院标签",
      description: "每人每个标签一票，贴过的照样返回 204。禁言的不能贴。",
      request: { params: CollegeTagParams },
      responses: {
        204: { description: "已贴上" },
        ...members,
        404: errorResponse("学院或标签不存在"),
      },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "contribute");
      const { id, tag } = c.req.valid("param");
      await tagCollege(userId, id, tag);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/colleges/{id}/tags/{tag}",
      summary: "撤回学院标签",
      request: { params: CollegeTagParams },
      responses: { 204: { description: "已撤回，没贴过的也一样" }, ...members },
    }),
    async (c) => {
      const { id: userId } = authorize(c, "contribute");
      const { id, tag } = c.req.valid("param");
      await untagCollege(userId, id, tag);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/colleges/{id}/tags/{tag}/votes",
      summary: "谁贴了这个标签",
      description: "最新的在前，管理员删乱贴的用。",
      request: { params: CollegeTagParams },
      responses: {
        200: { description: "贴的人和时间", content: json(z.object({ votes: z.array(TagVote) })) },
        ...admins,
      },
    }),
    async (c) => {
      authorize(c, "admin");
      const { id, tag } = c.req.valid("param");
      return c.json({ votes: await tagVotes(id, tag) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/tag-votes/{id}",
      summary: "删一票",
      description: "记进操作日志。",
      request: { params: IdParam },
      responses: { 204: { description: "已删" }, ...admins, 404: errorResponse("这一票不存在") },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      await removeVote({ user_id: id, via: "web" }, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/colleges/{id}/tags/{tag}",
      summary: "清空学院的一个标签",
      description: "删掉这个学院这个标签的全部票，记进操作日志。",
      request: { params: CollegeTagParams },
      responses: { 204: { description: "已清空" }, ...admins },
    }),
    async (c) => {
      const admin = authorize(c, "admin");
      const { id, tag } = c.req.valid("param");
      await clearTag({ user_id: admin.id, via: "web" }, id, tag);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/tags",
      summary: "学院标签的预设",
      description: "按顺序排，带一共有几票。",
      responses: {
        200: { description: "预设", content: json(z.object({ tags: z.array(AdminTag) })) },
        ...admins,
      },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json({ tags: await listTags() }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/tags",
      summary: "加一个预设",
      description: "排在最后，记进操作日志。",
      request: { body: { required: true, content: json(TagInput) } },
      responses: {
        201: { description: "已加上", content: json(z.object({ id: Int })) },
        ...admins,
        409: errorResponse("已经有这个标签了"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      return c.json({ id: await createTag({ user_id: id, via: "web" }, c.req.valid("json")) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/tags/{id}",
      summary: "改预设",
      description: "改名字、说明或排第几；改名不影响已经贴的。记进操作日志。",
      request: { params: IdParam, body: { required: true, content: json(TagPatch) } },
      responses: {
        204: { description: "已改" },
        ...admins,
        404: errorResponse("标签不存在"),
        409: errorResponse("已经有这个标签了"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      await updateTag({ user_id: id, via: "web" }, c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/tags/{id}",
      summary: "删预设",
      description: "大家贴的一起删，记进操作日志。",
      request: { params: IdParam },
      responses: { 204: { description: "已删" }, ...admins, 404: errorResponse("标签不存在") },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      await deleteTag({ user_id: id, via: "web" }, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
