import type { InferResponseType } from "hono/client";
import { useState } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { createApi } from "../api.server.ts";
import { formatValue } from "../fields.ts";
import type { loader as rootLoader } from "../root.tsx";
import type { action } from "../routes/review.tsx";
import { FEEDBACK_STATUSES, FeedbackBody } from "./feedback.tsx";
import { FormMessage } from "./form.tsx";
import { Tag } from "./tags.tsx";
import { DateTime } from "./time.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";
import { Deciding, useDecision } from "./review-decision.tsx";

type Api = ReturnType<typeof createApi>;
type Queued = InferResponseType<Api["feedback"]["$get"], 200>["items"][number];
type Dispute = InferResponseType<Api["disputes"]["$get"], 200>["disputes"][number];

function isColumn(field: string) {
  return field === "name" || field === "cohort" || field === "kind";
}

// Which form of the program's page edits a place: its field, or the program's own.
function formOf(field: string | null) {
  if (field === null || isColumn(field)) return "program";
  return field.split(":")[0];
}

// Where a field's value came from; a program's name, cohort and kind don't keep that.
function sourceOf(item: Queued) {
  if (item.field === null || isColumn(item.field) || item.current_value === null) return null;
  return item.current_version === null ? "人工修改" : `第 ${item.current_version} 版通知`;
}

function ProgramLink({ program }: { program: Queued["program"] }) {
  return (
    <Link
      to={`/programs/${program.id}`}
      className="font-medium break-keep wrap-anywhere hover:text-primary"
    >
      {program.school} {program.college} {program.name}
    </Link>
  );
}

// One feedback waiting (design §12.2): what the place is now beside what it was, and deciding it.
// An edit request is accepted as asked; a problem once fixed on the program's page. No one
// decides their own.
export function FeedbackCard({ item, thisYear }: { item: Queued; thisYear: number }) {
  const me = useRouteLoaderData<typeof rootLoader>("root")?.me;
  const { result, decision, decide, undo } = useDecision<typeof action>();
  const edit = item.kind === "edit";
  const source = sourceOf(item);
  return (
    <article aria-busy={decision !== null} className="rounded-xl border bg-card shadow-card">
      <header className="space-y-0.5 border-b px-4 py-3 sm:px-5">
        <ProgramLink program={item.program} />
        <p className="text-xs text-subtle-foreground">
          {item.user.display_name} 提于 <DateTime value={item.created_at} />
          {item.via === "agent" && "，通过 Agent"}
        </p>
      </header>
      {decision && <Deciding decision={decision} undo={undo} />}
      <div hidden={decision !== null} className="space-y-3 px-4 py-4 sm:px-5">
        <FeedbackBody feedback={item} thisYear={thisYear} />
        {item.field !== null && (
          <div className="grid gap-1 rounded-md bg-muted/70 px-3 py-2 text-[13px] sm:grid-cols-[4rem_minmax(0,1fr)]">
            <span className="text-muted-foreground">现在</span>
            <span>
              {formatValue(item.field, item.current_value, thisYear)}
              {source && <span className="ml-2 text-muted-foreground">（{source}）</span>}
            </span>
            {item.changed && (
              <>
                <span className="text-muted-foreground">提的时候</span>
                <span className="flex flex-wrap items-center gap-2">
                  {formatValue(item.field, item.old_value, thisYear)}
                  <Tag color="amber">提了以后变过</Tag>
                </span>
              </>
            )}
          </div>
        )}
        {item.user.id === me?.id ? (
          <p className="text-[13px] text-muted-foreground">自己提的，由别人处理</p>
        ) : (
          <form method="post" onSubmit={decide} className="space-y-2">
            <input type="hidden" name="id" value={item.id} />
            <input
              name="note"
              required
              maxLength={500}
              aria-label="不采纳的理由"
              placeholder={edit ? "驳回的理由" : "没问题的理由"}
              className="field"
            />
            <div className="flex flex-wrap gap-2">
              <Button name="intent" value="feedback_accept" size="sm" formNoValidate>
                {edit ? "通过，照申请改" : "已改正"}
              </Button>
              <Button name="intent" value="feedback_reject" variant="outline" size="sm">
                {edit ? "驳回" : "没问题"}
              </Button>
              {!edit && (
                <Link
                  to={`/programs/${item.program.id}?edit=${formOf(item.field)}`}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  去项目页改
                </Link>
              )}
            </div>
          </form>
        )}
        <FormMessage error={result?.error} />
      </div>
    </article>
  );
}

// A disputed program for an admin (design §12.3): the feedback that made it so, and the review
// that closes it, corrected or confirmed, with a note that is each feedback's result.
export function DisputeCard({ dispute, thisYear }: { dispute: Dispute; thisYear: number }) {
  const { result, decision, decide, undo } = useDecision<typeof action>();
  const [outcome, setOutcome] = useState<"corrected" | "confirmed">("confirmed");
  return (
    <article aria-busy={decision !== null} className="rounded-xl border bg-card shadow-card">
      <header className="space-y-0.5 border-b px-4 py-3 sm:px-5">
        <ProgramLink program={dispute.program} />
        <p className="text-xs text-subtle-foreground">
          <DateTime value={dispute.opened_at} /> 标上有争议
          <Link to={`/programs/${dispute.program.id}#edits`} className="link ml-3">
            修改记录
          </Link>
        </p>
      </header>
      {decision && <Deciding decision={decision} undo={undo} />}
      <div hidden={decision !== null} className="space-y-4 px-4 py-4 sm:px-5">
        <ol className="space-y-3">
          {dispute.feedback.map((f) => (
            <li key={f.id} className="space-y-1 border-b pb-3 last:border-0 last:pb-0">
              <FeedbackBody feedback={f} thisYear={thisYear} />
              <p className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                {f.user.display_name} 提于 <DateTime value={f.created_at} />
                <Tag color={FEEDBACK_STATUSES[f.status].color}>
                  {FEEDBACK_STATUSES[f.status].label}
                </Tag>
                {f.review?.note && <span>：{f.review.note}</span>}
              </p>
            </li>
          ))}
        </ol>
        <form method="post" onSubmit={decide} className="space-y-2">
          <input type="hidden" name="intent" value="resolve_dispute" />
          <input type="hidden" name="id" value={dispute.id} />
          <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
            <legend className="sr-only">复核结果</legend>
            {(
              [
                ["corrected", "已改正"],
                ["confirmed", "确认没错"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="radio"
                  name="result"
                  value={value}
                  checked={outcome === value}
                  onChange={() => setOutcome(value)}
                  className="accent-primary"
                />
                {label}
              </label>
            ))}
          </fieldset>
          <input
            name="note"
            required
            maxLength={500}
            aria-label="复核说明"
            placeholder={outcome === "corrected" ? "改了什么" : "为什么没错"}
            className="field"
          />
          <Button size="sm">提交复核</Button>
        </form>
        <FormMessage error={result?.error} />
      </div>
    </article>
  );
}
