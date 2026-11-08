import { hc, type InferResponseType } from "hono/client";
import { data, Link, useLocation, useRouteLoaderData } from "react-router";
import { cn } from "~/cn";
import { ExternalLink } from "~/components/icons";
import {
  ApplyDeadline,
  ApplyStart,
  Countdown,
  SOON_SECONDS,
  WindowBar,
} from "~/components/program";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { KindTag, PROGRAM_KINDS, StatusTag, TIER_FILTERS, TierTags } from "~/components/tags";
import { buttonVariants } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import { Table, Td, Th, Tr } from "~/components/ui/table";
import type { ApiType } from "../../server/app.ts";
import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { cohortOf, tablePage } from "../program-table.ts";
import type { loader as rootLoader } from "../root.tsx";
import { currentCohort, STATUS_LABELS, statusOf, useNow } from "../time.ts";
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
    <Page
      title={`${cohort} 届保研项目`}
      description="报名时间以通知原文为准，状态与倒计时按当前时间计算。"
      hero={<Soonest programs={loaderData.soonest} now={now} thisYear={loaderData.thisYear} />}
    >
      {preview ? <PreviewNotice /> : <Filters data={loaderData} />}
      {programs.length === 0 ? (
        <Empty>
          {preview ? "目前没有即将截止的项目。" : "没有符合条件的项目，请调整筛选条件。"}
        </Empty>
      ) : (
        <div>
          <ProgramTable programs={programs} now={now} thisYear={loaderData.thisYear} />
          <ProgramCards programs={programs} now={now} thisYear={loaderData.thisYear} />
          {!preview && <Pagination total={total} page={page} perPage={filters.perPage} />}
        </div>
      )}
    </Page>
  );
}

