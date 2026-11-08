import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink } from "~/components/icons";
import { Empty, Panel, Page } from "~/components/page";
import { ApplyDeadline, ApplyStart, Countdown } from "~/components/program";
import { COLLEGE_KINDS, KindTag, StatusTag, TierTags } from "~/components/tags";
import { Table, Td, Th, Tr } from "~/components/ui/table";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { beijingYear, statusOf, useNow } from "../time.ts";
import type { Route } from "./+types/college-detail.ts";

type CollegeDetail = InferResponseType<
  ReturnType<typeof createApi>["colleges"][":id"]["$get"],
  200
>;
type Program = CollegeDetail["programs"][number]["programs"][number];

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
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-foreground">{school.name}</span>
          <TierTags tiers={school.tiers} />
        </span>
      }
    >
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {college.programs.length === 0 ? (
            <Empty>该学院尚无收录的项目。</Empty>
          ) : (
            college.programs.map((group) => (
              <Panel key={group.cohort} title={`${group.cohort} 届`} flush>
                <Programs programs={group.programs} now={now} thisYear={thisYear} />
              </Panel>
            ))
          )}
        </div>
        <aside className="space-y-4">
          <Panel title="基本信息">
            <dl className="space-y-3 text-sm">
              <Info label="所属学校">{school.name}</Info>
              <Info label="单位类型">{COLLEGE_KINDS[college.kind] ?? college.kind}</Info>
              <Info label="所在地区">{college.region}</Info>
              <Info label="招生方向">
                {college.directions.length > 0 ? college.directions.join("、") : "未注明"}
              </Info>
            </dl>
          </Panel>
          <Panel title="通知栏目" description="学院官网发布招生通知的栏目" flush>
            {college.sources.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted-foreground sm:px-5">
                尚未接入通知栏目。
              </p>
            ) : (
              <ul className="divide-y">
                {college.sources.map((source) => (
                  <li key={source.id} className="px-4 py-3 sm:px-5">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="nofollow noopener"
                      className="link inline-flex items-center gap-1 font-medium"
                    >
                      {source.section || "通知栏目"}
                      <ExternalLink className="size-3.5" />
                    </a>
                    <p className="mt-0.5 text-xs break-all text-muted-foreground">{source.url}</p>
                    {source.unavailable_reason && (
                      <p className="mt-1.5 text-[13px] text-warning">
                        暂停抓取：{source.unavailable_reason}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </Page>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The table of the home page, less the columns every row here shares.
function Programs({
  programs,
  now,
  thisYear,
}: {
  programs: Program[];
  now: number;
  thisYear: number;
}) {
  return (
    <>
      <div className="max-sm:hidden">
        <Table bare>
          <thead>
            <tr>
              <Th>项目</Th>
              <Th className="w-px">类型</Th>
              <Th className="w-px">报名开始</Th>
              <Th className="w-px">报名截止</Th>
              <Th className="w-px">状态</Th>
            </tr>
          </thead>
          <tbody>
            {programs.map((program) => (
              <Tr key={program.id}>
                <Td>
                  <Link to={`/programs/${program.id}`} className="link text-foreground">
                    {program.name}
                  </Link>
                </Td>
                <Td center className="whitespace-nowrap">
                  <KindTag kind={program.kind} />
                </Td>
                <Td center className="whitespace-nowrap tabular-nums">
                  <ApplyStart apply={program.apply} thisYear={thisYear} />
                </Td>
                <Td center className="whitespace-nowrap tabular-nums">
                  <ApplyDeadline apply={program.apply} thisYear={thisYear} />
                </Td>
                <Td center className="whitespace-nowrap">
                  <div className="flex flex-col items-center gap-1">
                    <StatusTag status={statusOf(program, now)} />
                    <Countdown program={program} now={now} />
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="divide-y sm:hidden">
        {programs.map((program) => (
          <li key={program.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <Link to={`/programs/${program.id}`} className="font-medium hover:text-primary">
                {program.name}
              </Link>
              <StatusTag status={statusOf(program, now)} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] tabular-nums">
              <KindTag kind={program.kind} />
              <span>
                <span className="text-muted-foreground">开始 </span>
                <ApplyStart apply={program.apply} thisYear={thisYear} />
              </span>
              <span>
                <span className="text-muted-foreground">截止 </span>
                <ApplyDeadline apply={program.apply} thisYear={thisYear} />
              </span>
              <Countdown program={program} now={now} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
