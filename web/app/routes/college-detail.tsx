import { data, Link } from "react-router";
import { apiContext } from "../api.server.ts";
import {
  readPublicApi,
  publicCollegeDetailSchema,
  type PublicCollegeDetail,
} from "../colleges.server.ts";
import { formatWindow, beijingYear, STATUS_LABELS } from "../time.ts";
import type { Route } from "./+types/college-detail.ts";

const KIND_LABELS: Record<string, string> = {
  winter_camp: "冬令营",
  summer_camp: "夏令营",
  pre_recommendation: "预推免",
  september_round: "九推",
};
const COLLEGE_KIND_LABELS: Record<string, string> = {
  college: "学院",
  institute: "研究所",
  graduate_school: "研究生院",
};

export function meta() {
  return [{ title: "学院 · 鼠钟" }];
}

export async function loader({
  params,
  context,
}: Route.LoaderArgs): Promise<{ college: PublicCollegeDetail; thisYear: number }> {
  if (!params.id) throw data("学院不存在", { status: 404 });
  const college = await readPublicApi(
    await context.get(apiContext).colleges[":id"].$get({ param: { id: params.id } }),
    publicCollegeDetailSchema,
  );
  return { college, thisYear: beijingYear(new Date()) };
}

function applyText(
  apply: PublicCollegeDetail["programs"][number]["programs"][number]["apply"],
  year: number,
) {
  if (!apply) return "未说明";
  const window = formatWindow(apply, year);
  if (window) return apply.rolling ? `${window}（额满即止）` : window;
  return apply.rolling ? "额满即止" : "未说明";
}

function fieldSummary(program: PublicCollegeDetail["programs"][number]["programs"][number]) {
  if (!program.apply) return "报名时间未说明";
  if (program.apply.start || program.apply.end) return null;
  return program.apply.rolling ? "额满即止" : "报名时间未说明";
}

export default function CollegeDetail({
  loaderData,
}: {
  loaderData: { college: PublicCollegeDetail; thisYear: number };
}) {
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
        <h2 className="text-lg font-semibold">通知来源</h2>
        {college.sources.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">还没有接入通知来源。</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {college.sources.map((source) => (
              <li key={source.id} className="py-3">
                <a
                  href={source.url}
                  target="_blank"
                  rel="nofollow noopener"
                  className="text-link underline-offset-4 hover:underline"
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
                  const summary = fieldSummary(program);
                  return (
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
                      <p className="mt-3 text-sm">
                        <span className="text-muted-foreground">报名时间：</span>
                        {applyText(program.apply, thisYear)}
                      </p>
                      {summary && <p className="mt-1 text-xs text-muted-foreground">{summary}</p>}
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
