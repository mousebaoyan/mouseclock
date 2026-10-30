import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { ApplyValue, Role } from "../../server/modules/programs/schemas.ts";
import { formatWindow, beijingYear, STATUS_LABELS } from "../time.ts";
import type { Route } from "./+types/college-detail.ts";

type CollegeDetail = InferResponseType<
  ReturnType<typeof createApi>["colleges"][":id"]["$get"],
  200
>;

const KIND_LABELS: Record<string, string> = {
  winter_camp: "冬令营",
  summer_camp: "夏令营",
  pre_recommendation: "预推免",
  september_round: "九推",
};
const NOTICE_ROLE_LABELS: Record<Role, string> = {
  call: "报名通知",
  update: "补充通知",
  result: "结果通知",
};
const COLLEGE_KIND_LABELS: Record<string, string> = {
  college: "学院",
  institute: "研究所",
  graduate_school: "研究生院",
};

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
  return { college, thisYear: beijingYear(new Date()) };
}

function applyText(apply: ApplyValue | null, year: number) {
  if (!apply) return "未说明";
  const window = formatWindow(apply, year);
  if (window) return apply.rolling ? `${window}（额满即止）` : window;
  return apply.rolling ? "额满即止" : "未说明";
}

export default function CollegeDetail({ loaderData }: Route.ComponentProps) {
  const { college, thisYear } = loaderData;
  const { school } = college;
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
          {COLLEGE_KIND_LABELS[college.kind] ?? college.kind} · {college.region}
          {college.directions.length > 0 && ` · ${college.directions.join("、")}`}
        </p>
      </header>
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="text-lg font-semibold">学院通知栏目</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          学院发布通知的栏目入口，具体项目的原文见下方。
        </p>
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
                {group.programs.map((program) => (
                  <li key={program.id} className="py-4 first:pt-3 last:pb-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{program.name}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {KIND_LABELS[program.kind] ?? program.kind}
                        </p>
                      </div>
                      <span className="rounded-full bg-secondary px-2.5 py-1 text-xs">
                        {program.status ? STATUS_LABELS[program.status] : "未说明"}
                      </span>
                    </div>
                    <div className="mt-3 text-sm">
                      <p className="text-muted-foreground">原文出处</p>
                      {program.notices.length > 0 ? (
                        <ul className="mt-1 space-y-2">
                          {program.notices.map((notice) => (
                            <li
                              key={notice.id}
                              className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                            >
                              <span className="text-xs text-muted-foreground">
                                {NOTICE_ROLE_LABELS[notice.role]}
                              </span>
                              <a
                                href={notice.url}
                                target="_blank"
                                rel="nofollow noopener"
                                className="min-w-0 break-words text-link underline-offset-4 hover:underline"
                              >
                                {notice.title}
                              </a>
                              {notice.removed && (
                                <span className="text-xs text-warning">原文已删除</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-muted-foreground">暂无原文链接。</p>
                      )}
                    </div>
                    <p className="mt-3 text-sm">
                      <span className="text-muted-foreground">报名时间：</span>
                      {applyText(program.apply, thisYear)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </main>
  );
}
