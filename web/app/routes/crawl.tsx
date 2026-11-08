import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { linkClass, panelClass } from "../components/admin.tsx";
import { ClockTime, failureText, RunResult } from "../components/crawl.tsx";
import { Pagination } from "../components/pagination.tsx";
import { Tag } from "../components/tags.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { beijingDate } from "../time.ts";
import type { Route } from "./+types/crawl.ts";

type Api = ReturnType<typeof createApi>;
type Day = InferResponseType<Api["crawl-runs"]["$get"], 200>;
type Source = Day["items"][number];

// The crawler asks for work every minute (design §16); this long without it, it has stopped.
const CRAWLER_LATE_S = 10 * 60;

const PURPOSES = { screening: "初筛", extraction: "抽取", probe: "试抓" };

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

function tokens(input: number, output: number) {
  return `输入 ${input.toLocaleString("zh-CN")} · 输出 ${output.toLocaleString("zh-CN")}`;
}

export default function Crawl({ loaderData }: Route.ComponentProps) {
  const { day, now, oneSource } = loaderData;
  const today = beijingDate(now);
  const step = buttonVariants({ variant: "ghost", size: "sm" });
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-3 py-6 sm:px-5">
      <header>
        <h1 className="text-2xl font-semibold">抓取看板</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          每个来源每一轮抓得怎么样。连续 2 轮没读到列表的标红；旺季里 30
          天没有新通知的标黄，多半是网站改版了，配置抓不到东西（总体设计 §7.5）。
        </p>
      </header>

      <CrawlerSeen seenAt={day.crawler_seen_at} now={now} />

      <section className={`${panelClass} space-y-3`}>
        <nav aria-label="日期" className="flex flex-wrap items-center gap-1">
          <Link to={`?date=${shift(day.date, -1)}`} className={step}>
            ← 前一天
          </Link>
          <span className="px-2 font-medium tabular-nums">
            {day.date}
            {day.date === today && "（今天）"}
          </span>
          {day.date < today && (
            <Link to={`?date=${shift(day.date, 1)}`} className={step}>
              后一天 →
            </Link>
          )}
          {oneSource && (
            <Link to={`?date=${day.date}`} className={`${linkClass} ml-auto text-sm`}>
              看这一天的全部来源
            </Link>
          )}
        </nav>
        <p className="text-sm">
          这一天抓了 {day.total} 个来源
          {day.failing > 0 && <span className="text-destructive">，{day.failing} 个连续失败</span>}
          {day.stale > 0 && <span className="text-warning">，{day.stale} 个 30 天没有新通知</span>}
          。
        </p>
        {day.usage.length > 0 && (
          <table className="w-full text-sm">
            <caption className="mb-1 text-left text-xs text-muted-foreground">
              这一天的模型用量（token）
            </caption>
            <tbody className="divide-y divide-border">
              {day.usage.map((row) => (
                <tr key={`${row.purpose} ${row.model}`}>
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {PURPOSES[row.purpose]} · {row.model}
                  </th>
                  <td className="py-1 pr-3 text-muted-foreground tabular-nums">{row.calls} 次</td>
                  <td className="py-1 text-right tabular-nums">
                    {tokens(row.input_tokens, row.output_tokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={panelClass}>
        {day.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">这一天没有抓取记录。</p>
        ) : (
          <ol className="divide-y divide-border">
            {day.items.map((source) => (
              <SourceDay key={source.id} source={source} />
            ))}
          </ol>
        )}
        <Pagination total={day.total} page={day.page} perPage={day.per_page} />
      </section>
    </main>
  );
}

function CrawlerSeen({ seenAt, now }: { seenAt: number | null; now: number }) {
  if (seenAt === null) {
    return <p className="text-sm text-muted-foreground">抓取节点还没来领过活。</p>;
  }
  const minutes = Math.floor((now - seenAt) / 60);
  const ago = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时`;
  if (now - seenAt <= CRAWLER_LATE_S) {
    return <p className="text-sm text-muted-foreground">抓取节点 {ago}前来领过活。</p>;
  }
  return (
    <p
      role="alert"
      className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning"
    >
      抓取节点已经 {ago}没来领活了，这段时间不会有新通知。
    </p>
  );
}

function SourceDay({ source }: { source: Source }) {
  return (
    <li id={`source-${source.id}`} className="space-y-2 py-4 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {source.school} · {source.college}
          {source.section && ` · ${source.section}`}
        </span>
        {source.failing && <Tag color="red">连续失败</Tag>}
        {source.stale && <Tag color="amber">30 天没有新通知</Tag>}
      </p>
      <p className="text-xs break-all text-muted-foreground">
        <a href={source.url} target="_blank" rel="nofollow noopener" className={linkClass}>
          {source.url}
        </a>
        {" · "}模型用量 {tokens(source.usage.input_tokens, source.usage.output_tokens)}
      </p>
      <ul className="space-y-1">
        {source.runs.map((run) => (
          <li key={run.id}>
            <ClockTime value={run.started_at} /> <RunResult run={run} />
            {run.notice_failure_count > 0 && (
              <details className="mt-1 ml-12 text-xs">
                <summary className="cursor-pointer text-muted-foreground">看没抓成的通知</summary>
                <ul className="mt-1 space-y-0.5 break-all">
                  {run.notice_failures.map((notice) => (
                    <li key={notice.url}>
                      <a
                        href={notice.url}
                        target="_blank"
                        rel="nofollow noopener"
                        className={linkClass}
                      >
                        {notice.url}
                      </a>
                      ：{failureText(notice.failure, notice.detail)}
                    </li>
                  ))}
                  {run.notice_failure_count > run.notice_failures.length && (
                    <li className="text-muted-foreground">
                      还有 {run.notice_failure_count - run.notice_failures.length} 条没列出
                    </li>
                  )}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
