import type { InferResponseType } from "hono/client";
import { useLocation, useRouteLoaderData } from "react-router";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { ProgramCard, ProgramCards, ProgramPlace } from "~/components/program";
import { Subscribe } from "~/components/subscribe";
import { PROGRAM_KINDS, StageTag } from "~/components/tags";
import { TIER_FILTERS } from "~/tiers";
import { buttonVariants } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { MultiSelect, Select } from "~/components/ui/select";
import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { cohortOf, tablePage } from "../program-table.ts";
import { keptTable, stagesOf, subscribedTo } from "../table-cache.ts";
import type { loader as rootLoader } from "../root.tsx";
import { currentCohort, STATUS_LABELS, useNow } from "../time.ts";
import type { Route } from "./+types/home.ts";

type TableData = InferResponseType<ReturnType<typeof createApi>["programs"]["$get"], 200>;

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

// The server renders the page of the table the address asks for; the cohort itself stays on
// the server, so the first screen doesn't wait for it (design §14).
export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const date = new Date();
  const api = context.get(apiContext);
  const [table, subscribed, stages] = await Promise.all([
    api.programs.$get({ query: { cohort: cohortOf(params, date) } }).then(readApi<TableData>),
    subscribedTo(api),
    stagesOf(api),
  ]);
  return { ...tablePage(table, params, date), subscribed, stages };
}

// After that the browser keeps the whole cohort (table-cache.ts).
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const params = new URL(request.url).searchParams;
  const date = new Date();
  const { table, subscribed, stages } = await keptTable(cohortOf(params, date), date.getTime());
  return { ...tablePage(table, params, date), subscribed, stages };
}

type Data = Route.ComponentProps["loaderData"];

export default function Home({ loaderData }: Route.ComponentProps) {
  const { cohort, preview, programs, total, page, filters, thisYear } = loaderData;
  const now = useNow(loaderData.now);
  const subscribed = new Set(loaderData.subscribed);
  const { stages } = loaderData;
  return (
    <Page title={`${cohort} 届保研项目`} hideTitle>
      {preview ? <PreviewNotice /> : <Filters data={loaderData} />}
      {programs.length === 0 ? (
        <Empty>{preview ? "目前没有即将截止的项目" : "没有符合条件的项目"}</Empty>
      ) : (
        <div>
          <ProgramCards>
            {programs.map((program) => (
              <ProgramCard
                key={program.id}
                program={program}
                now={now}
                thisYear={thisYear}
                notice={program.notice.url}
                place={
                  <ProgramPlace
                    program={program}
                    published={filters.sort === "published"}
                    thisYear={thisYear}
                  />
                }
                stage={program.id in stages && <StageTag stage={stages[program.id]} />}
                subscribe={<Subscribe program={program} subscribed={subscribed.has(program.id)} />}
              />
            ))}
          </ProgramCards>
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

function Filters({
  data: { filters, regions, directions, tags, counts, now, cohort },
}: {
  data: Data;
}) {
  const { search } = useLocation();
  const { hrefWith, set } = useFilters();
  const current = currentCohort(new Date(now * 1000));
  const cohorts = [current + 1, current, current - 1, current - 2];
  // What 清除筛选 clears besides the search; the cohort and the order stay.
  const narrowed =
    filters.status !== null ||
    filters.kinds.length +
      filters.tiers.length +
      filters.regions.length +
      filters.directions.length +
      filters.tags.length >
      0;
  const statusChoices = [
    { value: "", label: "未截止" },
    { value: "open", label: STATUS_LABELS.open },
    { value: "upcoming", label: STATUS_LABELS.upcoming },
    { value: "closed", label: STATUS_LABELS.closed },
    { value: "all", label: "全部" },
  ];
  return (
    <FilterBar
      search={<SearchBox value={filters.q} placeholder="搜索学校、学院或项目" />}
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
          <MultiSelect
            aria-label="地区"
            all="全部地区"
            picked={filters.regions}
            onPickedChange={(values) => set("region", values)}
            options={regions.map((r) => ({ value: r, label: r, count: counts.region[r] ?? 0 }))}
            className="sm:w-36"
          />
          <MultiSelect
            aria-label="方向"
            all="全部方向"
            picked={filters.directions}
            onPickedChange={(values) => set("direction", values)}
            options={directions.map((d) => ({
              value: d,
              label: d,
              count: counts.direction[d] ?? 0,
            }))}
            className="sm:w-36"
          />
          <MultiSelect
            aria-label="学院标签"
            all="全部标签"
            picked={filters.tags}
            onPickedChange={(values) => set("tag", values)}
            options={tags.map((t) => ({ value: t, label: t, count: counts.tag[t] ?? 0 }))}
            className="sm:w-36"
          />
          <Select
            aria-label="排序"
            value={filters.sort === "deadline" ? "" : filters.sort}
            onValueChange={(value) => set("sort", value)}
            options={[
              { value: "", label: "按截止时间" },
              { value: "published", label: "按发布时间" },
              { value: "subscribers", label: "按订阅人数" },
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
                count: counts.status[choice.value],
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
              counts={counts.kind}
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
            <ChipGroup
              name="tier"
              label="层次"
              picked={filters.tiers}
              choices={TIER_FILTERS}
              counts={counts.tier}
            />
          ),
        },
      ]}
      active={narrowed || filters.sort !== "deadline" || cohort !== current}
      clear={narrowed || filters.q ? keepOnly(search, ["cohort", "per_page"]) : null}
    />
  );
}
