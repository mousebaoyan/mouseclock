import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";

// Validation messages reach people, in Chinese like every `message` (api.md §1).
z.config(z.locales.zhCN());

export const ErrorSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).openapi("ErrorDetail"),
  })
  .openapi("Error");

export function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}

export function createRouter<E extends Env = Env>() {
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
