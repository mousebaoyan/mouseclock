import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import type { TimeValue } from "../../server/modules/programs/schemas.ts";
import type { createApi } from "../api.server.ts";
import { DEGREES, fieldLabel, formatValue, MODES } from "../fields.ts";
import { TIME_HINT, timeText } from "../time.ts";
import { Field, FormMessage } from "./form.tsx";
import { PROGRAM_KINDS, Tag } from "./tags.tsx";
import { DateTime } from "./time.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Select } from "./ui/select.tsx";

type ProgramApi = ReturnType<typeof createApi>["programs"][":id"];
type Program = InferResponseType<ProgramApi["$get"], 200>;
export type Edit = InferResponseType<ProgramApi["edits"]["$get"], 200>["edits"][number];

// What a form edits: the program's name, cohort and kind, or one of its fields.
export type EditField =
  | "program"
  | "apply"
  | "apply_url"
  | "event"
  | "dates"
  | "degrees"
  | "majors"
  | "requirements"
  | "materials"
  | "assessment"
  | "quota"
  | "benefits"
  | "contacts";

// Opens a field's form in place: the address says which, so a reload keeps it open.
export function EditLink({ field, label = "修改" }: { field: EditField; label?: string }) {
  return (
    <Link
      to={`?edit=${field}`}
      replace
      preventScrollReset
      className={buttonVariants({ variant: "ghost", size: "xs", className: "-my-1" })}
    >
      {label}
    </Link>
  );
}

// A field's form. Its inputs' names are what program-edit.server.ts reads.
export function EditForm({
  field,
  program,
  error,
}: {
  field: EditField;
  program: Program;
  error?: string;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form
      method="post"
      preventScrollReset
      className="space-y-4 rounded-xl border border-primary/30 bg-card p-4 shadow-card"
    >
      <input type="hidden" name="intent" value="edit" />
      <input type="hidden" name="field" value={field} />
      <Inputs field={field} program={program} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="修改理由">
          <input
            name="reason"
            required
            maxLength={500}
            placeholder="例如：补充通知将截止时间调整为 6 月 20 日"
            className="field"
          />
        </Field>
        <Field label="修改依据" hint="原文链接或截图链接">
          <input name="basis" required maxLength={2000} className="field" />
        </Field>
      </div>
      <FormMessage error={error} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy}>
          {busy ? "正在保存…" : "保存"}
        </Button>
        <Link
          to="."
          replace
          preventScrollReset
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          取消
        </Link>
      </div>
    </Form>
  );
}

const CLEAR_HINT = "全部留空即清除该项";

