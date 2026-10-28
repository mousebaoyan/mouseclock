import type { ClientResponse, InferResponseType } from "hono/client";
import { data } from "react-router";
import type { z } from "zod";
import type { ErrorSchema } from "../server/platform/http.ts";
import type { createApi } from "./api.server.ts";

type Api = ReturnType<typeof createApi>;
type AdminApi = Api["admin"];
export type SchoolsPage = InferResponseType<AdminApi["schools"]["$get"], 200>;
export type SchoolDetail = InferResponseType<AdminApi["schools"][":id"]["$get"], 200>;
export type CollegesPage = InferResponseType<AdminApi["colleges"]["$get"], 200>;
export type CollegeDetail = InferResponseType<AdminApi["colleges"][":id"]["$get"], 200>;
export type SourcesPage = InferResponseType<AdminApi["sources"]["$get"], 200>;
export type SourceDetail = InferResponseType<AdminApi["sources"][":id"]["$get"], 200>;
export type RunsPage = InferResponseType<Api["crawl-runs"]["$get"], 200>;

export async function readApi<T>(
  res:
    | ClientResponse<T, 200, "json">
    | ClientResponse<z.infer<typeof ErrorSchema>, 400 | 401 | 403 | 404 | 409, "json">,
): Promise<T> {
  if (res.status !== 200) {
    const body = await res.json();
    throw data(body.error.message, { status: res.status });
  }
  return res.json();
}

export async function requireAdmin(request: Request, api: ReturnType<typeof createApi>) {
  if (request.headers.has("authorization")) {
    throw data("管理操作只支持网页会话", { status: 403 });
  }
  const res = await api.me.$get();
  if (res.status !== 200) throw data("请先登录", { status: 401 });
  const me = await res.json();
  if (!me.can.admin) throw data("只有可用的管理员账号能操作", { status: 403 });
}

export function formText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
