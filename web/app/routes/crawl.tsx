import type { InferResponseType } from "hono/client";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/cn";
import { attachmentFailureText, failureText, RunResult } from "~/components/crawl";
import { ChevronLeft, ChevronRight, ExternalLink } from "~/components/icons";
import { List, Row } from "~/components/list";
import { Empty, Facts, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { Tag } from "~/components/tags";
import { ClockTime } from "~/components/time";
import { buttonVariants } from "~/components/ui/button";
import { Reveal } from "~/components/ui/reveal";
import { Table, Td, Tr } from "~/components/ui/table";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { beijingDate } from "../time.ts";
import type { Route } from "./+types/crawl.ts";

type Api = ReturnType<typeof createApi>;
type Day = InferResponseType<Api["crawl-runs"]["$get"], 200>;
type Source = Day["items"][number];
type Run = Source["runs"][number];

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
    <Page title="抓取看板" hideTitle>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DayNav date={day.date} today={today} />
        <CrawlerSeen seenAt={day.crawler_seen_at} now={now} />
      </div>
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
      <section aria-label="各来源" className="space-y-3">
        {oneSource && (
          <Link
            to={`?date=${day.date}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            查看当天全部来源
          </Link>
        )}
        {day.items.length === 0 ? (
          <Empty>当天没有抓取记录</Empty>
        ) : (
          <>
            <Table
              className="max-lg:hidden"
              head={["来源", "最近抓取", "结果", "新通知", "相关通知"]}
              actions="详情"
            >
              {day.items.map((source) => (
                <SourceRows key={source.id} source={source} />
              ))}
            </Table>
            <List className="lg:hidden">
              {day.items.map((source) => (
                <SourceRow key={source.id} source={source} />
              ))}
            </List>
          </>
        )}
        <Pagination total={day.total} page={day.page} perPage={day.per_page} />
      </section>
      <section aria-label="模型用量" className="space-y-3">
        <h2 className="text-[15px] font-semibold">模型用量</h2>
        {day.usage.length === 0 ? (
          <Empty className="py-8">当天没有调用模型</Empty>
        ) : (
          <>
            <Table
              className="max-lg:hidden"
              head={["用途", "模型", "调用次数", "输入 token", "输出 token"]}
            >
              {day.usage.map((row) => (
                <Tr key={`${row.purpose} ${row.model}`}>
                  <Td className="font-medium">{PURPOSES[row.purpose]}</Td>
                  <Td>{row.model}</Td>
                  <Td nowrap>{number.format(row.calls)}</Td>
                  <Td nowrap>{number.format(row.input_tokens)}</Td>
                  <Td nowrap>{number.format(row.output_tokens)}</Td>
                </Tr>
              ))}
            </Table>
            <List className="lg:hidden">
              {day.usage.map((row) => (
                <Row
                  key={`${row.purpose} ${row.model}`}
                  title={<span className="font-medium">{PURPOSES[row.purpose]}</span>}
                  meta={<span>{row.model}</span>}
                  side={<span className="tabular-nums">{number.format(row.calls)} 次</span>}
                  sideMeta={
                    <span className="tabular-nums">
                      {tokens(row.input_tokens, row.output_tokens)}
                    </span>
                  }
                />
              ))}
            </List>
          </>
        )}
      </section>
    </Page>
  );
}

function tokens(input: number, output: number) {
  return `输入 ${number.format(input)}，输出 ${number.format(output)}`;
}

function DayNav({ date, today }: { date: string; today: string }) {
  const step =
    "inline-flex size-9 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-11";
  return (
    <nav
      aria-label="日期"
      className="flex h-9 items-stretch overflow-hidden rounded-md border bg-card pointer-coarse:h-11"
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
  let text = "抓取节点尚未领取过任务";
  if (seenAt !== null) {
    const minutes = Math.floor((now - seenAt) / 60);
    const ago = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`;
    text = late
      ? `抓取节点已有 ${ago}未领取任务，期间不会抓取新通知`
      : `抓取节点运行正常，${minutes < 1 ? "刚刚" : `${ago}前`}领取过任务`;
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

// The school and college, the section where one is named, and a link to the list page it reads.
function SourceName({ source }: { source: Source }) {
  return (
    <>
      <span className="font-medium break-keep wrap-anywhere">
        {source.school} {source.college}
        {source.section && (
          <span className="ml-1.5 font-normal text-muted-foreground">{source.section}</span>
        )}
        <a
          href={source.url}
          target="_blank"
          rel="nofollow noopener"
          aria-label="打开抓取的列表页"
          title="打开抓取的列表页"
          className="touch-target relative z-1 -my-1 ml-1 inline-flex size-6 items-center justify-center rounded-md align-middle text-muted-foreground hover:bg-accent hover:text-primary"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </span>
      {source.failing && (
        <span title="连续 2 轮未能读取列表页">
          <Tag color="red">连续失败</Tag>
        </span>
      )}
      {source.stale && (
        <span title="旺季内 30 天没有新通知，可能是网站改版导致配置失效">
          <Tag color="amber">长期无更新</Tag>
        </span>
      )}
    </>
  );
}

// The day's rounds, the latest first: how each went, then what it found and what it couldn't
// fetch, a few of each until asked for the rest; and what the source cost in tokens.
function Rounds({ source }: { source: Source }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card text-[13px]">
      <ol className="divide-y">
        {source.runs.toReversed().map((run) => (
          <li key={run.id} className="space-y-2 px-3 py-2.5 sm:px-4">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-medium">
                <ClockTime value={run.started_at} />
              </span>
              <RunResult run={run} />
              {run.failure === null && (
                <span className="text-muted-foreground tabular-nums">
                  列表 {run.listed} 条 · 新通知 {run.new_count} 条 · 相关 {run.useful_count} 条
                </span>
              )}
            </p>
            <NewNotices run={run} />
            <NoticeFailures run={run} />
            <AttachmentFailures run={run} />
          </li>
        ))}
      </ol>
      <p className="border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground tabular-nums sm:px-4">
        模型 token：{tokens(source.usage.input_tokens, source.usage.output_tokens)}
      </p>
    </div>
  );
}

function total(source: Source, count: "new_count" | "useful_count") {
  return source.runs.reduce((sum, run) => sum + run[count], 0);
}

// Wide screens: a source's day in a row, its rounds in one more beneath when opened.
function SourceRows({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const latest = source.runs.at(-1);
  return (
    <>
      <Tr>
        <Td>
          <span className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
            <SourceName source={source} />
          </span>
        </Td>
        <Td nowrap>{latest && <ClockTime value={latest.started_at} />}</Td>
        <Td>{latest && <RunResult run={latest} />}</Td>
        <Td nowrap>{total(source, "new_count")}</Td>
        <Td nowrap>{total(source, "useful_count")}</Td>
        <Td nowrap>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={buttonVariants({ variant: "ghost", size: "xs" })}
          >
            {open ? "收起" : "详情"}
          </button>
        </Td>
      </Tr>
      {open && (
        <Tr>
          <Td colSpan={6} className="border-t-0 pt-0 text-left">
            <Rounds source={source} />
          </Td>
        </Tr>
      )}
    </>
  );
}

// Phones: how its latest round went on the right, what the day found beneath its name, and the
// rounds when opened.
function SourceRow({ source }: { source: Source }) {
  const latest = source.runs.at(-1);
  const found = total(source, "new_count");
  return (
    <Row
      title={<SourceName source={source} />}
      meta={
        <span className="tabular-nums">
          {found === 0
            ? "无新通知"
            : `新通知 ${found} 条，其中相关 ${total(source, "useful_count")} 条`}
        </span>
      }
      side={latest && <RunResult run={latest} className="text-[13px]" />}
      sideMeta={latest && <ClockTime value={latest.started_at} />}
    >
      <Reveal label="详情" className="mt-1.5">
        <Rounds source={source} />
      </Reveal>
    </Row>
  );
}

const SHOWN = 5;

// A heading and the first few of a round's items, the rest a click away; past what the server
// lists, how many more there were.
function Items({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode[];
}) {
  const [all, setAll] = useState(false);
  if (count === 0) return null;
  const more = all ? 0 : Math.max(children.length - SHOWN, 0);
  const unlisted = count - children.length;
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">
        {label}（{count}）
      </p>
      <ul className="space-y-1.5 border-l-2 pl-3">
        {more > 0 ? children.slice(0, SHOWN) : children}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="touch-target mt-1 ml-3.5 text-xs text-primary hover:underline"
        >
          再显示 {more} 条
        </button>
      ) : (
        unlisted > 0 && (
          <p className="mt-1 pl-3.5 text-xs text-muted-foreground">另有 {unlisted} 条未列出</p>
        )
      )}
    </div>
  );
}

// The notices a round saw first, the ones with programs first, each linked to its programs.
function NewNotices({ run }: { run: Run }) {
  return (
    <Items label="新通知" count={run.new_count}>
      {run.new_notices.map((notice) => (
        <li key={notice.url} className="wrap-anywhere">
          <a
            href={notice.url}
            target="_blank"
            rel="nofollow noopener"
            className={cn(
              "hover:text-primary hover:underline",
              notice.programs.length === 0 && "text-muted-foreground",
            )}
          >
            {notice.title}
          </a>
          {notice.programs.length > 0 && (
            <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {notice.programs.map((program) => (
                <span key={program.id}>
                  <Link to={`/programs/${program.id}`} className="link">
                    {program.name}
                  </Link>
                </span>
              ))}
            </span>
          )}
        </li>
      ))}
    </Items>
  );
}

// The notices of a round that couldn't be fetched, by title where the list gave one.
function NoticeFailures({ run }: { run: Run }) {
  return (
    <Items label="没抓成的通知" count={run.notice_failure_count}>
      {run.notice_failures.map((notice) => (
        <li key={notice.url} className="wrap-anywhere">
          <a
            href={notice.url}
            target="_blank"
            rel="nofollow noopener"
            className="hover:text-primary hover:underline"
          >
            {notice.title ?? notice.url}
          </a>
          <span className="block text-xs text-warning">
            {failureText(notice.failure, notice.detail)}
          </span>
        </li>
      ))}
    </Items>
  );
}

// An attachment by its file's name, which its address ends with.
function fileName(url: string) {
  const name = new URL(url).pathname.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(name) || url;
  } catch {
    return name || url;
  }
}

// The attachments of a round's notices that couldn't be read: extraction went on without them.
function AttachmentFailures({ run }: { run: Run }) {
  return (
    <Items label="没读成的附件" count={run.attachment_failure_count}>
      {run.attachment_failures.map((attachment) => (
        <li key={`${attachment.notice_url} ${attachment.url}`} className="wrap-anywhere">
          <a
            href={attachment.url}
            target="_blank"
            rel="nofollow noopener"
            className="hover:text-primary hover:underline"
          >
            {fileName(attachment.url)}
          </a>
          <span className="block text-xs text-muted-foreground">
            <span className="text-warning">
              {attachmentFailureText(attachment.failure, attachment.detail)}
            </span>
            ，所在通知：
            <a
              href={attachment.notice_url}
              target="_blank"
              rel="nofollow noopener"
              className="link"
            >
              {attachment.notice_title ?? attachment.notice_url}
            </a>
          </span>
        </li>
      ))}
    </Items>
  );
}
