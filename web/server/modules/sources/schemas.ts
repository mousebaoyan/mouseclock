import { z } from "@hono/zod-openapi";
import { Int, IntParam, UnixSeconds } from "../../platform/http.ts";

export const PAGE_SIZE = 20;
export const PageQuery = z.object({
  page: IntParam.min(1).max(100_000).default(1),
  q: z.string().trim().max(200).default(""),
});
export const CollegeQuery = PageQuery.extend({ school_id: IntParam.positive().optional() });
export const SourceQuery = PageQuery.extend({
  college_id: IntParam.positive().optional(),
  availability: z.enum(["available", "unavailable"]).optional(),
});
export const Config = z.record(z.string(), z.unknown());
const Name = z.string().trim().min(1).max(200);
export const SchoolInput = z.strictObject({
  name: Name,
  short_name: z.string().trim().max(100),
  tiers: z.array(z.enum(["c9", "985", "211", "double_first_class"])).max(4),
});
export const CollegeInput = z.strictObject({
  school_id: Int.positive(),
  name: Name,
  kind: z.enum(["college", "institute", "graduate_school"]),
  region: z.string().trim().min(1).max(100),
  directions: z.array(z.string().trim().min(1).max(100)).max(30),
});
export const SourceInput = z.strictObject({
  college_id: Int.positive(),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  section: z.string().trim().max(200),
  browser: z.boolean(),
  config: Config.nullable(),
  unavailable_reason: z.string().trim().min(1).max(1000).nullable(),
});
const hasFields = (value: object) => Object.keys(value).length > 0;
export const SchoolPatch = SchoolInput.partial().refine(hasFields, "请填写要修改的字段");
export const CollegePatch = CollegeInput.partial().refine(hasFields, "请填写要修改的字段");
export const SourcePatch = SourceInput.partial().refine(hasFields, "请填写要修改的字段");

export const School = z.object({
  id: Int,
  name: z.string(),
  short_name: z.string(),
  tiers: z.array(z.string()),
});
export const College = z.object({
  id: Int,
  school_id: Int,
  school_name: z.string(),
  name: z.string(),
  kind: z.string(),
  region: z.string(),
  directions: z.array(z.string()),
});
export const Source = z.object({
  id: Int,
  college_id: Int,
  school_name: z.string(),
  college_name: z.string(),
  url: z.string(),
  section: z.string(),
  browser: z.boolean(),
  unavailable_reason: z.string().nullable(),
  crawled_at: UnixSeconds.nullable(),
});
export const SourceDetail = Source.extend({ config: Config.nullable() });
export const RunSummary = z.object({
  id: Int,
  source_id: Int,
  started_at: UnixSeconds,
  finished_at: UnixSeconds,
  failure: z.string().nullable(),
  detail: z.string(),
  listed: Int,
  new_count: Int,
  useful_count: Int,
  notice_failure_count: Int,
});
export function Page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), page: Int, next_page: Int.nullable() });
}
