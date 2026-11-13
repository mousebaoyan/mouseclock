import { createRoute, z } from "@hono/zod-openapi";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  named,
  UnixSeconds,
} from "../../platform/http.ts";
import { createCrawlerToken, listCrawlerTokens, revokeCrawlerToken } from "./service.ts";

// The owner's crawler tokens, in the system settings (design §6.2).

function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const CrawlerToken = z
  .object({
    id: Int,
    name: z.string(),
    created_at: UnixSeconds,
    last_seen_at: UnixSeconds.nullable().openapi({ description: "上次来领活；为空是还没来过" }),
    revoked_at: UnixSeconds.nullable().openapi({ description: "为空是还在用" }),
  })
  .openapi("CrawlerToken");

const errors = {
  401: errorResponse("没有登录"),
  403: errorResponse("只有站长能操作"),
};

export const tokenRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/crawler-tokens",
      summary: "抓取节点令牌",
      responses: {
        200: { description: "令牌，新的在前", content: json(z.array(CrawlerToken)) },
        ...errors,
      },
    }),
    async (c) => {
      authorize(c, "owner");
      return c.json(await listCrawlerTokens(), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/crawler-tokens",
      summary: "生成抓取节点令牌",
      description: "返回的令牌只出现这一次，库里只存 SHA-256。",
      request: {
        body: {
          required: true,
          content: json(
            z.strictObject({
              name: z
                .string(named("名字"))
                .trim()
                .min(1)
                .max(100)
                .openapi({ description: "用在哪个抓取节点，比如「上海」" }),
            }),
          ),
        },
      },
      responses: {
        201: { description: "新令牌", content: json(z.object({ token: z.string() })) },
        400: errorResponse("请求格式有误"),
        ...errors,
      },
    }),
    async (c) => {
      const { id } = authorize(c, "owner");
      const token = await createCrawlerToken(c.req.valid("json").name, { user_id: id, via: "web" });
      return c.json({ token }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/crawler-tokens/{id}/revoke",
      summary: "作废抓取节点令牌",
      description: "马上生效：用它的抓取节点之后的请求都返回 401。",
      request: { params: IdParam },
      responses: {
        204: { description: "已作废" },
        400: errorResponse("编号不对"),
        ...errors,
        404: errorResponse("令牌不存在"),
        409: errorResponse("已经作废了"),
      },
    }),
    async (c) => {
      const { id } = authorize(c, "owner");
      await revokeCrawlerToken({ user_id: id, via: "web" }, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
