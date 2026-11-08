import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { ExternalLink } from "~/components/icons";
import { Group, List, Row } from "~/components/list";
import { Empty, Page } from "~/components/page";
import { buttonVariants } from "~/components/ui/button";
import { ApplyDeadline, ApplyStart, Countdown } from "~/components/program";
import { COLLEGE_KINDS, KindTag, StatusTag, Tag, TierTags } from "~/components/tags";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { beijingYear, statusOf, useNow } from "../time.ts";
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
          <TierTags tiers={school.tiers} />
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
      <section aria-label="历年项目" className="space-y-6">
        {college.programs.length === 0 ? (
          <Empty>该学院尚无收录的项目</Empty>
        ) : (
          college.programs.map((group) => (
            <Group
              key={group.cohort}
              label={<p className="text-lg font-semibold tabular-nums">{group.cohort} 届</p>}
            >
              <List>
                {group.programs.map((program) => (
                  <Row
                    key={program.id}
                    title={
                      <>
                        <Link
                          to={`/programs/${program.id}`}
                          className="text-[15px] font-medium hover:text-primary"
                        >
                          {program.name}
                        </Link>
                        <KindTag kind={program.kind} />
                      </>
                    }
                    meta={
                      <>
                        <span>
                          报名开始 <ApplyStart apply={program.apply} thisYear={thisYear} />
                        </span>
                        <span>
                          报名截止 <ApplyDeadline apply={program.apply} thisYear={thisYear} />
                        </span>
                      </>
                    }
                    side={<StatusTag status={statusOf(program, now)} />}
                    sideMeta={<Countdown program={program} now={now} />}
                  />
                ))}
              </List>
            </Group>
          ))
        )}
      </section>
    </Page>
  );
}
