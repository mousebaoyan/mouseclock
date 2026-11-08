import { hc, type InferResponseType } from "hono/client";
import { data, Link, useLocation, useRouteLoaderData } from "react-router";
import { cn } from "~/cn";
import { ExternalLink } from "~/components/icons";
import { Group, List, Row } from "~/components/list";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { KindTag, PROGRAM_KINDS, StatusTag, TopTier } from "~/components/tags";
import { TIER_FILTERS } from "~/tiers";
import { buttonVariants } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import type { ApiType } from "../../server/app.ts";
import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { cohortOf, tablePage, type Filters } from "../program-table.ts";
import type { loader as rootLoader } from "../root.tsx";
import {
  beijingDate,
  currentCohort,
  formatTime,
  STATUS_LABELS,
  statusOf,
  useNow,
} from "../time.ts";
import type { Route } from "./+types/home.ts";

type Table = InferResponseType<ReturnType<typeof createApi>["programs"]["$get"], 200>;
type Program = Table["programs"][number];

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

// The server renders the page of the table the address asks for; the cohort itself stays on
// the server, so the first screen doesn't wait for it (design §14).
export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const date = new Date();
  const table = await readApi<Table>(
    await context.get(apiContext).programs.$get({ query: { cohort: cohortOf(params, date) } }),
  );
  return tablePage(table, params, date);
}

// After that the browser keeps the whole cohort, and filters, sorts and pages it itself. It asks
// again for another cohort or after a while; the server answers 304 while nothing changed.
let kept: { cohort: string; at: number; table: Table } | null = null;
const KEEP_MS = 5 * 60_000;

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const params = new URL(request.url).searchParams;
  const date = new Date();
  const cohort = cohortOf(params, date);
  if (kept?.cohort !== cohort || date.getTime() - kept.at > KEEP_MS) {
    const res = await hc<ApiType>("/api/v1").programs.$get({ query: { cohort } });
    if (res.status !== 200) throw data((await res.json()).error.message, { status: res.status });
    kept = { cohort, at: date.getTime(), table: await res.json() };
  }
  return tablePage(kept.table, params, date);
}

type Data = Route.ComponentProps["loaderData"];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { cohort, preview, programs, total, page, filters } = loaderData;
  const now = useNow(loaderData.now);
  return (
    <Page title={`${cohort} 届保研项目`} hideTitle>
      {preview ? <PreviewNotice /> : <Filters data={loaderData} />}
      {programs.length === 0 ? (
        <Empty>{preview ? "目前没有即将截止的项目" : "没有符合条件的项目"}</Empty>
      ) : (
        <div>
          <Agenda
            programs={programs}
            sort={filters.sort}
            now={now}
            thisYear={loaderData.thisYear}
          />
          {!preview && <Pagination total={total} page={page} perPage={filters.perPage} />}
        </div>
      )}
    </Page>
  );
}

// A preview goes to guests and to frozen accounts, who are signed in but no longer in the group.
function PreviewNotice() {
  const { pathname, search } = useLocation();
  const signedIn = Boolean(useRouteLoaderData<typeof rootLoader>("root")?.me);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-card shadow-card px-4 py-3">
      <p className="min-w-0 flex-1 text-sm">
        {signedIn
          ? "账号已冻结，仅显示截止时间最近的项目"
          : "未登录时仅显示截止时间最近的项目，登录后可查看全部项目并使用搜索和筛选"}
      </p>
      {!signedIn && (
        // A page of the server, not of the router: it goes on to mousehole.
        <a
          href={`/login?next=${encodeURIComponent(pathname + search)}`}
          className={buttonVariants({ size: "sm" })}
        >
          登录
        </a>
      )}
    </div>
  );
}

