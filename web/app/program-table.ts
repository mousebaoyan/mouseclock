import type { Kind } from "../server/modules/programs/schemas.ts";
import { allOf, anyOf, choices, tally } from "./facets.ts";
import { PER_PAGE } from "../server/platform/paging.ts";
import { currentCohort, statusOf, type Status } from "./time.ts";
import { matchesSearch } from "../server/modules/programs/search.ts";
import { beijingYear } from "../server/modules/programs/time.ts";

// The table's filters, sorting and pages (design §10), read from the address so a link shares
// them. The server works out the first page it renders, and the browser every one after from
// the whole cohort (design §14), with these same functions.

type Program = {
  id: number;
  school: { name: string; short_names: string[]; tier: string | null };
  college: { name: string; region: string; directions: string[]; tags: string[] };
  kind: Kind;
  name: string;
  apply_start: number | null;
  apply_deadline: number | null;
  closes_at: number;
  subscribers: number;
  notice: { published_on: string | null };
};

// Absent: by deadline, as the API gives them.
const SORTS = ["published", "subscribers"] as const;

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
    regions: params.getAll("region"),
    directions: params.getAll("direction"),
    tags: params.getAll("tag"),
    status: STATUS_FILTERS.find((s) => s === status) ?? null,
    sort: SORTS.find((s) => s === params.get("sort")) ?? "deadline",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    perPage,
  };
}
export type Filters = ReturnType<typeof readFilters>;

// The filters that take any number of choices (facets.ts).
const FACETS = ["kind", "tier", "region", "direction"] as const;
type Facet = (typeof FACETS)[number];

const VALUES: Record<Facet, (p: Program) => string[]> = {
  kind: (p) => [p.kind],
  tier: (p) => [p.school.tier ?? "other"],
  region: (p) => [p.college.region],
  direction: (p) => p.college.directions,
};

// The programs `filters` pick, as of `now` in Unix seconds. The API gives them by deadline.
// Beside each choice of a filter goes how many it would show with the other filters as they are.
export function tableView<P extends Program>(programs: P[], filters: Filters, now: number) {
  const picks: Record<Facet, string[]> = {
    kind: filters.kinds,
    tier: filters.tiers,
    region: filters.regions,
    direction: filters.directions,
  };
  const rows = programs.map((program) => ({ program, status: statusOf(program, now) }));
  // Whether a program passes every filter but `skip`.
  const passes = ({ program: p, status }: (typeof rows)[number], skip?: Facet | "status") =>
    matchesSearch(p, filters.q) &&
    FACETS.every((facet) => facet === skip || anyOf(picks[facet], VALUES[facet](p))) &&
    allOf(filters.tags, p.college.tags) &&
    (skip === "status" || statusMatches(filters.status, status));
  const tallyOf = (facet: Facet) =>
    tally(rows.filter((row) => passes(row, facet)).flatMap((row) => VALUES[facet](row.program)));
  const anyStatus = rows.filter((row) => passes(row, "status"));
  const counts = {
    status: Object.fromEntries(
      [null, ...STATUS_FILTERS].map((filter) => [
        filter ?? "",
        anyStatus.filter((row) => statusMatches(filter, row.status)).length,
      ]),
    ),
    kind: tallyOf("kind"),
    tier: tallyOf("tier"),
    region: tallyOf("region"),
    direction: tallyOf("direction"),
  };
  const matched = rows.filter((row) => passes(row)).map((row) => row.program);
  // A tag picked narrows what the others count, as picking another would narrow it further.
  const tagCounts = tally(matched.flatMap((p) => p.college.tags));
  // Newest first, those listed without a date last; or the most subscribed first. Ties stay by
  // deadline.
  if (filters.sort === "published") {
    matched.sort((a, b) =>
      (b.notice.published_on ?? "").localeCompare(a.notice.published_on ?? ""),
    );
  } else if (filters.sort === "subscribers") {
    matched.sort((a, b) => b.subscribers - a.subscribers);
  }
  const pages = Math.max(1, Math.ceil(matched.length / filters.perPage));
  const page = Math.min(filters.page, pages);
  return {
    programs: matched.slice((page - 1) * filters.perPage, page * filters.perPage),
    total: matched.length,
    counts: { ...counts, tag: tagCounts },
    page,
    regions: choices(programs.map((p) => p.college.region)),
    directions: choices(programs.flatMap((p) => p.college.directions)),
    tags: choices(programs.flatMap((p) => p.college.tags)),
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
