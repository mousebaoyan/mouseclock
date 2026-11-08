import type { Kind } from "../server/modules/programs/schemas.ts";
import { PER_PAGE } from "../server/platform/paging.ts";
import { beijingYear, currentCohort, statusOf, type Status } from "./time.ts";

// The table's filters, sorting and pages (design §10), read from the address so a link shares
// them. The server works out the first page it renders, and the browser every one after from
// the whole cohort (design §14), with these same functions.

type Program = {
  id: number;
  school: { name: string; short_names: string[]; tier: string | null };
  college: { name: string; region: string; directions: string[] };
  kind: Kind;
  name: string;
  apply_start: number | null;
  apply_deadline: number | null;
  notice: { published_on: string | null };
};

// Absent: not closed yet, which is what people come for.
export const STATUS_FILTERS = ["open", "upcoming", "closed", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number] | null;

function statusMatches(filter: StatusFilter, status: Status | null) {
  if (filter === null) return status !== "closed";
  return filter === "all" || status === filter;
}

export function readFilters(params: URLSearchParams) {
  const status = params.get("status");
  const perPage = PER_PAGE.find((n) => String(n) === params.get("per_page")) ?? PER_PAGE[0];
  const page = Number(params.get("page"));
  return {
    q: params.get("q")?.trim() ?? "",
    tiers: params.getAll("tier"),
    kinds: params.getAll("kind"),
    region: params.get("region") || null,
    direction: params.get("direction") || null,
    status: STATUS_FILTERS.find((s) => s === status) ?? null,
    sort: params.get("sort") === "published" ? ("published" as const) : ("deadline" as const),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    perPage,
  };
}
export type Filters = ReturnType<typeof readFilters>;

const collator = new Intl.Collator("zh-CN");

// What a select offers: each value once, in pinyin order.
function choices(values: string[]) {
  return [...new Set(values)].sort(collator.compare);
}

// The programs `filters` pick, as of `now` in Unix seconds. The API gives them by deadline.
export function tableView<P extends Program>(programs: P[], filters: Filters, now: number) {
  const q = filters.q.toLowerCase();
  const picked = programs.filter((p) => {
    if (filters.kinds.length > 0 && !filters.kinds.includes(p.kind)) return false;
    if (filters.tiers.length > 0 && !filters.tiers.includes(p.school.tier ?? "other")) return false;
    if (filters.region && p.college.region !== filters.region) return false;
    if (filters.direction && !p.college.directions.includes(filters.direction)) return false;
    return (
      !q ||
      [p.school.name, ...p.school.short_names, p.college.name, p.name].some((text) =>
        text.toLowerCase().includes(q),
      )
    );
  });
  const statuses = picked.map((p) => statusOf(p, now));
  // How many each status choice would show, beside it.
  const counts = Object.fromEntries(
    [null, ...STATUS_FILTERS].map((filter) => [
      filter ?? "",
      statuses.filter((status) => statusMatches(filter, status)).length,
    ]),
  );
  const matched = picked.filter((_, i) => statusMatches(filters.status, statuses[i]));
  // Newest first; those listed without a date last.
  if (filters.sort === "published") {
    matched.sort((a, b) =>
      (b.notice.published_on ?? "").localeCompare(a.notice.published_on ?? ""),
    );
  }
  const pages = Math.max(1, Math.ceil(matched.length / filters.perPage));
  const page = Math.min(filters.page, pages);
  return {
    programs: matched.slice((page - 1) * filters.perPage, page * filters.perPage),
    total: matched.length,
    counts,
    page,
    regions: choices(programs.map((p) => p.college.region)),
    directions: choices(programs.flatMap((p) => p.college.directions)),
  };
}

// Everything the page shows, from the API's answer for the cohort in the address.
export function tablePage<P extends Program>(
  table: { preview: boolean; programs: P[] },
  params: URLSearchParams,
  date: Date,
) {
  const filters = readFilters(params);
  const now = Math.floor(date.getTime() / 1000);
  return {
    ...tableView(table.programs, filters, now),
    preview: table.preview,
    cohort: Number(cohortOf(params, date)),
    filters,
    thisYear: beijingYear(date),
    now,
  };
}

export function cohortOf(params: URLSearchParams, date: Date) {
  return params.get("cohort") ?? String(currentCohort(date));
}
