import { Form, Link } from "react-router";
import { apiContext } from "../api.server.ts";
import { readApi, type RunsPage } from "../admin.server.ts";
import { CrawlTime, inputClass, linkClass, panelClass, Pagination } from "~/components/admin";
import { Button } from "~/components/ui/button";
import type { Route } from "./+types/crawl-runs.ts";

export async function loader({ request, context }: Route.LoaderArgs): Promise<{
  runs: RunsPage;
  sourceId: string | undefined;
  date: string | undefined;
}> {
  const params = new URL(request.url).searchParams;
  const sourceId = params.get("source_id") ?? undefined;
  const date = params.get("date") || undefined;
  const api = context.get(apiContext);
  const runs = await readApi<RunsPage>(
    await api["crawl-runs"].$get({
      query: { source_id: sourceId, date, page: params.get("page") ?? "1" },
    }),
  );
  return { runs, sourceId, date };
}

export default function CrawlRuns({ loaderData }: Route.ComponentProps) {
  const { runs, sourceId, date } = loaderData;
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-3 py-6 sm:px-5">
      <title>抓取记录 · 鼠钟</title>
      <h1 className="text-2xl font-semibold">抓取记录</h1>
      <p className="text-sm text-muted-foreground">
        每轮抓取的结果，时间按北京时间显示。
        {sourceId && (
          <Link to="/crawl-runs" className={linkClass}>
            查看全部来源
          </Link>
        )}
      </p>
      <Form method="get" className="flex flex-wrap items-end gap-3">
        {sourceId && <input type="hidden" name="source_id" value={sourceId} />}
        <label className="space-y-1 text-sm">
          <span className="block">开始日期</span>
          <input type="date" name="date" defaultValue={date ?? ""} className={inputClass} />
        </label>
        <Button variant="outline">筛选</Button>
      </Form>
      {runs.items.map((run) => (
        <article key={run.id} className={panelClass}>
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h2 className="font-semibold">
                {run.school_name} · {run.college_name}
              </h2>
              <a
                className={`${linkClass} mt-1 block text-sm break-all`}
                href={run.url}
                target="_blank"
                rel="noreferrer"
              >
                {run.section || run.url}
              </a>
            </div>
            <p
              className={`text-sm font-medium ${run.failure ? "text-destructive" : run.notice_failure_count ? "text-warning" : "text-success"}`}
            >
              {run.failure
                ? "列表抓取失败"
                : run.notice_failure_count
                  ? "列表成功，部分通知失败"
                  : "成功"}
            </p>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            <CrawlTime value={run.started_at} /> 至 <CrawlTime value={run.finished_at} />
          </p>
          <p className="mt-2 text-sm">
            列表 {run.listed} 条 · 新通知 {run.new_count} 条 · 有用通知 {run.useful_count} 条
          </p>
          {run.failure && (
            <p className="mt-2 text-sm text-destructive">
              {run.failure}：{run.detail || "未提供具体原因"}
            </p>
          )}
          {run.notice_failures.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-warning">
                {run.notice_failures.length} 条通知未抓成
              </summary>
              <ul className="mt-2 space-y-2">
                {run.notice_failures.map((failure, i) => (
                  <li key={`${failure.url}-${i}`}>
                    <a
                      href={failure.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`${linkClass} break-all`}
                    >
                      {failure.url}
                    </a>
                    <p className="text-muted-foreground">
                      {failure.failure}：{failure.detail || "未提供具体原因"}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      ))}
      {runs.items.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          没有符合条件的抓取记录。
        </p>
      )}
      <Pagination page={runs.page} nextPage={runs.next_page} />
    </main>
  );
}
