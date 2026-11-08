import { hc, type InferResponseType } from "hono/client";
import { useState, type FormEvent, type ReactNode } from "react";
import { data, Link, useLocation, useNavigate, useRouteLoaderData } from "react-router";
import { cn } from "~/cn";
import { linkClass, inputClass } from "~/components/admin";
import { Pagination } from "~/components/pagination";
import {
  Chip,
  KindTag,
  PROGRAM_KINDS,
  STATUS_COLORS,
  StatusTag,
  TierTags,
  TIERS,
} from "~/components/tags";
import { Button, buttonVariants } from "~/components/ui/button";
import type { ApiType } from "../../server/app.ts";
import { PER_PAGE } from "../../server/platform/paging.ts";
import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { cohortOf, readFilters, tablePage } from "../program-table.ts";
import type { loader as rootLoader } from "../root.tsx";
import { countdown, currentCohort, formatApply, STATUS_LABELS, statusOf, useNow } from "../time.ts";
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

// Phones stack a program's lines beside its status; wider screens line them up under a header,
// as mousehole's thread list does.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-3 sm:px-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_6.5rem_2.5rem]";

// Within this long of the deadline the countdown stands out: reminders go out three days before
// (design §11).
const SOON_SECONDS = 3 * 86_400;

export default function Home({ loaderData }: Route.ComponentProps) {
  const { cohort, preview, programs, total, page, filters, thisYear } = loaderData;
  const now = useNow(loaderData.now);
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-3 py-6 sm:px-5">
      <header>
        <h1 className="text-2xl font-semibold">{cohort} 届的保研项目</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          报名时间照通知原文，以原文为准；状态和倒计时按现在的时间算。
        </p>
      </header>
      {preview ? (
        <PreviewNotice />
      ) : (
        <FilterForm
          regions={loaderData.regions}
          directions={loaderData.directions}
          now={loaderData.now}
        />
      )}
      {programs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {preview ? "现在没有快截止的项目。" : "没有符合条件的项目。"}
        </p>
      ) : (
        <div>
          <div
            aria-hidden="true"
            className={cn(COLUMNS, "border-b pb-2 text-xs text-muted-foreground max-md:hidden")}
          >
            <span>学校和学院</span>
            <span>项目</span>
            <span>报名时间</span>
            <span>状态</span>
            <span>原文</span>
          </div>
          <ul>
            {programs.map((program) => (
              <Row key={program.id} program={program} now={now} thisYear={thisYear} />
            ))}
          </ul>
          {!preview && <Pagination total={total} page={page} perPage={filters.perPage} />}
        </div>
      )}
    </main>
  );
}

