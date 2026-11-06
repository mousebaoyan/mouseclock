import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { KINDS, TIERS } from "../components/admin.tsx";
import type { Route } from "./+types/colleges.ts";

type CollegeList = InferResponseType<ReturnType<typeof createApi>["colleges"]["$get"], 200>;

export function meta() {
  return [
    { title: "院校清单 · 鼠钟" },
    { name: "description", content: "按学校查看鼠钟收录的学院" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  return readApi<CollegeList>(await context.get(apiContext).colleges.$get());
}

export default function Colleges({ loaderData }: Route.ComponentProps) {
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
                  {school.tiers
                    .map((tier) => TIERS.find((item) => item.value === tier)?.label)
                    .join(" · ") || "未标注层次"}
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
                      {KINDS.find((item) => item.value === college.kind)?.label} · {college.region}
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
