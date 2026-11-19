import { createRoute, z } from "@hono/zod-openapi";
import { SCOPES } from "../../platform/access.ts";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  named,
  UnixSeconds,
} from "../../platform/http.ts";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  TOKEN_UNUSED_DAYS,
  TOKENS_EACH,
} from "./service.ts";

// One's personal tokens, in 「我的 · Agent」 (design §13): only the web makes and revokes them.

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const Scope = z.enum(SCOPES).openapi({
  description: "`read` 只能查询；`personal` 还能订阅、关注、记报名、提交反馈和修改申请",
});

const ApiToken = z
  .object({
    id: Int,
    name: z.string(),
    scope: Scope,
    created_at: UnixSeconds,
    last_used_at: UnixSeconds.nullable().openapi({
      description: "为空是还没用过；一小时内只记一次",
    }),
  })
  .openapi("ApiToken");

const errors = {
  401: errorResponse("没有登录"),
  403: errorResponse("账号已冻结，或者用令牌调用（只认网页会话）"),
};

export const apiTokenRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/me/tokens",
      summary: "我的个人令牌",
      description: `还能用的，新的在前；作废的和 ${TOKEN_UNUSED_DAYS} 天没用过的不列出。`,
      responses: {
        200: {
          description: "令牌",
          content: json(
            z.object({
              tokens: z.array(ApiToken),
              limit: Int.openapi({ description: "每人最多几个" }),
              unused_days: Int.openapi({ description: "多少天没用过就失效" }),
            }),
          ),
        },
        ...errors,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read", "web");
      return c.json(
        { tokens: await listApiTokens(id), limit: TOKENS_EACH, unused_days: TOKEN_UNUSED_DAYS },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/me/tokens",
      summary: "生成个人令牌",
      description: `返回的令牌只出现这一次，库里只存 SHA-256。每人最多 ${TOKENS_EACH} 个。`,
      request: {
        body: {
          required: true,
          content: json(
            z.strictObject({
              name: z
                .string(named("名字"))
                .trim()
                .min(1)
                .max(50)
                .openapi({ description: "给谁用，比如「我的 Codex」" }),
              scope: Scope,
            }),
          ),
        },
      },
      responses: {
        201: { description: "新令牌", content: json(z.object({ token: z.string() })) },
        400: errorResponse("请求格式有误"),
        ...errors,
        409: errorResponse(`已经有 ${TOKENS_EACH} 个了（\`too_many_tokens\`）`),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read", "web");
      return c.json({ token: await createApiToken(id, c.req.valid("json")) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/me/tokens/{id}",
      summary: "作废个人令牌",
      description: "马上生效：之后带它的请求都返回 401。",
      request: { params: IdParam },
      responses: {
        204: { description: "已作废" },
        400: errorResponse("编号不对"),
        ...errors,
        404: errorResponse("没有这个令牌，或者已经作废了"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "read", "web");
      await revokeApiToken(id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

apiTokenRoutes.openAPIRegistry.registerComponent("securitySchemes", "personalToken", {
  type: "http",
  scheme: "bearer",
  description: "个人令牌，本人在「我的 · Agent」生成；网页用会话 Cookie",
});
