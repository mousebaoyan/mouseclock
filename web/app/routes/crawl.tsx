import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { cn } from "~/cn";
import { failureText, RunResult } from "~/components/crawl";
import { ChevronLeft, ChevronRight } from "~/components/icons";
import { Facts, Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { Tag } from "~/components/tags";
import { ClockTime } from "~/components/time";
import { buttonVariants } from "~/components/ui/button";
import { Reveal } from "~/components/ui/reveal";
import { Table, Td, Th, Tr } from "~/components/ui/table";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { beijingDate } from "../time.ts";
import type { Route } from "./+types/crawl.ts";

type Api = ReturnType<typeof createApi>;
type Day = InferResponseType<Api["crawl-runs"]["$get"], 200>;
type Source = Day["items"][number];

// The crawler asks for work every minute (design §16); this long without it, it has stopped.
const CRAWLER_LATE_S = 10 * 60;

const PURPOSES = { screening: "通知初筛", extraction: "信息抽取", probe: "试抓" };

export function meta() {
  return [{ title: "抓取看板 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const params = new URL(request.url).searchParams;
  const day = await api["crawl-runs"]
    .$get({
      query: {
        date: params.get("date") ?? undefined,
        source_id: params.get("source_id") ?? undefined,
        page: params.get("page") ?? undefined,
        per_page: params.get("per_page") ?? undefined,
      },
    })
    .then((res) => readApi<Day>(res));
  return { day, now: Math.floor(Date.now() / 1000), oneSource: params.has("source_id") };
}

function shift(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

const number = new Intl.NumberFormat("zh-CN");

export default function Crawl({ loaderData }: Route.ComponentProps) {
  const { day, now, oneSource } = loaderData;
  const today = beijingDate(now);
  const calls = day.usage.reduce((sum, row) => sum + row.calls, 0);
  return (
    <Page
      title="抓取看板"
      description="各来源每轮的抓取结果与当天的模型用量。"
      actions={<DayNav date={day.date} today={today} />}
    >
      <CrawlerSeen seenAt={day.crawler_seen_at} now={now} />
      <Facts
        items={[
          { label: "抓取来源", value: `${day.total} 个` },
          {
            label: "连续失败",
            value: (
              <span className={day.failing > 0 ? "text-destructive" : undefined}>
                {day.failing} 个
              </span>
            ),
          },
          {
            label: "长期无更新",
            value: (
              <span className={day.stale > 0 ? "text-warning" : undefined}>{day.stale} 个</span>
            ),
          },
          { label: "模型调用", value: `${number.format(calls)} 次` },
        ]}
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel
          title={oneSource ? "该来源的抓取记录" : "各来源的抓取记录"}
          description="连续 2 轮未能读取列表页的来源标为「连续失败」；旺季内 30 天没有新通知的来源标为「长期无更新」，通常是网站改版导致配置失效。"
          actions={
            oneSource && (
              <Link
                to={`?date=${day.date}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                查看当天全部来源
              </Link>
            )
          }
          flush
        >
          {day.items.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted-foreground sm:px-5">
              当天没有抓取记录。
            </p>
          ) : (
            <>
              <RunTable sources={day.items} />
              <RunCards sources={day.items} />
            </>
          )}
          <div className="px-4 pb-4 sm:px-5 empty:hidden">
            <Pagination total={day.total} page={day.page} perPage={day.per_page} />
          </div>
        </Panel>
        <Panel title="模型用量" description="当天各用途的调用次数与 token 数" flush>
          {day.usage.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted-foreground sm:px-5">
              当天没有调用模型。
            </p>
          ) : (
            <Table bare>
              <thead>
                <tr>
                  <Th>用途</Th>
                  <Th className="w-px">调用</Th>
                  <Th className="w-px">输入</Th>
                  <Th className="w-px">输出</Th>
                </tr>
              </thead>
              <tbody>
                {day.usage.map((row) => (
                  <Tr key={`${row.purpose} ${row.model}`}>
                    <Td>
                      {PURPOSES[row.purpose]}
                      <span className="block text-xs text-muted-foreground">{row.model}</span>
                    </Td>
                    <Td center className="tabular-nums">
                      {number.format(row.calls)}
                    </Td>
                    <Td center className="tabular-nums">
                      {number.format(row.input_tokens)}
                    </Td>
                    <Td center className="tabular-nums">
                      {number.format(row.output_tokens)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </Page>
  );
}

function DayNav({ date, today }: { date: string; today: string }) {
  const step =
    "inline-flex size-9 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <nav
      aria-label="日期"
      className="flex h-9 items-stretch overflow-hidden rounded-md border bg-card"
    >
      <Link to={`?date=${shift(date, -1)}`} aria-label="前一天" className={step}>
        <ChevronLeft />
      </Link>
      <span className="flex items-center border-x px-3 text-sm font-medium tabular-nums">
        {date}
        {date === today && <span className="ml-1.5 font-normal text-muted-foreground">今天</span>}
      </span>
      {date < today ? (
        <Link to={`?date=${shift(date, 1)}`} aria-label="后一天" className={step}>
          <ChevronRight />
        </Link>
      ) : (
        <span aria-hidden="true" className={cn(step, "opacity-35 hover:bg-transparent")}>
          <ChevronRight />
        </span>
      )}
    </nav>
  );
}

function CrawlerSeen({ seenAt, now }: { seenAt: number | null; now: number }) {
  const late = seenAt === null || now - seenAt > CRAWLER_LATE_S;
  let text = "抓取节点尚未领取过任务。";
  if (seenAt !== null) {
    const minutes = Math.floor((now - seenAt) / 60);
    const ago = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`;
    text = late
      ? `抓取节点已有 ${ago}未领取任务，期间不会抓取新通知。`
      : `抓取节点运行正常，${minutes < 1 ? "刚刚" : `${ago}前`}领取过任务。`;
  }
  return (
    <p
      role={late && seenAt !== null ? "alert" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-[13px] shadow-card",
        late ? "border-warning/40 text-warning" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", late ? "bg-warning" : "bg-success")}
      />
      {text}
    </p>
  );
}

function SourceName({ source }: { source: Source }) {
  return (
    <>
      <p className="font-medium">
        {source.school}
        <span className="ml-1">{source.college}</span>
      </p>
      <a
        href={source.url}
        target="_blank"
        rel="nofollow noopener"
        className="mt-0.5 block text-xs break-all text-muted-foreground hover:text-primary"
      >
        {source.section || source.url}
      </a>
      {(source.failing || source.stale) && (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {source.failing && <Tag color="red">连续失败</Tag>}
          {source.stale && <Tag color="amber">长期无更新</Tag>}
        </p>
      )}
    </>
  );
}

// The notices of a round that couldn't be fetched, beneath its result.
function NoticeFailures({ run }: { run: Source["runs"][number] }) {
  if (run.notice_failure_count === 0) return null;
  return (
    <Reveal label="查看失败的通知" className="mt-1">
      <ul className="space-y-1 rounded-md border bg-muted/50 p-2.5 text-xs">
        {run.notice_failures.map((notice) => (
          <li key={notice.url} className="break-all">
            <a href={notice.url} target="_blank" rel="nofollow noopener" className="link">
              {notice.url}
            </a>
            <span className="ml-2 text-muted-foreground">
              {failureText(notice.failure, notice.detail)}
            </span>
          </li>
        ))}
        {run.notice_failure_count > run.notice_failures.length && (
          <li className="text-muted-foreground">
            另有 {run.notice_failure_count - run.notice_failures.length} 条未列出
          </li>
        )}
      </ul>
    </Reveal>
  );
}

// One row per round; a source's name and usage span the rows of its rounds.
function RunTable({ sources }: { sources: Source[] }) {
  return (
    <div className="max-lg:hidden">
      <Table bare>
        <thead>
          <tr>
            <Th>来源</Th>
            <Th className="w-px">时间</Th>
            <Th>结果</Th>
            <Th className="w-px">列表条目</Th>
            <Th className="w-px">新通知</Th>
            <Th className="w-px">相关通知</Th>
            <Th className="w-px">模型 token</Th>
          </tr>
        </thead>
        {sources.map((source) => (
          <tbody
            key={source.id}
            id={`source-${source.id}`}
            className="border-b last:border-b-0 hover:bg-muted/40"
          >
            {source.runs.map((run, i) => (
              <Tr key={run.id} className="hover:bg-transparent">
                {i === 0 && (
                  <Td rowSpan={source.runs.length} className="max-w-72 align-top">
                    <SourceName source={source} />
                  </Td>
                )}
                <Td center className="align-top">
                  <ClockTime value={run.started_at} />
                </Td>
                <Td className="align-top">
                  <RunResult run={run} />
                  <NoticeFailures run={run} />
                </Td>
                <Td center className="align-top tabular-nums">
                  {run.listed}
                </Td>
                <Td center className="align-top tabular-nums">
                  {run.new_count}
                </Td>
                <Td center className="align-top tabular-nums">
                  {run.useful_count}
                </Td>
                {i === 0 && (
                  <Td
                    rowSpan={source.runs.length}
                    center
                    className="align-top text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                  >
                    输入 {number.format(source.usage.input_tokens)}
                    <br />
                    输出 {number.format(source.usage.output_tokens)}
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        ))}
      </Table>
    </div>
  );
}

function RunCards({ sources }: { sources: Source[] }) {
  return (
    <ul className="divide-y lg:hidden">
      {sources.map((source) => (
        <li key={source.id} id={`source-${source.id}`} className="space-y-2.5 px-4 py-3.5">
          <SourceName source={source} />
          <ul className="space-y-2">
            {source.runs.map((run) => (
              <li key={run.id} className="rounded-md bg-muted/50 px-3 py-2 text-[13px]">
                <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <RunResult run={run} />
                  <ClockTime value={run.started_at} />
                </p>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  列表条目 {run.listed}　新通知 {run.new_count}　相关通知 {run.useful_count}
                </p>
                <NoticeFailures run={run} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
