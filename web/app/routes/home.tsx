import { hc, type InferResponseType } from "hono/client";
import { data, Link, useLocation, useRouteLoaderData } from "react-router";
import { ExternalLink } from "~/components/icons";
import { List, Row } from "~/components/list";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { ApplyDeadline, ApplyStart, Missing, ProgramStatus } from "~/components/program";
import { KindTag, PROGRAM_KINDS, TopTier } from "~/components/tags";
import { TIER_FILTERS } from "~/tiers";
import { buttonVariants } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import { Table, Td, Th, Tr } from "~/components/ui/table";
import type { ApiType } from "../../server/app.ts";
import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { cohortOf, tablePage, type Filters } from "../program-table.ts";
import type { loader as rootLoader } from "../root.tsx";
import { currentCohort, formatTime, STATUS_LABELS, useNow } from "../time.ts";
import type { Route } from "./+types/home.ts";

type TableData = InferResponseType<ReturnType<typeof createApi>["programs"]["$get"], 200>;
type Program = TableData["programs"][number];

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

// The server renders the page of the table the address asks for; the cohort itself stays on
// the server, so the first screen doesn't wait for it (design §14).
export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const date = new Date();
  const table = await readApi<TableData>(
    await context.get(apiContext).programs.$get({ query: { cohort: cohortOf(params, date) } }),
  );
  return tablePage(table, params, date);
}

// After that the browser keeps the whole cohort, and filters, sorts and pages it itself. It asks
// again for another cohort or after a while; the server answers 304 while nothing changed.
let kept: { cohort: string; at: number; table: TableData } | null = null;
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
          <ProgramTable
            programs={programs}
            sort={filters.sort}
            now={now}
            thisYear={loaderData.thisYear}
          />
          <ProgramList
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

// Wide screens: one program to a row and one thing to a cell, so each column reads straight
// down. Sorted by publication, the date it was published comes in as well.
function ProgramTable({ programs, sort, now, thisYear }: ListProps) {
  return (
    <Table className="max-lg:hidden">
      <thead>
        <tr>
          <Th>学校</Th>
          <Th>学院</Th>
          <Th>项目</Th>
          <Th>类型</Th>
          {sort === "published" && <Th>发布日期</Th>}
          <Th>报名开始</Th>
          <Th>报名截止</Th>
          <Th>状态</Th>
          <Th>原文</Th>
        </tr>
      </thead>
      <tbody>
        {programs.map((program) => (
          <Tr key={program.id}>
            <Td>
              <span className="flex items-center gap-2 whitespace-nowrap">
                <span className="font-medium">{program.school.name}</span>
                <TopTier tiers={program.school.tiers} />
              </span>
            </Td>
            <Td>
              <Link to={`/colleges/${program.college.id}`} className="hover:text-primary">
                {program.college.name}
              </Link>
            </Td>
            <Td className="text-center">
              <Link
                to={`/programs/${program.id}`}
                className="font-medium text-pretty hover:text-primary"
              >
                {program.name}
              </Link>
            </Td>
            <Td center>
              <KindTag kind={program.kind} />
            </Td>
            {sort === "published" && (
              <Td center>
                {program.notice.published_on ? (
                  formatTime({ date: program.notice.published_on }, thisYear)
                ) : (
                  <Missing />
                )}
              </Td>
            )}
            <Td center>
              <ApplyStart apply={program.apply} thisYear={thisYear} />
            </Td>
            <Td center>
              <ApplyDeadline apply={program.apply} thisYear={thisYear} />
            </Td>
            <Td center>
              <ProgramStatus program={program} now={now} />
            </Td>
            <Td center>
              <a
                href={program.notice.url}
                target="_blank"
                rel="nofollow noopener"
                aria-label={`${program.name}的通知原文`}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-primary"
              >
                <ExternalLink />
              </a>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

// Phones: the same programs as a list, two lines each.
function ProgramList({ programs, now, thisYear }: ListProps) {
  return (
    <List className="lg:hidden">
      {programs.map((program) => (
        <Row
          key={program.id}
          title={
            <>
              <Link to={`/programs/${program.id}`} className="font-medium hover:text-primary">
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
              <TopTier tiers={program.school.tiers} />
            </>
          }
          side={<ProgramStatus program={program} now={now} />}
          sideMeta={
            <span className="tabular-nums">
              <ApplyDeadline apply={program.apply} thisYear={thisYear} /> 截止
            </span>
          }
        />
      ))}
    </List>
  );
}

type ListProps = { programs: Program[]; sort: Filters["sort"]; now: number; thisYear: number };
