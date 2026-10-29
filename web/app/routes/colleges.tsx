import { Link } from "react-router";
import { apiContext } from "../api.server.ts";
import {
  readPublicApi,
  publicCollegeListSchema,
  type PublicCollegeList,
} from "../colleges.server.ts";
import type { Route } from "./+types/colleges.ts";

const TIER_LABELS: Record<string, string> = {
  c9: "C9",
  "985": "985",
  "211": "211",
  double_first_class: "双一流",
};
const KIND_LABELS: Record<string, string> = {
  college: "学院",
  institute: "研究所",
  graduate_school: "研究生院",
};

export function meta() {
  return [
    { title: "院校清单 · 鼠钟" },
    { name: "description", content: "按学校查看鼠钟收录的学院" },
  ];
}

export async function loader({ context }: Route.LoaderArgs): Promise<PublicCollegeList> {
  return readPublicApi(await context.get(apiContext).colleges.$get(), publicCollegeListSchema);
}

export default function Colleges({ loaderData }: { loaderData: PublicCollegeList }) {
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-3 py-6 sm:px-5">
      <header>
        <p className="mb-2 text-sm font-medium text-brand-strong">院校清单</p>
        <h1 className="text-2xl font-semibold">学校和学院</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          找到学院后，可以查看它的来源和历年保研项目。
        </p>
      </header>
      {loaderData.schools.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          还没有收录学院。
        </p>
      ) : (
        <div className="space-y-5">
          {loaderData.schools.map((school) => (
            <section key={school.id} className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-3">
                <h2 className="text-lg font-semibold">{school.name}</h2>
                {school.short_name && (
                  <span className="text-sm text-muted-foreground">{school.short_name}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {school.tiers.map((tier) => TIER_LABELS[tier] ?? tier).join(" · ") ||
                    "未标注层次"}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {school.colleges.map((college) => (
                  <li key={college.id} className="py-3">
                    <Link
                      to={`/colleges/${college.id}`}
                      className="font-medium text-link underline-offset-4 hover:underline"
                    >
                      {college.name}
                    </Link>
                    <span className="ml-2 text-sm text-muted-foreground">
                      {KIND_LABELS[college.kind] ?? college.kind} · {college.region}
                    </span>
                    {college.directions.length > 0 && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        方向：{college.directions.join("、")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