function Inputs({ field, program }: { field: EditField; program: Program }) {
  const { fields } = program;
  if (field === "program") {
    return (
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem_8rem]">
        <Field label="项目名称">
          <input
            name="name"
            required
            maxLength={200}
            defaultValue={program.name}
            className="field"
          />
        </Field>
        <Field label="届">
          <input
            name="cohort"
            inputMode="numeric"
            pattern="\d{4}"
            required
            defaultValue={program.cohort}
            className="field"
          />
        </Field>
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">类型</span>
          <Select
            name="kind"
            aria-label="类型"
            defaultValue={program.kind}
            options={Object.entries(PROGRAM_KINDS).map(([value, { label }]) => ({
              value,
              label,
            }))}
          />
        </div>
      </div>
    );
  }
  if (field === "apply") {
    const { start, end, rolling } = fields.apply ?? {};
    return (
      <Times hint={`${TIME_HINT}；${CLEAR_HINT}`}>
        <TimeInput name="start" label="报名开始" value={start?.value} />
        <TimeInput name="end" label="报名截止" value={end?.value} />
        <div className="flex items-end pb-2">
          <Checkbox name="rolling" defaultChecked={rolling !== undefined}>
            额满即止
          </Checkbox>
        </div>
      </Times>
    );
  }
  if (field === "event") {
    const { start, end, mode, place } = fields.event ?? {};
    return (
      <Times hint={`${TIME_HINT}；${CLEAR_HINT}`}>
        <TimeInput name="start" label="活动开始" value={start?.value} />
        <TimeInput name="end" label="活动结束" value={end?.value} />
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">活动形式</span>
          <Select
            name="mode"
            aria-label="活动形式"
            defaultValue={mode?.value ?? ""}
            options={[
              { value: "", label: "未注明" },
              ...Object.entries(MODES).map(([value, label = value]) => ({ value, label })),
            ]}
          />
        </div>
        <Field label="活动地点">
          <input name="place" maxLength={500} defaultValue={place?.value} className="field" />
        </Field>
      </Times>
    );
  }
  if (field === "dates") {
    // Two empty rows for dates the notice gave that aren't here yet.
    const rows: { label: string; start?: TimeValue; end?: TimeValue }[] = [
      ...(fields.dates ?? []).map((date) => ({ label: date.label, ...date.value })),
      { label: "" },
      { label: "" },
    ];
    return (
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-[13px] font-medium">其他时间安排</legend>
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <input
              name="label"
              aria-label="名称"
              placeholder="名称，例如初试"
              maxLength={50}
              defaultValue={row.label}
              className="field col-span-2 sm:col-span-1"
            />
            <input
              name="start"
              aria-label="开始"
              placeholder="开始"
              defaultValue={row.start && timeText(row.start)}
              className="field"
            />
            <input
              name="end"
              aria-label="结束"
              placeholder="结束"
              defaultValue={row.end && timeText(row.end)}
              className="field"
            />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{TIME_HINT}；清空一行即删除该时间</p>
      </fieldset>
    );
  }
  if (field === "degrees") {
    const chosen = fields.degrees?.value ?? [];
    return (
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">招收类型</legend>
        <div className="flex gap-5">
          {Object.entries(DEGREES).map(([value, label]) => (
            <Checkbox
              key={value}
              name="degrees"
              value={value}
              defaultChecked={chosen.some((degree) => degree === value)}
            >
              {label}
            </Checkbox>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field === "apply_url" || field === "quota") {
    return (
      <Field label={fieldLabel(field)} hint={CLEAR_HINT}>
        <input
          name="value"
          maxLength={field === "quota" ? 500 : 2000}
          defaultValue={fields[field]?.value}
          className="field"
        />
      </Field>
    );
  }
  return (
    <Field label={fieldLabel(field)} hint={`每行填写一项；${CLEAR_HINT}`}>
      <textarea
        name="value"
        rows={4}
        defaultValue={fields[field]?.value.join("\n")}
        className="field h-auto py-2 leading-relaxed"
      />
    </Field>
  );
}

function Times({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function TimeInput({ name, label, value }: { name: string; label: string; value?: TimeValue }) {
  return (
    <Field label={label}>
      <input name={name} defaultValue={value && timeText(value)} className="field" />
    </Field>
  );
}

// A program's edits, the latest first (design §12.4). Editors can revert each; admins can revert
// all someone's edits and take back their editing.
export function EditHistory({
  edits,
  thisYear,
  canEdit,
  canAdmin,
  error,
}: {
  edits: Edit[];
  thisYear: number;
  canEdit: boolean;
  canAdmin: boolean;
  error?: string;
}) {
  const busy = useNavigation().state !== "idle";
  const [search] = useSearchParams();
  const revoking = canAdmin
    ? edits.find((edit) => String(edit.user.id) === search.get("revoke"))
    : undefined;
  if (edits.length === 0) {
    return <p className="text-[13px] text-muted-foreground">暂无修改记录</p>;
  }
  return (
    <div className="space-y-3">
      <FormMessage error={error} />
      {revoking && (
        <Form
          method="post"
          preventScrollReset
          className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <input type="hidden" name="intent" value="revoke" />
          <input type="hidden" name="user_id" value={revoking.user.id} />
          <p>
            确认撤销 {revoking.user.display_name}
            在所有项目上的全部修改，并收回其修改权限？撤销后又被他人修改过的字段将保留
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy}>
              确认撤销
            </Button>
            <Link
              to="."
              replace
              preventScrollReset
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              取消
            </Link>
          </div>
        </Form>
      )}
      <ol className="relative space-y-4 border-l pl-5">
        {edits.map((edit, i) => (
          <li key={edit.id} className="relative text-sm">
            <span
              aria-hidden="true"
              className="absolute top-1.5 -left-[24.5px] size-2 rounded-full border-2 border-card bg-input ring-1 ring-input"
            />
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{edit.user.display_name}</span>
              <span className="text-muted-foreground">
                {edit.reverts_id === null ? "修改了" : `撤销了 #${edit.reverts_id} 的`}
                {fieldLabel(edit.field)}
              </span>
              {edit.reverted && <Tag color="gray">已撤销</Tag>}
              <span className="text-xs text-subtle-foreground">
                #{edit.id}　<DateTime value={edit.created_at} />
                {edit.via === "agent" && "　通过 Agent"}
              </span>
            </p>
            <div className="mt-1.5 grid gap-1 rounded-md bg-muted/70 px-3 py-2 text-[13px] sm:grid-cols-[3rem_minmax(0,1fr)]">
              <span className="text-muted-foreground">修改前</span>
              <span className="text-muted-foreground line-through decoration-1">
                {formatValue(edit.field, edit.old_value, thisYear)}
              </span>
              <span className="text-muted-foreground">修改后</span>
              <span>{formatValue(edit.field, edit.new_value, thisYear)}</span>
            </div>
            {edit.reason !== null && (
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                理由：{edit.reason}
                {edit.basis !== null && (
                  <>
                    　依据：
                    <Basis basis={edit.basis} />
                  </>
                )}
              </p>
            )}
            {(canEdit || canAdmin) && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {canEdit && !edit.reverted && (
                  <Form method="post" preventScrollReset>
                    <input type="hidden" name="intent" value="revert" />
                    <input type="hidden" name="edit_id" value={edit.id} />
                    <Button variant="ghost" size="xs" disabled={busy} className="-ml-2">
                      撤销此修改
                    </Button>
                  </Form>
                )}
                {/* Once a person, at their latest edit. */}
                {canAdmin && edits.findIndex((item) => item.user.id === edit.user.id) === i && (
                  <Link
                    to={`?revoke=${edit.user.id}#edits`}
                    replace
                    preventScrollReset
                    className={buttonVariants({
                      variant: "ghost",
                      size: "xs",
                      className: "text-destructive hover:text-destructive",
                    })}
                  >
                    撤销此人的全部修改
                  </Link>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// A link when it is one, and text otherwise.
function Basis({ basis }: { basis: string }) {
  if (!/^https?:\/\//.test(basis)) return basis;
  return (
    <a href={basis} target="_blank" rel="nofollow noopener" className="link break-all">
      {basis}
    </a>
  );
}