function Filters({ data: { filters, regions, directions, counts, now, cohort } }: { data: Data }) {
  const { search } = useLocation();
  const { hrefWith, set } = useFilters();
  const current = currentCohort(new Date(now * 1000));
  const cohorts = [current + 1, current, current - 1, current - 2];
  // What 清除筛选 clears besides the search; the cohort and the order stay.
  const narrowed = Boolean(
    filters.status ||
    filters.kinds.length + filters.tiers.length > 0 ||
    filters.region ||
    filters.direction,
  );
  const statusChoices = [
    { value: "", label: "未截止" },
    { value: "open", label: STATUS_LABELS.open },
    { value: "upcoming", label: STATUS_LABELS.upcoming },
    { value: "closed", label: STATUS_LABELS.closed },
    { value: "all", label: "全部" },
  ];
  return (
    <FilterBar
      search={<SearchBox value={filters.q} placeholder="搜索学校、学院或项目名称" />}
      selects={
        <>
          <Select
            aria-label="届"
            value={String(cohort)}
            onValueChange={(value) => set("cohort", value)}
            options={(cohorts.includes(cohort) ? cohorts : [cohort, ...cohorts]).map((c) => ({
              value: String(c),
              label: `${c} 届`,
            }))}
            className="sm:w-28"
          />
          <Select
            aria-label="地区"
            value={filters.region ?? ""}
            onValueChange={(value) => set("region", value)}
            options={[
              { value: "", label: "全部地区" },
              ...regions.map((r) => ({ value: r, label: r })),
            ]}
            className="sm:w-32"
          />
          <Select
            aria-label="方向"
            value={filters.direction ?? ""}
            onValueChange={(value) => set("direction", value)}
            options={[
              { value: "", label: "全部方向" },
              ...directions.map((d) => ({ value: d, label: d })),
            ]}
            className="sm:w-32"
          />
          <Select
            aria-label="排序"
            value={filters.sort === "published" ? "published" : ""}
            onValueChange={(value) => set("sort", value)}
            options={[
              { value: "", label: "按截止时间" },
              { value: "published", label: "按发布时间" },
            ]}
            className="sm:w-34"
          />
        </>
      }
      rows={[
        {
          label: "状态",
          content: (
            <Segmented
              label="状态"
              items={statusChoices.map((choice) => ({
                to: hrefWith("status", choice.value ? [choice.value] : []),
                label: choice.label,
                count: counts[choice.value],
                on: (filters.status ?? "") === choice.value,
              }))}
            />
          ),
        },
        {
          label: "类型",
          content: (
            <ChipGroup
              name="kind"
              label="类型"
              picked={filters.kinds}
              choices={Object.entries(PROGRAM_KINDS).map(([value, { label, color }]) => ({
                value,
                label,
                color,
              }))}
            />
          ),
        },
        {
          label: "层次",
          content: (
            <ChipGroup name="tier" label="层次" picked={filters.tiers} choices={TIER_FILTERS} />
          ),
        },
      ]}
      active={narrowed || filters.sort === "published" || cohort !== current}
      clear={narrowed || filters.q ? keepOnly(search, ["cohort", "per_page"]) : null}
    />
  );
}

// The programs grouped by the day their applications close, as the notice wrote it: a deadline
// given only as a month, such as 6月下旬, is a group of its own, since the page never shows the
// instant worked out for sorting (design §8.2). Sorted by publication, they group by that day.
type Day = { key: string; label: string; weekday: string | null; days: number | null };

const weekdays = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" });

function dayOf(program: Program, sort: Filters["sort"], now: number, thisYear: number): Day {
  if (sort === "published") {
    const date = program.notice.published_on;
    return date
      ? { key: date, label: `${formatTime({ date }, thisYear)} 发布`, weekday: null, days: null }
      : { key: "", label: "发布日期未注明", weekday: null, days: null };
  }
  const end = program.apply?.end;
  if (!end) return { key: "", label: "截止时间未注明", weekday: null, days: null };
  if ("month" in end) {
    return {
      key: end.month + (end.part ?? ""),
      label: formatTime(end, thisYear),
      weekday: null,
      days: null,
    };
  }
  if ("mark" in end && end.mark) {
    return {
      key: end.date + end.mark,
      label: formatTime(end, thisYear),
      weekday: null,
      days: null,
    };
  }
  const at = Date.parse(end.date);
  return {
    key: end.date,
    label: formatTime({ date: end.date }, thisYear),
    weekday: weekdays.format(at),
    days: Math.round((at - Date.parse(beijingDate(now))) / 86_400_000),
  };
}