// The next deadlines of the cohort, counting down in the band at the top.
function Soonest({
  programs,
  now,
  thisYear,
}: {
  programs: Program[];
  now: number;
  thisYear: number;
}) {
  if (programs.length === 0) return null;
  return (
    <section aria-labelledby="soonest">
      <h2 id="soonest" className="mb-3 text-sm font-medium text-muted-foreground">
        即将截止
      </h2>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4 [&::-webkit-scrollbar]:hidden">
        {programs.map((program) => {
          // Only open programs with a deadline are here.
          const left = Math.max(0, (program.apply_deadline ?? now) - now);
          return (
            <li key={program.id} className="w-64 shrink-0 snap-start sm:w-auto">
              <Link
                to={`/programs/${program.id}`}
                className="group flex h-full flex-col rounded-xl border bg-card p-4 hover:border-input hover:bg-accent"
              >
                <span className="text-xs text-muted-foreground">距报名截止</span>
                <TimeLeft seconds={left} soon={left < SOON_SECONDS} />
                <span aria-hidden="true" className="my-3 border-t border-dashed" />
                <span className="text-xs text-muted-foreground">
                  {program.school.name} {program.college.name}
                </span>
                <span className="mt-1 line-clamp-2 text-sm font-medium">{program.name}</span>
                <span className="mt-auto pt-2 text-xs text-muted-foreground tabular-nums">
                  截止于 <ApplyDeadline apply={program.apply} thisYear={thisYear} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Large digits with small units: days and hours, or hours and minutes on the last day.
function TimeLeft({ seconds, soon }: { seconds: number; soon: boolean }) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: [number, string][] =
    days > 0
      ? [
          [days, "天"],
          [hours, "小时"],
        ]
      : [
          [hours, "小时"],
          [minutes, "分钟"],
        ];
  return (
    <span
      className={cn("mt-1 flex items-baseline gap-1", soon ? "text-destructive" : "text-signal")}
    >
      {parts.map(([value, unit]) => (
        <span key={unit} className="mr-1.5 flex items-baseline gap-0.5">
          <span className="text-[2rem] leading-none font-bold tracking-tight tabular-nums">
            {value}
          </span>
          <span className="text-[13px]">{unit}</span>
        </span>
      ))}
    </span>
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
          ? "账号已冻结，仅显示截止时间最近的项目。"
          : "未登录时仅显示截止时间最近的项目。登录后可查看本届全部项目，并使用搜索与筛选。"}
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
  const filtered =
    filters.q ||
    filters.status ||
    filters.kinds.length + filters.tiers.length > 0 ||
    filters.region ||
    filters.direction;
  const statusChoices = [
    { value: "", label: "未截止" },
    { value: "open", label: STATUS_LABELS.open },
    { value: "upcoming", label: STATUS_LABELS.upcoming },
    { value: "closed", label: STATUS_LABELS.closed },
    { value: "all", label: "全部" },
  ];
  return (
    <FilterBar
      top={
        <>
          <SearchBox value={filters.q} placeholder="搜索学校、学院或项目名称" />
          <div className="grid flex-[1_1_100%] grid-cols-2 gap-2 sm:flex sm:flex-none">
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
          </div>
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
      clear={filtered ? keepOnly(search, ["cohort", "per_page"]) : null}
    />
  );
}

function OriginalLink({ program, className }: { program: Program; className?: string }) {
  return (
    <a
      href={program.notice.url}
      target="_blank"
      rel="nofollow noopener"
      className={cn("link inline-flex items-center gap-1", className)}
    >
      原文
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function ProgramTable({
  programs,
  now,
  thisYear,
}: {
  programs: Program[];
  now: number;
  thisYear: number;
}) {
  return (
    <div className="max-lg:hidden">
      <Table>
        <thead>
          <tr>
            <Th>院校</Th>
            <Th>项目</Th>
            <Th className="w-px">类型</Th>
            <Th className="w-px">报名开始</Th>
            <Th className="w-px">报名截止</Th>
            <Th className="w-px">状态</Th>
            <Th className="w-px">原文</Th>
          </tr>
        </thead>
        <tbody>
          {programs.map((program) => (
            <Tr key={program.id}>
              <Td>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{program.school.name}</span>
                  <TierTags tiers={program.school.tiers} />
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  <Link to={`/colleges/${program.college.id}`} className="hover:text-primary">
                    {program.college.name}
                  </Link>
                  <span className="ml-2">{program.college.region}</span>
                </p>
              </Td>
              <Td center>
                <Link
                  to={`/programs/${program.id}`}
                  className="font-medium text-pretty hover:text-primary"
                >
                  {program.name}
                </Link>
              </Td>
              <Td center className="whitespace-nowrap">
                <KindTag kind={program.kind} />
              </Td>
              <Td center className="whitespace-nowrap tabular-nums">
                <ApplyStart apply={program.apply} thisYear={thisYear} />
              </Td>
              <Td center className="whitespace-nowrap tabular-nums">
                <ApplyDeadline apply={program.apply} thisYear={thisYear} />
              </Td>
              <Td center className="whitespace-nowrap">
                <div className="flex flex-col items-center gap-1">
                  <StatusTag status={statusOf(program, now)} />
                  <Countdown program={program} now={now} />
                  <WindowBar program={program} now={now} />
                </div>
              </Td>
              <Td center className="whitespace-nowrap">
                <OriginalLink program={program} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

// Phones and narrow windows: each program as a block, its dates side by side.
function ProgramCards({
  programs,
  now,
  thisYear,
}: {
  programs: Program[];
  now: number;
  thisYear: number;
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card lg:hidden">
      {programs.map((program) => (
        <li key={program.id} className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link to={`/programs/${program.id}`} className="font-medium hover:text-primary">
                {program.name}
              </Link>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {program.school.name}
                <Link to={`/colleges/${program.college.id}`} className="ml-2 hover:text-primary">
                  {program.college.name}
                </Link>
                <span className="ml-2">{program.college.region}</span>
              </p>
            </div>
            <StatusTag status={statusOf(program, now)} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <KindTag kind={program.kind} />
            <TierTags tiers={program.school.tiers} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 rounded-md bg-muted/60 px-3 py-2 text-[13px] tabular-nums">
            <div>
              <dt className="text-xs text-muted-foreground">报名开始</dt>
              <dd className="mt-0.5">
                <ApplyStart apply={program.apply} thisYear={thisYear} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">报名截止</dt>
              <dd className="mt-0.5">
                <ApplyDeadline apply={program.apply} thisYear={thisYear} />
              </dd>
            </div>
          </dl>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Countdown program={program} now={now} />
              <WindowBar program={program} now={now} />
            </span>
            <OriginalLink program={program} className="ml-auto text-[13px]" />
          </div>
        </li>
      ))}
    </ul>
  );
}
