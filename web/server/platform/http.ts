import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";

// Validation messages reach people, in Chinese like every `message` (api.md §1).
z.config(z.locales.zhCN());

export function createRouter() {
  return new OpenAPIHono({
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
