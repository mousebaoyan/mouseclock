import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import type { TimeValue } from "../../server/modules/programs/schemas.ts";
import type { createApi } from "../api.server.ts";
import { DEGREES, fieldLabel, formatValue, MODES } from "../fields.ts";
import { TIME_HINT, timeText } from "../time.ts";
import { CrawlTime, Field, inputClass, linkClass } from "./admin.tsx";
import { PROGRAM_KINDS, Tag } from "./tags.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";

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
export function EditLink({ field }: { field: EditField }) {
  return (
    <Link
      to={`?edit=${field}`}
      replace
      preventScrollReset
      className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      修改
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
      className="mt-2 space-y-3 rounded-lg border border-border bg-background p-3 sm:p-4"
    >
      <input type="hidden" name="intent" value="edit" />
      <input type="hidden" name="field" value={field} />
      <Inputs field={field} program={program} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="理由">
          <input
            name="reason"
            required
            maxLength={500}
            placeholder="比如：补充通知把截止改到了 6 月 20 日"
            className={inputClass}
          />
        </Field>
        <Field label="依据" hint="原文链接，或截图的链接">
          <input name="basis" required maxLength={2000} className={inputClass} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </Button>
        <Link
          to="."
          replace
          preventScrollReset
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          取消
        </Link>
      </div>
    </Form>
  );
}

function Inputs({ field, program }: { field: EditField; program: Program }) {
  const { fields } = program;
  if (field === "program") {
    return (
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem_8rem]">
        <Field label="名称">
          <input
            name="name"
            required
            maxLength={200}
            defaultValue={program.name}
            className={inputClass}
          />
        </Field>
        <Field label="届">
          <input
            name="cohort"
            type="number"
            required
            defaultValue={program.cohort}
            className={inputClass}
          />
        </Field>
        <Field label="类型">
          <select name="kind" defaultValue={program.kind} className={inputClass}>
            {Object.entries(PROGRAM_KINDS).map(([kind, { label }]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    );
  }
  if (field === "apply") {
    const { start, end, rolling } = fields.apply ?? {};
    return (
      <Times hint={`${TIME_HINT}；都不写就是清空。`}>
        <TimeInput name="start" label="开始" value={start?.value} />
        <TimeInput name="end" label="截止" value={end?.value} />
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="rolling" defaultChecked={rolling !== undefined} />
          额满即止
        </label>
      </Times>
    );
  }
  if (field === "event") {
    const { start, end, mode, place } = fields.event ?? {};
    return (
      <Times hint={`${TIME_HINT}；都不写就是清空。`}>
        <TimeInput name="start" label="开始" value={start?.value} />
        <TimeInput name="end" label="结束" value={end?.value} />
        <Field label="形式">
          <select name="mode" defaultValue={mode?.value ?? ""} className={inputClass}>
            <option value="">未说明</option>
            {Object.entries(MODES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="地点">
          <input name="place" maxLength={500} defaultValue={place?.value} className={inputClass} />
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
      <fieldset className="space-y-3 sm:space-y-2">
        <legend className="text-sm font-medium">其他时间</legend>
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <input
              name="label"
              aria-label="名称"
              placeholder="名称，比如初试"
              maxLength={50}
              defaultValue={row.label}
              className={`${inputClass} col-span-2 sm:col-span-1`}
            />
            <input
              name="start"
              aria-label="开始"
              placeholder="开始"
              defaultValue={row.start && timeText(row.start)}
              className={inputClass}
            />
            <input
              name="end"
              aria-label="结束"
              placeholder="结束"
              defaultValue={row.end && timeText(row.end)}
              className={inputClass}
            />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{TIME_HINT}；清空一行就是去掉这个时间。</p>
      </fieldset>
    );
  }
  if (field === "degrees") {
    const chosen = fields.degrees?.value ?? [];
    return (
      <fieldset>
        <legend className="mb-2 text-sm font-medium">招收类型</legend>
        <div className="flex gap-4">
          {Object.entries(DEGREES).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="degrees"
                value={value}
                defaultChecked={chosen.some((degree) => degree === value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field === "apply_url" || field === "quota") {
    return (
      <Field label={fieldLabel(field)} hint="不写就是清空。">
        <input
          name="value"
          maxLength={field === "quota" ? 500 : 2000}
          defaultValue={fields[field]?.value}
          className={inputClass}
        />
      </Field>
    );
  }
  return (
    <Field label={fieldLabel(field)} hint="一行一项；都不写就是清空。">
      <textarea
        name="value"
        rows={4}
        defaultValue={fields[field]?.value.join("\n")}
        className={inputClass}
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
      <input name={name} defaultValue={value && timeText(value)} className={inputClass} />
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
    return <p className="mt-3 text-sm text-muted-foreground">还没有人改过这个项目。</p>;
  }
  return (
    <>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {revoking && (
        <Form
          method="post"
          preventScrollReset
          className="mt-3 space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <input type="hidden" name="intent" value="revoke" />
          <input type="hidden" name="user_id" value={revoking.user.id} />
          <p>
            撤销{revoking.user.display_name}
            在所有项目上的全部修改，并收回这个人在鼠钟的修改权限？之后又被别人改过的留着不撤。
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy}>
              确定撤销
            </Button>
            <Link
              to="."
              replace
              preventScrollReset
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              取消
            </Link>
          </div>
        </Form>
      )}
      <ol className="mt-2 divide-y divide-border">
        {edits.map((edit, i) => (
          <li key={edit.id} className="space-y-1 py-3.5 text-sm">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{edit.user.display_name}</span>
              <span className="text-muted-foreground">
                {edit.reverts_id === null ? "修改了" : `撤销了 #${edit.reverts_id}：`}
                {fieldLabel(edit.field)}
              </span>
              {edit.reverted && <Tag color="gray">已撤销</Tag>}
              <span className="text-xs text-muted-foreground">
                #{edit.id} · <CrawlTime value={edit.created_at} />
                {edit.via === "agent" && " · 通过 Agent"}
              </span>
            </p>
            <p>
              <span className="text-muted-foreground line-through decoration-1">
                {formatValue(edit.field, edit.old_value, thisYear)}
              </span>
              {" → "}
              {formatValue(edit.field, edit.new_value, thisYear)}
            </p>
            {edit.reason !== null && (
              <p className="text-muted-foreground">
                理由：{edit.reason}
                {edit.basis !== null && (
                  <>
                    {" · 依据："}
                    <Basis basis={edit.basis} />
                  </>
                )}
              </p>
            )}
            {(canEdit || canAdmin) && (
              <div className="flex flex-wrap gap-3 pt-0.5">
                {canEdit && !edit.reverted && (
                  <Form method="post" preventScrollReset>
                    <input type="hidden" name="intent" value="revert" />
                    <input type="hidden" name="edit_id" value={edit.id} />
                    <button disabled={busy} className={`${linkClass} text-xs`}>
                      撤销
                    </button>
                  </Form>
                )}
                {/* Once a person, at their latest edit. */}
                {canAdmin && edits.findIndex((item) => item.user.id === edit.user.id) === i && (
                  <Link
                    to={`?revoke=${edit.user.id}#edits`}
                    replace
                    preventScrollReset
                    className="text-xs text-destructive underline-offset-4 hover:underline"
                  >
                    撤销此人的全部修改
                  </Link>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

// A link when it is one, and text otherwise.
function Basis({ basis }: { basis: string }) {
  if (!/^https?:\/\//.test(basis)) return basis;
  return (
    <a href={basis} target="_blank" rel="nofollow noopener" className={`${linkClass} break-all`}>
      {basis}
    </a>
  );
}
