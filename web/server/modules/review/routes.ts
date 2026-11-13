import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse, IdParam } from "../../platform/http.ts";
import {
  Edit,
  ProgramEdit,
  ProgramEdits,
  RecentEdits,
  RecentEditsQuery,
  RevokeResult,
} from "./schemas.ts";
import {
  editProgram,
  listProgramEdits,
  listRecentEdits,
  revertEdit,
  revokeEdits,
} from "./service.ts";

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const readErrors = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结"),
};
const editErrors = {
  ...readErrors,
  403: errorResponse("账号已冻结、禁言中、L3 以下，或修改权限被收回"),
};

export const reviewRoutes = createRouter()
  .openapi(
    createRoute({
      method: "patch",
      path: "/programs/{id}",
      summary: "直接修改",
      description:
        "改字段，或者项目的名称、届、类型，写明理由和依据；字段的值和抽取给的一样，为 null 是清空。报名时间、活动时间和其他时间按部分记，没改的部分照常由之后的通知更新。人改过的字段之后的通知不覆盖。",
      request: { params: IdParam, body: { required: true, content: json(ProgramEdit) } },
      responses: {
        200: {
          description: "这次记下的修改，每个改了的字段或部分一条",
          content: json(ProgramEdits),
        },
        ...editErrors,
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      const result = await editProgram(
        { user_id: id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/programs/{id}/edits",
      summary: "项目的修改记录",
      request: { params: IdParam },
      responses: {
        200: { description: "修改和撤销，最新的在前", content: json(ProgramEdits) },
        ...readErrors,
        404: errorResponse("项目不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await listProgramEdits(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/edits",
      summary: "全站最近的修改",
      request: { query: RecentEditsQuery },
      responses: {
        200: { description: "修改和撤销，最新的在前", content: json(RecentEdits) },
        ...readErrors,
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await listRecentEdits(c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/edits/{id}/revert",
      summary: "撤销一次修改",
      description:
        "字段回到修改前的值和来源：来自哪个版本就回到那个版本，之后的通知照常更新它。这一项在这次修改之后又改过或撤销过的，返回 409，先撤销后来的那次。",
      request: { params: IdParam },
      responses: {
        200: { description: "撤销记下的那条", content: json(z.object({ edit: Edit })) },
        ...editErrors,
        404: errorResponse("修改记录或项目不存在"),
        409: errorResponse("这一项之后又改过或撤销过"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "edit");
      return c.json(await revertEdit({ user_id: id, via: "web" }, c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/users/{id}/revoke-edits",
      summary: "撤销某人的全部修改，收回修改权限",
      description:
        "从最近的一次往前撤；之后又被别人改过的留着不撤。只收回在鼠钟的修改权限，鼠洞的不变。",
      request: { params: IdParam },
      responses: {
        200: { description: "撤销了几次、留着几次", content: json(RevokeResult) },
        ...readErrors,
        403: errorResponse("只有管理员能操作"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "admin");
      return c.json(await revokeEdits({ user_id: id, via: "web" }, c.req.valid("param").id), 200);
    },
  );
