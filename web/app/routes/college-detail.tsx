import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { ExternalLink } from "~/components/icons";
import { List, Row } from "~/components/list";
import { Empty, Page } from "~/components/page";
import { buttonVariants } from "~/components/ui/button";
import { ApplyDeadline, ApplyStart, ProgramStatus } from "~/components/program";
import { COLLEGE_KINDS, KindTag, Tag, TierTags } from "~/components/tags";
import { Table, Td, Th, Tr } from "~/components/ui/table";
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
      {college.programs.length === 0 ? (
        <Empty>该学院尚无收录的项目</Empty>
      ) : (
        <section aria-label="历年项目">
          <Table className="max-lg:hidden">
            <thead>
              <tr>
                <Th className="w-28">届</Th>
                <Th>项目</Th>
                <Th>类型</Th>
                <Th>报名开始</Th>
                <Th>报名截止</Th>
                <Th>状态</Th>
              </tr>
            </thead>
            <tbody>
              {college.programs.map((group) =>
                group.programs.map((program, i) => (
                  <Tr key={program.id}>
                    {i === 0 && (
                      <Td center rowSpan={group.programs.length} className="border-r font-medium">
                        {group.cohort} 届
                      </Td>
                    )}
                    <Td>
                      <Link
                        to={`/programs/${program.id}`}
                        className="font-medium text-pretty hover:text-primary"
                      >
                        {program.name}
                      </Link>
                    </Td>
                    <Td center>
                      <KindTag kind={program.kind} />
                    </Td>
                    <Td center>
                      <ApplyStart apply={program.apply} thisYear={thisYear} />
                    </Td>
                    <Td center>
                      <ApplyDeadline apply={program.apply} thisYear={thisYear} />
                    </Td>
                    <Td center>
                      <ProgramStatus program={program} now={now} />
                    </Td>
                  </Tr>
                )),
              )}
            </tbody>
          </Table>
          <List className="lg:hidden">
            {college.programs.map((group) =>
              group.programs.map((program) => (
                <Row
                  key={program.id}
                  title={
                    <>
                      <Link
                        to={`/programs/${program.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {program.name}
                      </Link>
                      <KindTag kind={program.kind} />
                    </>
                  }
                  meta={
                    <>
                      <span>{group.cohort} 届</span>
                      <span className="tabular-nums">
                        <ApplyDeadline apply={program.apply} thisYear={thisYear} /> 截止
                      </span>
                    </>
                  }
                  side={<ProgramStatus program={program} now={now} />}
                />
              )),
            )}
          </List>
        </section>
      )}
    </Page>
  );
}
