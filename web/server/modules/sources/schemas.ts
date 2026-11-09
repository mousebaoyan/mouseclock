import { z } from "@hono/zod-openapi";
import { Int, IntParam, named, PageParams, UnixSeconds, Url } from "../../platform/http.ts";
import { ApplyValue, IsoDate, Kind } from "../programs/schemas.ts";

export const PageQuery = PageParams.extend({ q: z.string().trim().max(200).default("") });
export const CollegeQuery = PageQuery.extend({ school_id: IntParam.positive().optional() });
export const SourceQuery = PageQuery.extend({
  college_id: IntParam.positive().optional(),
  availability: z.enum(["available", "unavailable"]).optional(),
});
// Why a fetch failed, as the crawler reports it (api.md §6): a source's list, a notice or a probe.
export const FAILURES = [
  "timeout",
  "unreachable",
  "too_many_redirects",
  "http_status",
  "no_items",
  "error",
] as const;
export type Failure = (typeof FAILURES)[number];
export const Failure = z.enum(FAILURES).openapi("Failure", {
  description:
    "前三种和 Fetcher 的一样；http_status：状态码不对；no_items：列表里没找到条目；error：其他错误",
});
// A notice as a list page shows it, from a source's round or a probe.
export const ListedItem = z
  .strictObject({
    url: Url,
    title: z.string().trim().min(1).max(500),
    published_on: IsoDate.optional(),
  })
  .openapi("ListedItem");
export const Config = z.record(z.string(), z.unknown(), { error: "抓取配置要是 JSON 对象" });
// Lists count each item once: the filters count a college once for each of its directions.
const unique = (items: string[]) => new Set(items).size === items.length;
// What admins fill in, named for validation messages (named in platform/http.ts).
export const SchoolInput = z.strictObject({
  name: z.string(named("学校名称")).trim().min(1).max(200),
  short_names: z
    .array(z.string(named("简称")).trim().min(1).max(100), named("简称"))
    .max(20)
    .refine(unique, "简称有重复"),
  tier: z.enum(["c9", "985", "211", "double_first_class"], named("层次")).nullable(),
});
export const CollegeInput = z.strictObject({
  school_id: Int.positive(),
  name: z.string(named("学院名称")).trim().min(1).max(200),
  kind: z.enum(["college", "institute", "graduate_school"], named("学院类型")),
  region: z.string(named("地区")).trim().min(1).max(100),
  directions: z
    .array(z.string(named("方向")).trim().min(1).max(100), named("方向"))
    .max(30)
    .refine(unique, "方向有重复"),
});
export const SourceInput = z.strictObject({
  college_id: Int.positive(),
  url: z.url({ protocol: /^https?$/, ...named("网址") }).max(2000),
  section: z.string(named("栏目名")).trim().max(200),
  browser: z.boolean(),
  config: Config.nullable(),
  unavailable_reason: z.string(named("暂时抓不了的原因")).trim().min(1).max(1000).nullable(),
});
// A list page to try before it is saved as a source (design §7.2).
export const ProbeInput = SourceInput.pick({ url: true, browser: true, config: true });
const hasFields = (value: object) => Object.keys(value).length > 0;
export const SchoolPatch = SchoolInput.partial().refine(hasFields, "请填写要修改的字段");
export const CollegePatch = CollegeInput.partial().refine(hasFields, "请填写要修改的字段");
export const SourcePatch = SourceInput.partial().refine(hasFields, "请填写要修改的字段");

const Logo = z.string().nullable().openapi({ description: "校徽的地址，没有为空" });
export const School = z.object({
  id: Int,
  name: z.string(),
  short_names: z.array(z.string()),
  tier: z.string().nullable(),
  logo: Logo,
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
// How a source's round went (design §7.5).
export const RunSummary = z
  .object({
    id: Int,
    source_id: Int,
    started_at: UnixSeconds,
    finished_at: UnixSeconds,
    failure: z.union([Failure, z.null()]).openapi({ description: "为空是读到了列表" }),
    detail: z.string(),
    listed: Int,
    new_count: Int,
    useful_count: Int,
    notice_failure_count: Int,
  })
  .openapi("RunSummary");
export const SourceProbe = z
  .object({
    id: Int,
    url: z.string(),
    browser: z.boolean(),
    config: Config.nullable(),
    created_at: UnixSeconds,
    finished_at: UnixSeconds.nullable().openapi({ description: "为空是还在等抓取节点" }),
    items: z.array(ListedItem).openapi({ description: "抓到的条目" }),
    suggested_config: Config.nullable().openapi({ description: "生成的配置；为空是通用抓取就行" }),
    failure: z.union([Failure, z.null()]),
    detail: z.string(),
  })
  .openapi("SourceProbe");
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
  short_names: z.array(z.string()).openapi({ description: "简称，只用来搜索" }),
  tier: z.string().nullable(),
  logo: Logo,
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
  school: School.pick({ id: true, name: true, tier: true, logo: true }),
  name: z.string(),
  kind: z.string(),
  region: z.string(),
  directions: z.array(z.string()),
  sources: z.array(PublicSource),
  programs: z.array(PublicProgramCohort),
});
