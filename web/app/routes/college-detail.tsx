import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { beijingYear, formatApply, statusOf, useNow } from "../time.ts";
import { KINDS, linkClass } from "../components/admin.tsx";
import { KindTag, StatusTag } from "../components/tags.tsx";
import type { Route } from "./+types/college-detail.ts";

type CollegeDetail = InferResponseType<
  ReturnType<typeof createApi>["colleges"][":id"]["$get"],
  200
>;

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: `${loaderData.college.school.name} · ${loaderData.college.name} · 鼠钟`,
    },
  ];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const college = await readApi<CollegeDetail>(
    await context.get(apiContext).colleges[":id"].$get({ param: { id: params.id } }),
  );
  return { college, thisYear: beijingYear(new Date()), now: Math.floor(Date.now() / 1000) };
}

export default function CollegeDetail({ loaderData }: Route.ComponentProps) {
  const { college, thisYear } = loaderData;
  const { school } = college;
  const now = useNow(loaderData.now);
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-3 py-6 sm:px-5">
      <p className="text-sm">
        <Link to="/colleges" className="text-link underline-offset-4 hover:underline">
          院校清单
        </Link>{" "}
        <span className="text-muted-foreground">/ {college.name}</span>
      </p>
      <header>
        <p className="mb-2 text-sm font-medium text-brand-strong">{school.name}</p>
        <h1 className="text-2xl font-semibold">{college.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {KINDS.find((item) => item.value === college.kind)?.label} · {college.region}
          {college.directions.length > 0 && ` · ${college.directions.join("、")}`}
        </p>
      </header>
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-lg font-semibold">学院通知栏目</h2>
        <p className="mt-1 text-sm text-muted-foreground">学院官网发布招生通知的栏目入口。</p>
        {college.sources.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">还没有接入通知栏目。</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {college.sources.map((source) => (
              <li key={source.id} className="py-3">
                <a
                  href={source.url}
                  target="_blank"
                  rel="nofollow noopener"
                  className="break-all text-link underline-offset-4 hover:underline"
                >
                  {source.section || source.url}
                </a>
                {source.section && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">{source.url}</p>
                )}
                {source.unavailable_reason && (
                  <p className="mt-1 text-sm text-warning">
                    暂时抓不了：{source.unavailable_reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">历年项目</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            报名时间按通知原文显示，状态按当前时间计算。
          </p>
        </div>
        {college.programs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            还没有收录项目。
          </p>
        ) : (
          college.programs.map((group) => (
            <section
              key={group.cohort}
              className="rounded-xl border border-border bg-card p-4 sm:p-5"
            >
              <h3 className="text-base font-semibold">{group.cohort} 届</h3>
              <ul className="mt-3 divide-y divide-border">
                {group.programs.map((program) => {
                  return (
                    <li key={program.id} className="py-4 first:pt-3 last:pb-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <Link
                            to={`/programs/${program.id}`}
                            className={`${linkClass} font-medium`}
                          >
                            {program.name}
                          </Link>
                          <p className="mt-1.5">
                            <KindTag kind={program.kind} />
                          </p>
                        </div>
                        <StatusTag status={statusOf(program, now)} />
                      </div>
                      <p className="mt-3 text-sm">
                        <span className="text-muted-foreground">报名时间：</span>
                        {formatApply(program.apply, thisYear)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </section>
    </main>
  );
}
