import type { Failure } from "../../server/modules/ingest/service.ts";

export const FAILURES: Record<Failure, string> = {
  timeout: "超时",
  unreachable: "连不上",
  too_many_redirects: "重定向太多",
  http_status: "状态码不对",
  no_items: "列表里没找到条目",
  error: "出错",
};

export function failureText(failure: Failure, detail?: string) {
  return detail ? `${FAILURES[failure]}：${detail}` : FAILURES[failure];
}

// How a round went (design §7.5): the list read or not, the notices it couldn't fetch, and what
// it found.
export function RunResult({
  run,
}: {
  run: {
    failure: Failure | null;
    detail: string;
    listed: number;
    new_count: number;
    useful_count: number;
    notice_failure_count: number;
  };
}) {
  return (
    <>
      <span
        className={
          run.failure
            ? "text-destructive"
            : run.notice_failure_count > 0
              ? "text-warning"
              : "text-success"
        }
      >
        {run.failure
          ? `列表没读到，${failureText(run.failure, run.detail)}`
          : run.notice_failure_count > 0
            ? `列表读到了，${run.notice_failure_count} 条通知没抓成`
            : "成功"}
      </span>
      <span className="text-muted-foreground">
        {" "}
        · 列表 {run.listed} · 新通知 {run.new_count} · 有用 {run.useful_count}
      </span>
    </>
  );
}

// The time of day in Beijing, for rounds listed under their day.
export function ClockTime({ value }: { value: number }) {
  return (
    <time dateTime={new Date(value * 1000).toISOString()} className="tabular-nums">
      {new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value * 1000))}
    </time>
  );
}
