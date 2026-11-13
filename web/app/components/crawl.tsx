import { cn } from "~/cn";
import type { Failure } from "../../server/modules/sources/schemas.ts";

export const FAILURES: Record<Failure, string> = {
  timeout: "请求超时",
  unreachable: "无法连接",
  too_many_redirects: "重定向次数过多",
  http_status: "服务器返回错误",
  no_items: "未解析到通知条目",
  error: "抓取出错",
};

export function failureText(failure: Failure, detail?: string) {
  return detail ? `${FAILURES[failure]}（${detail}）` : FAILURES[failure];
}

type Run = { failure: Failure | null; detail: string; notice_failure_count: number };

// How a round went (design §7.5): the list page read or not, and the notices it couldn't fetch.
export function RunResult({ run, className }: { run: Run; className?: string }) {
  const [tone, text] = run.failure
    ? ["text-destructive", `列表页抓取失败：${failureText(run.failure, run.detail)}`]
    : run.notice_failure_count > 0
      ? ["text-warning", `${run.notice_failure_count} 条通知抓取失败`]
      : ["text-success", "抓取成功"];
  return (
    <span className={cn("inline-flex items-start gap-1.5", tone, className)}>
      {/* Level with the middle of the first line, 1.5em high, should the text wrap. */}
      <span
        aria-hidden="true"
        className="mt-[calc(0.75em-0.1875rem)] size-1.5 shrink-0 rounded-full bg-current"
      />
      {text}
    </span>
  );
}
