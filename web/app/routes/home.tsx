import type { InferResponseType } from "hono/client";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import { cn } from "~/cn";
import { buttonVariants } from "~/components/ui/button";
import { SITE_DESCRIPTION, SITE_NAME } from "../../server/platform/site.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { loader as rootLoader } from "../root.tsx";
import { linkClass, PROGRAM_KINDS, TIERS } from "../components/admin.tsx";
import {
  beijingYear,
  countdown,
  currentCohort,
  formatApply,
  STATUS_LABELS,
  statusOf,
  useNow,
  type Status,
} from "../time.ts";
import type { Route } from "./+types/home.ts";

type Table = InferResponseType<ReturnType<typeof createApi>["programs"]["$get"], 200>;
type Program = Table["programs"][number];

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const now = new Date();
  const cohort = new URL(request.url).searchParams.get("cohort") ?? String(currentCohort(now));
  const table = await readApi<Table>(
    await context.get(apiContext).programs.$get({ query: { cohort } }),
  );
  return {
    ...table,
    cohort: Number(cohort),
    thisYear: beijingYear(now),
    now: Math.floor(now.getTime() / 1000),
  };
}

// Phones stack a program's lines beside its status; wider screens line them up under a header,
// as mousehole's thread list does.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-3 sm:px-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_6.5rem_2.5rem]";

const STATUS_COLORS: Record<Status, string> = {
  upcoming: "text-link",
  open: "text-success",
  closed: "text-muted-foreground",
};

// Within this long of the deadline the countdown stands out: reminders go out three days before
// (design §11).
const SOON_SECONDS = 3 * 86_400;

export default function Home({ loaderData }: Route.ComponentProps) {
  const { cohort, preview, programs, thisYear } = loaderData;
  const now = useNow(loaderData.now);
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-3 py-6 sm:px-5">
      <header>
        <h1 className="text-2xl font-semibold">{cohort} 届的保研项目</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          按报名截止时间排列，时间照通知原文；以原文为准。
        </p>
      </header>
      {preview && <PreviewNotice />}
      {programs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {preview ? "现在没有快截止的项目。" : "这一届还没有收录项目。"}
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
          : "没登录只能看截止最近的几个项目，登录后能看这一届的全部。"}
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

function Row({ program, now, thisYear }: { program: Program; now: number; thisYear: number }) {
  const { school, college } = program;
  const status = statusOf(program, now);
  const left = countdown(program, now);
  const soon =
    status === "open" &&
    program.apply_deadline !== null &&
    program.apply_deadline - now < SOON_SECONDS;
  const tiers = school.tiers.map((tier) => TIERS.find((item) => item.value === tier)?.label);
  return (
    <li
      className={cn(
        COLUMNS,
        "items-start border-b border-border/70 py-3.5 text-sm last:border-b-0 md:items-center",
      )}
    >
      <div className="min-w-0 max-md:col-start-1">
        <p className="font-medium">
          {school.name}
          {tiers.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {tiers.join(" · ")}
            </span>
          )}
        </p>
        <p className="mt-0.5">
          <Link to={`/colleges/${college.id}`} className={linkClass}>
            {college.name}
          </Link>
          <span className="text-muted-foreground"> · {college.region}</span>
        </p>
      </div>
      <div className="min-w-0 max-md:col-start-1 max-md:mt-1.5">
        <p className="text-pretty">{program.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{PROGRAM_KINDS[program.kind]}</p>
      </div>
      <p className="max-md:col-start-1 max-md:mt-1.5">
        <span className="text-muted-foreground md:hidden">报名：</span>
        {formatApply(program.apply, thisYear)}
      </p>
      <div className="flex flex-col items-end gap-1 max-md:col-start-2 max-md:row-span-2 max-md:row-start-1 md:items-start">
        <span
          className={cn(
            "rounded-full bg-secondary px-2.5 py-1 text-xs",
            status && STATUS_COLORS[status],
          )}
        >
          {status ? STATUS_LABELS[status] : "未说明"}
        </span>
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
