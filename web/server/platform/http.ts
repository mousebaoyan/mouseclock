import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { checkPermission, type Capability, type Scope, type Viewer } from "./access.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { PER_PAGE } from "./paging.ts";

// Validation messages reach people, in Chinese like every `message` (api.md §1).
z.config(z.locales.zhCN());

// For a field people fill in: its validation messages name it and say how to fix it, such as
// 「学校名称不能为空」, where Zod's own say 「数值过小：期望 string >=1 字符」. A schema's messages cover
// its checks too; what isn't covered here keeps Zod's.
export function named(title: string) {
  return { error: (issue: z.core.$ZodRawIssue) => fieldMessage(title, issue) };
}

function fieldMessage(title: string, issue: z.core.$ZodRawIssue) {
  switch (issue.code) {
    case "invalid_type":
      return issue.input == null ? `请填写${title}` : `${title}的格式不对`;
    case "too_small":
      if (issue.origin === "string") {
        return issue.minimum === 1 ? `${title}不能为空` : `${title}至少要 ${issue.minimum} 个字`;
      }
      if (issue.origin === "array") return `${title}至少要有 ${issue.minimum} 项`;
      return `${title}不能小于 ${issue.minimum}`;
    case "too_big":
      if (issue.origin === "string") return `${title}最多 ${issue.maximum} 个字`;
      if (issue.origin === "array") return `${title}最多 ${issue.maximum} 项`;
      return `${title}不能大于 ${issue.maximum}`;
    case "invalid_format":
      // A wrong protocol and an unparsable address both come as "url", told apart only by an
      // untyped note, so one message covers both.
      return issue.format === "url"
        ? `${title}要写完整，以 http:// 或 https:// 开头`
        : `${title}的格式不对`;
    case "invalid_value":
      return `${title}只能从给出的选项里选`;
    // Zod's messages do for these: they aren't about what someone typed into a field.
    case "custom":
    case "invalid_element":
    case "invalid_key":
    case "invalid_union":
    case "not_multiple_of":
    case "unrecognized_keys":
    default:
      return undefined;
  }
}

// What every request carries once its session or personal token is looked up
// (modules/accounts/routes.ts).
export type AppEnv = {
  Variables: {
    viewer: Viewer | null;
    sessionId: number | null;
    token: { id: number; scope: Scope } | null;
  };
};

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).openapi("ErrorDetail"),
  })
  .openapi("Error");

export function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}

export function createRouter<E extends Env = AppEnv>() {
  return new OpenAPIHono<E>({
    defaultHook(result) {
      if (result.success) return;
      throw new AppError(400, "invalid_request", result.error.issues[0].message);
    },
  });
}

export function handleError(error: Error, c: Context) {
  if (error instanceof AppError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof HTTPException) return error.getResponse();
  log("error", "Unhandled error", { error, method: c.req.method, path: c.req.path });
  return c.json({ error: { code: "internal_error", message: "服务器出现错误，请稍后重试" } }, 500);
}

export function bearerToken(c: Context) {
  return c.req.header("authorization")?.match(/^Bearer +(\S+)$/i)?.[1];
}

// The viewer, once they may do what the route needs (access.ts), and whether it came by the web or
// an Agent's token. A token also takes the route's scope: reading a member's due needs `read`,
// a personal operation passes `personal`; anything else is only for the web, as editing,
// reviewing, managing and the tokens themselves are (api.md §1).
export function authorize(c: Context<AppEnv>, need: Capability, scope?: Scope | "web") {
  const { viewer, token } = c.var;
  if (token) {
    const takes = scope ?? (need === "read" && c.req.method === "GET" ? "read" : "web");
    if (takes === "web") throw new AppError(403, "web_only", "只能本人在网页上操作");
    if (takes === "personal" && token.scope !== "personal") {
      throw new AppError(403, "token_scope", "这个令牌只能查询，不能做个人操作");
    }
  }
  return { ...checkPermission(viewer, need), via: token ? ("agent" as const) : ("web" as const) };
}

// Set by the reverse proxy in front of the site.
export function clientIp(c: Context) {
  return c.req.header("x-real-ip") ?? null;
}

export function unix(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

// Numbers from requests that go into queries, kept within what holds them: PostgreSQL's integer
// for IDs, a date for Unix seconds. Past that the query would fail instead of finding nothing.
// The Param forms read a path or query string.
const INT = { min: -(2 ** 31), max: 2 ** 31 - 1 };
const LAST_SECOND = 8.64e12;
export const Int = z.number().int().min(INT.min).max(INT.max);
// A number from a path or query string, checked by `schema`. Not z.coerce, which turns null into 0
// and so has the OpenAPI document call the parameter optional and nullable.
export function param<T extends z.ZodType<number>>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value !== "" ? Number(value) : value),
    schema,
  );
}
export const IntParam = param(Int);
export const IdParam = z.object({ id: IntParam });
export const UnixSeconds = z.number().int().min(0).max(LAST_SECOND);
// A page's address as the crawler reports it.
export const Url = z.url({ protocol: /^https?$/ }).max(2000);

export const PageParams = z.object({
  page: param(Int.min(1).max(100_000)).default(1),
  // zod-to-openapi documents a literal of several values with the first only.
  per_page: param(z.literal(PER_PAGE).openapi({ enum: [...PER_PAGE] })).default(PER_PAGE[0]),
});

export function Page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: Int, page: Int, per_page: Int });
}
