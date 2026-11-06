import type { InferResponseType } from "hono/client";
import type { createApi } from "./api.server.ts";

type Api = ReturnType<typeof createApi>;
type AdminApi = Api["admin"];
export type SchoolsPage = InferResponseType<AdminApi["schools"]["$get"], 200>;
export type SchoolDetail = InferResponseType<AdminApi["schools"][":id"]["$get"], 200>;
export type CollegesPage = InferResponseType<AdminApi["colleges"]["$get"], 200>;
export type CollegeDetail = InferResponseType<AdminApi["colleges"][":id"]["$get"], 200>;
export type SourcesPage = InferResponseType<AdminApi["sources"]["$get"], 200>;
export type SourceDetail = InferResponseType<AdminApi["sources"][":id"]["$get"], 200>;

export function formText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
