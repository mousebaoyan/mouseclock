import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { checkPermission, type Capability, type Viewer } from "./access.ts";
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

// What every request carries once the session is looked up (modules/accounts/routes.ts).
export type AppEnv = { Variables: { viewer: Viewer | null; sessionId: number | null } };

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
  return c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
}

// The viewer, once they may do what the route needs; see access.ts for the rules.
export function authorize(c: Context<AppEnv>, need: Capability) {
  return checkPermission(c.var.viewer, need);
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
export const IntParam = z.coerce.number().int().min(INT.min).max(INT.max);
export const IdParam = z.object({ id: IntParam });
export const UnixSeconds = z.number().int().min(0).max(LAST_SECOND);

export const PageParams = z.object({
  page: IntParam.min(1).max(100_000).default(1),
  per_page: z.coerce.number().pipe(z.literal(PER_PAGE)).default(PER_PAGE[0]),
});

export function Page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), total: Int, page: Int, per_page: Int });
}
