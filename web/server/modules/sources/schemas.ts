import { z } from "@hono/zod-openapi";
import { Int, IntParam, named, PageParams, UnixSeconds } from "../../platform/http.ts";
import { ApplyValue, Kind } from "../programs/schemas.ts";

export const PageQuery = PageParams.extend({ q: z.string().trim().max(200).default("") });
export const CollegeQuery = PageQuery.extend({ school_id: IntParam.positive().optional() });
export const SourceQuery = PageQuery.extend({
  college_id: IntParam.positive().optional(),
  availability: z.enum(["available", "unavailable"]).optional(),
});
export const Config = z.record(z.string(), z.unknown(), { error: "抓取配置要是 JSON 对象" });
// What admins fill in, named for validation messages (named in platform/http.ts).
export const SchoolInput = z.strictObject({
  name: z.string(named("学校名称")).trim().min(1).max(200),
  short_name: z.string(named("简称")).trim().max(100),
  tiers: z
    .array(z.enum(["c9", "985", "211", "double_first_class"], named("层次")), named("层次"))
    .max(4),
});
export const CollegeInput = z.strictObject({
  school_id: Int.positive(),
  name: z.string(named("学院名称")).trim().min(1).max(200),
  kind: z.enum(["college", "institute", "graduate_school"], named("学院类型")),
  region: z.string(named("地区")).trim().min(1).max(100),
  directions: z.array(z.string(named("方向")).trim().min(1).max(100), named("方向")).max(30),
});
export const SourceInput = z.strictObject({
  college_id: Int.positive(),
  url: z.url({ protocol: /^https?$/, ...named("网址") }).max(2000),
  section: z.string(named("栏目名")).trim().max(200),
  browser: z.boolean(),
  config: Config.nullable(),
  unavailable_reason: z.string(named("暂时抓不了的原因")).trim().min(1).max(1000).nullable(),
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
  return z.object({ items: z.array(item), total: Int, page: Int, per_page: Int });
}

// Public college pages keep the school grouping and the original application window visible.
// The computed instants are included for status and countdowns; pages still display `apply`.
export const PublicCollege = z.object({
  id: Int,
  name: z.string(),
  kind: z.string(),
  region: z.string(),
  directions: z.array(z.string()),
});
export const PublicSchool = z.object({
  id: Int,
  name: z.string(),
  short_name: z.string(),
  tiers: z.array(z.string()),
  colleges: z.array(PublicCollege),
});
export const PublicCollegeList = z.object({ schools: z.array(PublicSchool) });
export const PublicSource = z.object({
  id: Int,
  url: z.string(),
  section: z.string(),
  unavailable_reason: z.string().nullable(),
});
export const PublicProgram = z.object({
  id: Int,
  kind: Kind,
  name: z.string(),
  apply: z.union([ApplyValue, z.null()]),
  apply_start: UnixSeconds.nullable(),
  apply_deadline: UnixSeconds.nullable(),
});
export const PublicProgramCohort = z.object({
  cohort: Int,
  programs: z.array(PublicProgram),
});
export const PublicCollegeDetail = z.object({
  id: Int,
  school: School.pick({ id: true, name: true }),
  name: z.string(),
  kind: z.string(),
  region: z.string(),
  directions: z.array(z.string()),
  sources: z.array(PublicSource),
  programs: z.array(PublicProgramCohort),
});
