import { cn } from "~/cn";
import type { AttachmentFailureKind } from "../../server/modules/programs/schemas.ts";
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

const ATTACHMENT_FAILURES: Record<AttachmentFailureKind, string> = {
  download_failed: "未能下载",
  too_large: "文件超过 10MB",
  unreadable: "文件无法读取",
};

export function attachmentFailureText(failure: AttachmentFailureKind, detail?: string) {
  return detail ? `${ATTACHMENT_FAILURES[failure]}（${detail}）` : ATTACHMENT_FAILURES[failure];
}

type Run = {
  failure: Failure | null;
  detail: string;
  notice_failure_count: number;
  attachment_failure_count: number;
};

// How a round went (design §7.5): the list page read or not, and the notices and attachments it
// couldn't fetch.
export function RunResult({ run, className }: { run: Run; className?: string }) {
  const missed = [
    run.notice_failure_count > 0 && `${run.notice_failure_count} 条通知抓取失败`,
    run.attachment_failure_count > 0 && `${run.attachment_failure_count} 个附件未能读取`,
  ].filter((text) => text !== false);
  const [tone, text] = run.failure
    ? ["text-destructive", `列表页抓取失败：${failureText(run.failure, run.detail)}`]
    : missed.length > 0
      ? ["text-warning", missed.join("，")]
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