// A preview goes to guests and to frozen accounts, who are signed in but no longer in the group.
function PreviewNotice() {
  const { pathname, search } = useLocation();
  const signedIn = Boolean(useRouteLoaderData<typeof rootLoader>("root")?.me);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/8 px-3.5 py-2.5 text-sm">
      <p className="min-w-0 flex-1">
        {signedIn
          ? "账号已冻结，只能看截止最近的几个项目。"
          : "没登录只能看截止最近的几个项目，登录后能看这一届的全部，还能筛选和搜索。"}
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

const STATUS_CHIPS = [
  { value: "", label: "未截止", color: "teal" },
  { value: "open", label: STATUS_LABELS.open, color: STATUS_COLORS.open },
  { value: "upcoming", label: STATUS_LABELS.upcoming, color: STATUS_COLORS.upcoming },
  { value: "closed", label: STATUS_LABELS.closed, color: STATUS_COLORS.closed },
  { value: "all", label: "全部", color: "gray" },
] as const;

// A plain GET form, so it works before scripts load; with them, every change applies at once.
// Defaults are left out of the address, and changing a filter goes back to the first page.
function FilterForm({
  regions,
  directions,
  now,
}: {
  regions: string[];
  directions: string[];
  now: number;
}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  // The form keeps what is ticked and typed into it, and its defaults stay those of the address
  // it was opened at: React changing a default under a ticked radio button unticks it. When the
  // address changes some other way, such as a page link or the nav's link back to the table, the
  // form starts again from the new address.
  const [seen, setSeen] = useState(search);
  // The address the form is navigating to, until it arrives.
  const [applying, setApplying] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(search);
  if (search !== seen) {
    setSeen(search);
    if (search === applying) setApplying(null);
    else setFormKey(search);
  }
  const opened = new URLSearchParams(formKey);
  const filters = readFilters(opened);
  const cohort = Number(cohortOf(opened, new Date(now * 1000)));
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value !== "") params.append(name, value);
    }
    const next = params.size > 0 ? `?${params}` : "";
    if (next === search) return;
    setApplying(next);
    void navigate({ search: next }, { replace: true, preventScrollReset: true });
  }
  // The address with a filter set to `values`, back on the first page.
  function hrefWith(name: string, values: string[]) {
    const params = new URLSearchParams(search);
    params.delete("page");
    params.delete(name);
    for (const value of values) params.append(name, value);
    return params.size > 0 ? `?${params}` : "/";
  }
  const current = currentCohort(new Date(now * 1000));
  const cohorts = [current + 1, current, current - 1, current - 2];
  return (
    <form
      key={formKey}
      method="get"
      onChange={apply}
      onSubmit={apply}
      className="space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4"
    >
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="搜学校、学院或项目"
          aria-label="搜索"
          className={cn(inputClass, "min-w-0 flex-1 basis-48")}
        />
        <select
          name="cohort"
          defaultValue={String(cohort)}
          aria-label="届"
          className={cn(inputClass, "w-auto")}
        >
          {(cohorts.includes(cohort) ? cohorts : [cohort, ...cohorts]).map((c) => (
            <option key={c} value={c}>
              {c} 届
            </option>
          ))}
        </select>
        <select
          name="sort"
          defaultValue={filters.sort === "published" ? "published" : ""}
          aria-label="排序"
          className={cn(inputClass, "w-auto")}
        >
          <option value="">按截止时间</option>
          <option value="published">按发布时间</option>
        </select>
      </div>
      <FilterRow label="状态">
        {STATUS_CHIPS.map((chip) => (
          <Chip
            key={chip.value}
            to={hrefWith("status", chip.value ? [chip.value] : [])}
            on={(filters.status ?? "") === chip.value}
            color={chip.color}
          >
            {chip.label}
          </Chip>
        ))}
      </FilterRow>
      <FilterRow label="类型">
        {Object.entries(PROGRAM_KINDS).map(([kind, { label, color }]) => (
          <Chip
            key={kind}
            to={hrefWith("kind", toggled(filters.kinds, kind))}
            on={filters.kinds.includes(kind)}
            color={color}
          >
            {label}
          </Chip>
        ))}
      </FilterRow>
      <FilterRow label="层次">
        {TIERS.map((tier) => (
          <Chip
            key={tier.value}
            to={hrefWith("tier", toggled(filters.tiers, tier.value))}
            on={filters.tiers.includes(tier.value)}
            color={tier.color}
          >
            {tier.label}
          </Chip>
        ))}
      </FilterRow>
      <div className="flex flex-wrap gap-2">
        <select
          name="region"
          defaultValue={filters.region ?? ""}
          aria-label="地区"
          className={cn(inputClass, "w-auto")}
        >
          <option value="">全部地区</option>
          {regions.map((region) => (
            <option key={region}>{region}</option>
          ))}
        </select>
        <select
          name="direction"
          defaultValue={filters.direction ?? ""}
          aria-label="方向"
          className={cn(inputClass, "w-auto")}
        >
          <option value="">全部方向</option>
          {directions.map((direction) => (
            <option key={direction}>{direction}</option>
          ))}
        </select>
        {/* Changes apply as they are made; without scripts, they do on pressing this. */}
        <Button type="submit" variant="outline">
          筛选
        </Button>
      </div>
      {/* Set by the links above and the pages below, and kept when the form changes. */}
      {filters.status && <input type="hidden" name="status" value={filters.status} />}
      {filters.kinds.map((kind) => (
        <input key={kind} type="hidden" name="kind" value={kind} />
      ))}
      {filters.tiers.map((tier) => (
        <input key={tier} type="hidden" name="tier" value={tier} />
      ))}
      {filters.perPage !== PER_PAGE[0] && (
        <input type="hidden" name="per_page" value={filters.perPage} />
      )}
    </form>
  );
}

function toggled(values: string[], value: string) {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="mr-1 text-xs text-muted-foreground">
        {label}
      </span>
      {children}
    </fieldset>
  );
}

function Row({ program, now, thisYear }: { program: Program; now: number; thisYear: number }) {
  const { school, college } = program;
  const status = statusOf(program, now);
  const left = countdown(program, now);
  const soon =
    status === "open" &&
    program.apply_deadline !== null &&
    program.apply_deadline - now < SOON_SECONDS;
  return (
    <li
      className={cn(
        COLUMNS,
        "items-start border-b border-border/70 py-3.5 text-sm last:border-b-0 md:items-center",
      )}
    >
      <div className="min-w-0 max-md:col-start-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{school.name}</span>
          <TierTags tiers={school.tiers} />
        </p>
        <p className="mt-1">
          <Link to={`/colleges/${college.id}`} className={linkClass}>
            {college.name}
          </Link>
          <span className="text-muted-foreground"> · {college.region}</span>
        </p>
      </div>
      <div className="min-w-0 max-md:col-start-1 max-md:mt-1.5">
        <p className="text-pretty">{program.name}</p>
        <p className="mt-1">
          <KindTag kind={program.kind} />
        </p>
      </div>
      <p className="max-md:col-start-1 max-md:mt-1.5">
        <span className="text-muted-foreground md:hidden">报名：</span>
        {formatApply(program.apply, thisYear)}
      </p>
      <div className="flex flex-col items-end gap-1 max-md:col-start-2 max-md:row-span-2 max-md:row-start-1 md:items-start">
        <StatusTag status={status} />
        {left && (
          <span
            className={cn(
              "text-xs tabular-nums",
              soon ? "font-medium text-warning" : "text-muted-foreground",
            )}
          >
            {left}
          </span>
        )}
      </div>
      <p className="text-right max-md:col-start-2 max-md:row-start-3 max-md:mt-1.5 md:text-left">
        <a href={program.notice.url} target="_blank" rel="nofollow noopener" className={linkClass}>
          原文
        </a>
      </p>
    </li>
  );
}
