import type { InferResponseType } from "hono/client";
import { ExternalLink } from "~/components/icons";
import { Empty, Page } from "~/components/page";
import { buttonVariants } from "~/components/ui/button";
import { ProgramCard, ProgramCards } from "~/components/program";
import { COLLEGE_KINDS, Tag, TierTag } from "~/components/tags";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { beijingYear, useNow } from "../time.ts";
import type { Route } from "./+types/college-detail.ts";

type CollegeDetail = InferResponseType<
  ReturnType<typeof createApi>["colleges"][":id"]["$get"],
  200
>;

export function meta({ loaderData }: Route.MetaArgs) {
  const { college } = loaderData;
  return [{ title: `${college.school.name}${college.name} · 鼠钟` }];
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
    <Page
      title={college.name}
      crumbs={[{ to: "/colleges", label: "院校清单" }]}
      meta={
        <>
          <span className="text-foreground">{school.name}</span>
          <TierTag tier={school.tier} />
          <span>{college.region}</span>
          {college.kind !== "college" && <span>{COLLEGE_KINDS[college.kind] ?? college.kind}</span>}
          {college.directions.length > 0 && <span>招生方向：{college.directions.join("、")}</span>}
        </>
      }
      actions={college.sources.map((source) => (
        <a
          key={source.id}
          href={source.url}
          target="_blank"
          rel="nofollow noopener"
          title={source.unavailable_reason ?? source.url}
          className={buttonVariants({ variant: "outline" })}
        >
          {source.section || "学院通知"}
          {source.unavailable_reason && <Tag color="amber">暂停抓取</Tag>}
          <ExternalLink />
        </a>
      ))}
    >
      {college.programs.length === 0 ? (
        <Empty>该学院尚无收录的项目</Empty>
      ) : (
        <section aria-label="历年项目">
          <ProgramCards>
            {college.programs.map((group) =>
              group.programs.map((program) => (
                <ProgramCard
                  key={program.id}
                  program={program}
                  now={now}
                  thisYear={thisYear}
                  place={<p className="text-[13px] font-medium">{group.cohort} 届</p>}
                />
              )),
            )}
          </ProgramCards>
        </section>
      )}
    </Page>
  );
}