function groupsOf(programs: Program[], sort: Filters["sort"], now: number, thisYear: number) {
  const groups: { day: Day; programs: Program[] }[] = [];
  for (const program of programs) {
    const day = dayOf(program, sort, now, thisYear);
    const last = groups.at(-1);
    if (last?.day.key === day.key) last.programs.push(program);
    else groups.push({ day, programs: [program] });
  }
  return groups;
}

// How far the day is from today, by the calendar; the countdown on a program's page is by the
// hour instead.
const RELATIVE: Partial<Record<number, string>> = { [-1]: "昨天", 0: "今天", 1: "明天", 2: "后天" };

function DayLabel({ day }: { day: Day }) {
  const soon = day.days !== null && day.days >= 0 && day.days <= 3;
  return (
    <div className="flex items-baseline justify-between gap-3 lg:block">
      <p className="flex items-baseline gap-2 lg:block">
        <span className="text-lg font-semibold tracking-tight tabular-nums">{day.label}</span>
        {day.weekday && (
          <span className="text-sm text-muted-foreground lg:mt-0.5 lg:block">{day.weekday}</span>
        )}
      </p>
      {day.days !== null && (
        <p
          className={cn(
            "text-[13px] lg:mt-1.5",
            soon ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {RELATIVE[day.days] ?? (day.days < 0 ? `${-day.days} 天前` : `${day.days} 天后`)}
        </p>
      )}
    </div>
  );
}

// Under a deadline day: when on that day, or when the program opens if it hasn't yet.
function When({
  program,
  sort,
  thisYear,
  now,
}: {
  program: Program;
  sort: Filters["sort"];
  thisYear: number;
  now: number;
}) {
  const { start, end, rolling } = program.apply ?? {};
  if (statusOf(program, now) === "upcoming" && start) return `${formatTime(start, thisYear)} 开始`;
  if (sort === "published")
    return end ? `${formatTime(end, thisYear)} 截止` : rolling ? "额满即止" : null;
  if (end && "time" in end) return rolling ? `${end.time} 截止或额满即止` : `${end.time} 截止`;
  return rolling ? "额满即止" : null;
}

function Agenda({
  programs,
  sort,
  now,
  thisYear,
}: {
  programs: Program[];
  sort: Filters["sort"];
  now: number;
  thisYear: number;
}) {
  return (
    <div className="space-y-6">
      {groupsOf(programs, sort, now, thisYear).map((group) => (
        <Group key={group.day.key} label={<DayLabel day={group.day} />}>
          <List>
            {group.programs.map((program) => (
              <Row
                key={program.id}
                title={
                  <>
                    <Link
                      to={`/programs/${program.id}`}
                      className="text-[15px] font-medium text-pretty hover:text-primary"
                    >
                      {program.name}
                    </Link>
                    <KindTag kind={program.kind} />
                  </>
                }
                meta={
                  <>
                    <span className="text-foreground/85">{program.school.name}</span>
                    <Link to={`/colleges/${program.college.id}`} className="hover:text-primary">
                      {program.college.name}
                    </Link>
                    <span>{program.college.region}</span>
                    <TopTier tiers={program.school.tiers} />
                    <a
                      href={program.notice.url}
                      target="_blank"
                      rel="nofollow noopener"
                      className="inline-flex items-center gap-0.5 hover:text-primary"
                    >
                      原文
                      <ExternalLink className="size-3" />
                    </a>
                  </>
                }
                side={
                  // Most of the list is open; only the others say so.
                  statusOf(program, now) !== "open" && <StatusTag status={statusOf(program, now)} />
                }
                sideMeta={<When program={program} sort={sort} thisYear={thisYear} now={now} />}
              />
            ))}
          </List>
        </Group>
      ))}
    </div>
  );
}
