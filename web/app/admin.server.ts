import type { ClientResponse, InferResponseType } from "hono/client";
import { data } from "react-router";
import type { z } from "zod";
import { ErrorSchema } from "../server/platform/http.ts";
import type { createApi } from "./api.server.ts";

type Api = ReturnType<typeof createApi>["client"];
type AdminApi = Api["admin"];
export type SchoolsPage = InferResponseType<AdminApi["schools"]["$get"], 200>;
export type SchoolDetail = InferResponseType<AdminApi["schools"][":id"]["$get"], 200>;
export type CollegesPage = InferResponseType<AdminApi["colleges"]["$get"], 200>;
export type CollegeDetail = InferResponseType<AdminApi["colleges"][":id"]["$get"], 200>;
export type SourcesPage = InferResponseType<AdminApi["sources"]["$get"], 200>;
export type SourceDetail = InferResponseType<AdminApi["sources"][":id"]["$get"], 200>;

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

export async function writeApi<T extends z.ZodType>(
  api: ReturnType<typeof createApi>,
  url: URL,
  method: "POST" | "PATCH",
  values: unknown,
  schema: T,
) {
  const response = await api.request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  const body: unknown = await response.json();
  if (!response.ok)
    return { error: ErrorSchema.parse(body).error.message, status: response.status };
  return { value: schema.parse(body) };
}

export function formText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
