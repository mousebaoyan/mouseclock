import type { InferResponseType } from "hono/client";
import { Link, useLocation } from "react-router";
import { ApplicationForm } from "~/components/application";
import { Empty } from "~/components/page";
import { ProgramPlace, ProgramStatus } from "~/components/program";
import { Chip, KindTag, STAGES } from "~/components/tags";
import { DateTime } from "~/components/time";
import { Stage } from "../../server/modules/programs/schemas.ts";
import { beijingYear } from "../../server/modules/programs/time.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { formatApply, useNow } from "../time.ts";
import type { Route } from "./+types/me-applications.ts";

type Applications = InferResponseType<
  ReturnType<typeof createApi>["me"]["applications"]["$get"],
  200
>;

export function meta() {
  return [{ title: "报名 · 我的 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // An unknown stage in the address shows them all.
  const stage = Stage.safeParse(new URL(request.url).searchParams.get("stage")).data;
  const applications = await readApi<Applications>(
    await context.get(apiContext).me.applications.$get({ query: stage ? { stage } : {} }),
  );
  return {
    ...applications,
    stage: stage ?? null,
    thisYear: beijingYear(new Date()),
    now: Math.floor(Date.now() / 1000),
  };
}

// One's records of applying (design §9.4), by stage, the open programs by deadline first; each
// changed or cleared where it is.
export default function MeApplications({ loaderData }: Route.ComponentProps) {
  const { applications, counts, stage, thisYear } = loaderData;
  const now = useNow(loaderData.now);
  const { pathname, search } = useLocation();
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  return (
    <div className="space-y-4">
      <fieldset className="flex min-w-0 flex-wrap gap-2">
        <legend className="sr-only">进度</legend>
        <Chip to="?" on={stage === null} color="gray" count={total}>
          全部
        </Chip>
        {counts.map((c) => (
          <Chip
            key={c.stage}
            to={`?stage=${c.stage}`}
            on={stage === c.stage}
            color={STAGES[c.stage].color}
            count={c.count}
          >
            {STAGES[c.stage].label}
          </Chip>
        ))}
      </fieldset>
      {applications.length === 0 ? (
        <Empty>
          {total === 0 ? "还没有记过报名，在项目页上点「记报名」" : "没有这个进度的报名"}
        </Empty>
      ) : (
        <ul className="space-y-3">
          {applications.map(({ program, ...application }) => (
            <li
              key={program.id}
              className="space-y-3 rounded-xl border bg-card px-4 py-3.5 shadow-card sm:px-5 sm:py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <ProgramPlace program={program} thisYear={thisYear} />
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <ProgramStatus program={program} now={now} />
                  <KindTag kind={program.kind} />
                </div>
              </div>
              <div>
                <Link
                  to={`/programs/${program.id}`}
                  className="text-[15px] leading-snug font-semibold text-pretty hover:text-primary"
                >
                  {program.name}
                </Link>
                <p className="mt-1 text-[13px] text-muted-foreground tabular-nums">
                  {program.apply && <>报名 {formatApply(program.apply, thisYear)} · </>}
                  上次修改 <DateTime value={application.updated_at} />
                </p>
              </div>
              {/* Kept afresh once saved, from what was saved. */}
              <ApplicationForm
                key={application.updated_at}
                programId={program.id}
                application={application}
                next={pathname + search}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
