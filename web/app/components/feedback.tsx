import type { InferResponseType } from "hono/client";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { DateWindow, StoredValue, TimeValue } from "../../server/modules/programs/schemas.ts";
import type { createApi } from "../api.server.ts";
import { DEGREES, fieldLabel, formatValue, MODES } from "../fields.ts";
import { TIME_HINT, timeText } from "../time.ts";
import { Field, FormMessage } from "./form.tsx";
import type { EditField } from "./program-edit.tsx";
import { PROGRAM_KINDS, Tag, type TagColor } from "./tags.tsx";
import { DateTime } from "./time.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Select } from "./ui/select.tsx";

type ProgramApi = ReturnType<typeof createApi>["programs"][":id"];
type Program = InferResponseType<ProgramApi["$get"], 200>;
export type Feedback = InferResponseType<ProgramApi["feedback"]["$get"], 200>["feedback"][number];

// Feedback on a program (design §12.1): what is wrong, or what it should be, about one place.

// Opens the form for a field, or for the program as a whole with "program".
export function FeedbackLink({ group }: { group: EditField }) {
  return (
    <Link
      to={`?feedback=${group}`}
      replace
      preventScrollReset
      className={buttonVariants({ variant: "ghost", size: "xs", className: "-my-1" })}
    >
      反馈
    </Link>
  );
}

const LISTS = ["majors", "requirements", "materials", "assessment", "benefits", "contacts"];

// The places a field's feedback can be about: each part of one made of parts.
function named(fields: string[]) {
  return fields.map((field) => ({ field, label: fieldLabel(field) }));
}

function placesOf(group: EditField, program: Program): { field: string | null; label: string }[] {
  if (group === "program") {
    return [{ field: null, label: "整个项目" }, ...named(["name", "cohort", "kind"])];
  }
  if (group === "apply") return named(["apply:start", "apply:end", "apply:rolling"]);
  if (group === "event") return named(["event:start", "event:end", "event:mode", "event:place"]);
  if (group === "dates") return named((program.fields.dates ?? []).map((d) => `dates:${d.label}`));
  return named([group]);
}

// What a place is now.
function currentOf(program: Program, field: string): StoredValue | undefined {
  const { fields } = program;
  if (field === "name" || field === "cohort" || field === "kind") return program[field];
  if (field.startsWith("dates:")) {
    return fields.dates?.find((d) => `dates:${d.label}` === field)?.value;
  }
  const [name, part] = field.split(":");
  if (name === "apply" && (part === "start" || part === "end" || part === "rolling")) {
    return fields.apply?.[part]?.value;
  }
  if (
    name === "event" &&
    (part === "start" || part === "end" || part === "mode" || part === "place")
  ) {
    return fields.event?.[part]?.value;
  }
  const { apply_url, degrees, majors, requirements, materials, assessment, quota } = fields;
  const plain: Partial<Record<string, { value: StoredValue }>> = {
    apply_url,
    degrees,
    majors,
    requirements,
    materials,
    assessment,
    quota,
    benefits: fields.benefits,
    contacts: fields.contacts,
  };
  return plain[field]?.value;
}

// The form: which place, whether it is just wrong or should be something else, and why. Its
// inputs' names are what feedbackValue in program-edit.server.ts reads. Editors can edit instead.
export function FeedbackForm({
  group,
  program,
  canEdit,
  error,
}: {
  group: EditField;
  program: Program;
  canEdit: boolean;
  error?: string;
}) {
  const busy = useNavigation().state !== "idle";
  const places = placesOf(group, program);
  const [place, setPlace] = useState(places[0]?.field ?? null);
  const [kind, setKind] = useState<"problem" | "edit">("problem");
  const editing = kind === "edit" && place !== null;
  return (
    <Form
      method="post"
      preventScrollReset
      className="space-y-4 rounded-xl border border-primary/30 bg-card p-4 text-sm shadow-card"
    >
      <input type="hidden" name="intent" value="feedback" />
      <input type="hidden" name="group" value={group} />
      {places.length > 1 && (
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">说的是哪一处</span>
          <Select
            name="field"
            aria-label="说的是哪一处"
            value={place ?? ""}
            onValueChange={(value) => setPlace(value || null)}
            options={places.map((p) => ({ value: p.field ?? "", label: p.label }))}
            className="sm:w-48"
          />
        </div>
      )}
      {places.length === 1 && <input type="hidden" name="field" value={place ?? ""} />}
      {place !== null && (
        <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
          <legend className="sr-only">反馈的种类</legend>
          {(
            [
              ["problem", "这里不对"],
              ["edit", "应该改成"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="radio"
                name="kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="accent-primary"
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      {editing && <ValueInput key={place} field={place} current={currentOf(program, place)} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={editing ? "理由" : "哪里不对"}>
          <input
            name="reason"
            required
            maxLength={500}
            placeholder={editing ? "例如：补充通知调整了截止时间" : "例如：截止和原文对不上"}
            className="field"
          />
        </Field>
        <Field label={editing ? "依据" : "依据（选填）"} hint="原文链接或截图链接">
          <input name="basis" required={editing} maxLength={2000} className="field" />
        </Field>
      </div>
      <FormMessage error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || places.length === 0}>
          {busy ? "正在提交…" : editing ? "提交修改申请" : "提交反馈"}
        </Button>
        <Link
          to="."
          replace
          preventScrollReset
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          取消
        </Link>
        {canEdit && (
          <Link
            to={`?edit=${group}`}
            replace
            preventScrollReset
            className="ml-auto text-[13px] text-primary hover:underline"
          >
            也可以直接修改
          </Link>
        )}
      </div>
    </Form>
  );
}

function isTime(value: StoredValue | undefined): value is TimeValue {
  return (
    typeof value === "object" && !Array.isArray(value) && ("date" in value || "month" in value)
  );
}

function isWindow(value: StoredValue | undefined): value is DateWindow {
  return typeof value === "object" && !Array.isArray(value) && ("start" in value || "end" in value);
}

// What the place should be, as the direct edit form takes it; left empty, cleared.
function ValueInput({ field, current }: { field: string; current: StoredValue | undefined }) {
  if (field.startsWith("dates:")) {
    const window = isWindow(current) ? current : undefined;
    return (
      <div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="开始">
            <input
              name="start"
              defaultValue={window && "start" in window ? timeText(window.start) : undefined}
              className="field"
            />
          </Field>
          <Field label="结束">
            <input
              name="end"
              defaultValue={window?.end && timeText(window.end)}
              className="field"
            />
          </Field>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{TIME_HINT}；都留空即清除</p>
      </div>
    );
  }
  if (field.endsWith(":start") || field.endsWith(":end")) {
    return (
      <Field label={`改成的${fieldLabel(field)}`} hint={`${TIME_HINT}；留空即清除`}>
        <input
          name="value"
          defaultValue={isTime(current) ? timeText(current) : undefined}
          className="field sm:w-64"
        />
      </Field>
    );
  }
  if (field === "apply:rolling") {
    return (
      <Checkbox name="value" defaultChecked={current === true}>
        额满即止（不勾即清除）
      </Checkbox>
    );
  }
  if (field === "event:mode" || field === "kind") {
    const labels =
      field === "kind"
        ? Object.fromEntries(
            Object.entries(PROGRAM_KINDS).map(([value, { label }]) => [value, label]),
          )
        : MODES;
    return (
      <div className="space-y-1.5">
        <span className="block text-[13px] font-medium">改成</span>
        <Select
          name="value"
          aria-label="改成"
          defaultValue={typeof current === "string" ? current : ""}
          options={[
            ...(field === "kind" ? [] : [{ value: "", label: "未注明" }]),
            ...Object.entries(labels).map(([value, label = value]) => ({ value, label })),
          ]}
          className="sm:w-48"
        />
      </div>
    );
  }
  if (field === "degrees") {
    const chosen = Array.isArray(current) ? current : [];
    return (
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1.5 text-[13px] font-medium">改成（都不勾即清除）</legend>
        {Object.entries(DEGREES).map(([value, label]) => (
          <Checkbox
            key={value}
            name="degrees"
            value={value}
            defaultChecked={chosen.includes(value)}
          >
            {label}
          </Checkbox>
        ))}
      </fieldset>
    );
  }
  if (LISTS.includes(field)) {
    return (
      <Field label="改成" hint="一行一条；留空即清除">
        <textarea
          name="value"
          rows={4}
          defaultValue={Array.isArray(current) ? current.join("\n") : undefined}
          className="field h-auto py-2 leading-relaxed"
        />
      </Field>
    );
  }
  return (
    <Field label="改成" hint={field === "name" || field === "cohort" ? undefined : "留空即清除"}>
      <input
        name="value"
        required={field === "name" || field === "cohort"}
        inputMode={field === "cohort" ? "numeric" : undefined}
        defaultValue={
          typeof current === "string" || typeof current === "number" ? current : undefined
        }
        className="field"
      />
    </Field>
  );
}

export const FEEDBACK_STATUSES: Record<Feedback["status"], { label: string; color: TagColor }> = {
  pending: { label: "待处理", color: "amber" },
  accepted: { label: "已处理", color: "green" },
  rejected: { label: "未采纳", color: "gray" },
  withdrawn: { label: "已撤回", color: "gray" },
};

// What one said, and what it asks the place to be.
export function FeedbackBody({ feedback, thisYear }: { feedback: Feedback; thisYear: number }) {
  return (
    <div className="space-y-1 text-[13px]">
      <p className="flex flex-wrap items-center gap-2">
        <Tag color={feedback.kind === "edit" ? "blue" : "orange"}>
          {feedback.kind === "edit" ? "应该改成" : "这里不对"}
        </Tag>
        <span className="font-medium">
          {feedback.field === null ? "整个项目" : fieldLabel(feedback.field)}
        </span>
      </p>
      {feedback.kind === "edit" && feedback.field !== null && (
        <p>
          <span className="text-muted-foreground">改成：</span>
          {formatValue(feedback.field, feedback.proposed_value, thisYear)}
        </p>
      )}
      <p className="text-pretty wrap-anywhere">
        <span className="text-muted-foreground">
          {feedback.kind === "edit" ? "理由：" : "说明："}
        </span>
        {feedback.reason}
      </p>
      {feedback.basis && (
        <p className="wrap-anywhere">
          <span className="text-muted-foreground">依据：</span>
          {/^https?:\/\//.test(feedback.basis) ? (
            <a href={feedback.basis} target="_blank" rel="nofollow noopener" className="link">
              {feedback.basis}
            </a>
          ) : (
            feedback.basis
          )}
        </p>
      )}
    </div>
  );
}

// The program's feedback waiting, so no one gives the same again; one's own can be withdrawn.
export function WaitingFeedback({
  feedback,
  me,
  thisYear,
}: {
  feedback: Feedback[];
  me: number | undefined;
  thisYear: number;
}) {
  const busy = useNavigation().state !== "idle";
  if (feedback.length === 0) {
    return <p className="text-[13px] text-muted-foreground">没有待处理的反馈</p>;
  }
  return (
    <ol className="space-y-3">
      {feedback.map((f) => (
        <li key={f.id} className="space-y-1.5 border-b pb-3 last:border-0 last:pb-0">
          <FeedbackBody feedback={f} thisYear={thisYear} />
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-subtle-foreground">
            {f.user.display_name}
            <DateTime value={f.created_at} />
            {f.via === "agent" && "通过 Agent"}
            {f.user.id === me && (
              <Form method="post" preventScrollReset className="ml-auto">
                <input type="hidden" name="intent" value="withdraw_feedback" />
                <input type="hidden" name="feedback_id" value={f.id} />
                <Button variant="ghost" size="xs" disabled={busy}>
                  撤回
                </Button>
              </Form>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
