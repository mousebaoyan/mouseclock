import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { data, Form, Link, redirect, useRouteLoaderData, useSearchParams } from "react-router";
import { FormMessage } from "~/components/form";
import { ExternalLink, Quote } from "~/components/icons";
import { Facts, Page, Panel } from "~/components/page";
import {
  EditForm,
  EditHistory,
  EditLink,
  type Edit,
  type EditField,
} from "~/components/program-edit";
import { ApplyDeadline, ApplyStart, Missing, ProgramStatus } from "~/components/program";
import { KindTag, RoleTag, Tag, TierTag } from "~/components/tags";
import { DateTime } from "~/components/time";
import { Button, buttonVariants } from "~/components/ui/button";
import { Reveal } from "~/components/ui/reveal";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { DEGREES, fieldLabel, MODES } from "../fields.ts";
import { editValues, FormError } from "../program-edit.server.ts";
import type { loader as rootLoader } from "../root.tsx";
import { beijingYear, formatApply, formatWindow, useNow } from "../time.ts";
import type { Route } from "./+types/program-detail.ts";

type ProgramApi = ReturnType<typeof createApi>["programs"][":id"];
type Program = InferResponseType<ProgramApi["$get"], 200>;
type Version = InferResponseType<ProgramApi["versions"]["$get"], 200>["versions"][number];
type Fields = Program["fields"];
// What every field and part has besides its value.
type Support = Pick<NonNullable<Fields["quota"]>, "evidence" | "version">;
type FieldRow = {
  field: EditField;
  label: string;
  value: ReactNode;
  parts: [string | null, Support | undefined][];
};

// Fields the notices didn't state show only to editors, to fill in.
function stated(row: FieldRow) {
  return row.parts.some(([, part]) => part !== undefined);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const { program } = loaderData;
  return [{ title: `${program.name} · ${program.school.name} · 鼠钟` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const api = context.get(apiContext).programs[":id"];
  const param = { id: params.id };
  const [program, { versions }, { edits }] = await Promise.all([
    api.$get({ param }).then((res) => readApi<Program>(res)),
    api.versions.$get({ param }).then((res) => readApi<{ versions: Version[] }>(res)),
    api.edits.$get({ param }).then((res) => readApi<{ edits: Edit[] }>(res)),
  ]);
  return {
    program,
    versions,
    edits,
    thisYear: beijingYear(new Date()),
    now: Math.floor(Date.now() / 1000),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const form = await request.formData();
  const intent = formText(form, "intent");
  const param = { id: params.id };
  if (intent === "edit") {
    const field = formText(form, "field");
    let values;
    try {
      values = editValues(field, form);
    } catch (error) {
      if (error instanceof FormError) return data({ intent, field, error: error.message }, 400);
      throw error;
    }
    const json = { ...values, reason: formText(form, "reason"), basis: formText(form, "basis") };
    const res = await api.programs[":id"].$patch({ param, json });
    if (res.status !== 200) {
      return data({ intent, field, error: (await res.json()).error.message }, res.status);
    }
    return redirect(`/programs/${params.id}`);
  }
  if (intent !== "verify" && intent !== "revert" && intent !== "revoke") {
    throw data("不支持的操作", { status: 400 });
  }
  const res = await (intent === "verify"
    ? api.programs[":id"].verify.$post({ param })
    : intent === "revert"
      ? api.edits[":id"].revert.$post({ param: { id: formText(form, "edit_id") } })
      : api.admin.users[":id"]["revoke-edits"].$post({ param: { id: formText(form, "user_id") } }));
  // Back to the page without the form or confirmation the address opened.
  if (res.status === 200 || res.status === 204) return redirect(`/programs/${params.id}`);
  return data({ intent, field: null, error: (await res.json()).error.message }, res.status);
}

export default function ProgramDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { program, versions, edits, thisYear } = loaderData;
  const { school, college, notice, verified } = program;
  const now = useNow(loaderData.now);
  const can = useRouteLoaderData<typeof rootLoader>("root")?.me?.can;
  const [search] = useSearchParams();
  const editing = can?.edit ? search.get("edit") : null;
  const rows = rowsOf(program.fields, thisYear, Boolean(can?.edit));
  const apply = program.fields.apply;
  const applyValue = apply
    ? { start: apply.start?.value, end: apply.end?.value, rolling: apply.rolling?.value }
    : null;
  const applyUrl = program.fields.apply_url?.value;
  const { event } = program.fields;
  const formError = (field: string) =>
    actionData?.intent === "edit" && actionData.field === field ? actionData.error : undefined;
  return (
    <Page
      title={program.name}
      crumbs={[
        { to: "/", label: "项目总表" },
        { to: `/colleges/${college.id}`, label: `${school.name}${college.name}` },
      ]}
      meta={
        <>
          <span className="text-foreground">{school.name}</span>
          <TierTag tier={school.tier} />
          <Link to={`/colleges/${college.id}`} className="hover:text-primary">
            {college.name}
          </Link>
          <span>{program.cohort} 届</span>
          <KindTag kind={program.kind} />
          {verified && <Tag color="green">已核对</Tag>}
          {notice.removed && <Tag color="gray">原文已删除</Tag>}
        </>
      }
      actions={
        <>
          {can?.edit && editing !== "program" && (
            <Link
              to="?edit=program"
              replace
              preventScrollReset
              className={buttonVariants({ variant: "ghost" })}
            >
              修改基本信息
            </Link>
          )}
          <a
            href={notice.url}
            target="_blank"
            rel="nofollow noopener"
            className={buttonVariants({ variant: applyUrl ? "outline" : "default" })}
          >
            查看通知原文
            <ExternalLink />
          </a>
          {applyUrl && (
            <a href={applyUrl} target="_blank" rel="nofollow noopener" className={buttonVariants()}>
              报名入口
              <ExternalLink />
            </a>
          )}
        </>
      }
    >
      {editing === "program" && (
        <EditForm field="program" program={program} error={formError("program")} />
      )}
      <Facts
        items={[
          { label: "报名开始", value: <ApplyStart apply={applyValue} thisYear={thisYear} /> },
          { label: "报名截止", value: <ApplyDeadline apply={applyValue} thisYear={thisYear} /> },
          { label: "报名状态", value: <ProgramStatus program={program} now={now} /> },
          {
            label: "活动时间",
            value: event ? (
              formatWindow({ start: event.start?.value, end: event.end?.value }, thisYear) || (
                <Missing />
              )
            ) : (
              <Missing />
            ),
          },
        ]}
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-5">
          <Panel title="项目信息" flush>
            {rows.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted-foreground sm:px-5">
                尚未从通知中整理出项目信息
              </p>
            ) : (
              <dl className="divide-y">
                {rows.map((row) => (
                  <div
                    key={row.field}
                    className="px-4 py-3.5 sm:grid sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-4 sm:px-5"
                  >
                    <dt className="text-[13px] text-muted-foreground sm:pt-px">{row.label}</dt>
                    <dd className="mt-1 min-w-0 text-sm sm:mt-0">
                      {editing === row.field ? (
                        <EditForm
                          field={row.field}
                          program={program}
                          error={formError(row.field)}
                        />
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 leading-relaxed">
                              {stated(row) ? row.value : <Missing />}
                            </div>
                            {can?.edit && <EditLink field={row.field} />}
                          </div>
                          {stated(row) && <Evidence parts={row.parts} versions={versions} />}
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
          <Panel id="edits" title="修改记录">
            <EditHistory
              edits={edits}
              thisYear={thisYear}
              canEdit={Boolean(can?.edit)}
              canAdmin={Boolean(can?.admin)}
              error={
                actionData?.intent === "revert" || actionData?.intent === "revoke"
                  ? actionData.error
                  : undefined
              }
            />
          </Panel>
        </div>
        <aside className="space-y-5">
          {can?.edit && (
            <Panel title="核对">
              {verified ? (
                <p className="text-[13px] text-muted-foreground">
                  {verified.by} 已于 <DateTime value={verified.at} /> 核对全部字段
                </p>
              ) : (
                <Form method="post" preventScrollReset className="space-y-3">
                  <input type="hidden" name="intent" value="verify" />
                  <p className="text-[13px] text-muted-foreground">
                    对照原文核对全部字段后再标记，出现新版本或有人修改后标记自动取消
                  </p>
                  <Button size="sm" variant="outline">
                    标记为已核对
                  </Button>
                  {actionData?.intent === "verify" && <FormMessage error={actionData.error} />}
                </Form>
              )}
            </Panel>
          )}
          <Panel title="版本记录" flush>
            <ol className="divide-y">
              {versions.map((version) => (
                <li key={version.number} className="px-4 py-3 text-sm sm:px-5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">第 {version.number} 版</span>
                    <RoleTag role={version.role} />
                    {version.notice.removed && <Tag color="gray">原文已删除</Tag>}
                  </p>
                  <a
                    href={version.notice.url}
                    target="_blank"
                    rel="nofollow noopener"
                    className="link mt-1 block text-[13px] text-pretty"
                  >
                    {version.notice.title}
                  </a>
                  {/* The first version brings every field, so only later ones say which. */}
                  {version.number > 1 && version.changes.length > 0 && (
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      更新字段：{version.changes.map(fieldLabel).join("、")}
                    </p>
                  )}
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {version.notice.published_on && (
                      <span>发布于 {version.notice.published_on}</span>
                    )}
                    <span>
                      抓取于 <DateTime value={version.snapshot.fetched_at} />
                    </span>
                    <Link to={`/snapshots/${version.snapshot.id}`} className="link">
                      查看快照
                      {version.attachments.length > 0 && `及 ${version.attachments.length} 个附件`}
                    </Link>
                  </p>
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </Page>
  );
}

// Each part's sentences from the notice, and which version they came from. Parts that rest on the
// same sentences of the same version, as an event's dates and place often do, show them once.
function Evidence({ parts, versions }: { parts: FieldRow["parts"]; versions: Version[] }) {
  const groups: { key: string; labels: string[]; part: Support }[] = [];
  for (const [label, part] of parts) {
    if (!part) continue;
    const key = JSON.stringify([part.evidence, part.version?.number]);
    const group = groups.find((item) => item.key === key);
    if (!group) groups.push({ key, labels: label ? [label] : [], part });
    else if (label) group.labels.push(label);
  }
  return (
    <Reveal label="原文证据" icon={<Quote className="size-3.5" />} className="mt-1.5">
      <div className="space-y-2.5 rounded-md border bg-muted/50 p-3">
        {groups.map(({ key, labels, part }) => {
          const from = part.version;
          const files = from && versions.find((item) => item.number === from.number)?.attachments;
          return (
            <div key={key} className="space-y-1.5">
              {groups.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground">{labels.join("、")}</p>
              )}
              {part.evidence.map(({ quote, attachment }) => (
                <blockquote
                  key={quote}
                  className="border-l-2 border-primary/50 pl-3 text-[13px] leading-relaxed text-pretty"
                >
                  {quote}
                  {attachment !== undefined && (
                    <span className="text-muted-foreground">
                      （附件：
                      {files?.find((item) => item.position === attachment)?.name ??
                        `第 ${attachment + 1} 个`}
                      ）
                    </span>
                  )}
                </blockquote>
              ))}
              <p className="text-xs text-muted-foreground">
                {from ? (
                  <>
                    出自第 {from.number} 版：
                    <Link to={`/snapshots/${from.snapshot_id}`} className="link">
                      {from.notice.title}
                    </Link>
                  </>
                ) : (
                  <>
                    来自人工修改，详见
                    <a href="#edits" className="link">
                      修改记录
                    </a>
                  </>
                )}
              </p>
            </div>
          );
        })}
      </div>
    </Reveal>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-4.5 marker:text-subtle-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

const LISTS = [
  "majors",
  "requirements",
  "materials",
  "assessment",
  "benefits",
  "contacts",
] as const;

// The fields in the order of design §8.2. Editors also get the ones not stated, to fill in.
function rowsOf(fields: Fields, thisYear: number, editor: boolean) {
  const rows: FieldRow[] = [];
  const add = (row: FieldRow) => {
    if (editor || stated(row)) rows.push(row);
  };
  const { apply, apply_url, event, dates, degrees, quota } = fields;
  const list = (field: (typeof LISTS)[number]) => {
    const value = fields[field];
    add({
      field,
      label: fieldLabel(field),
      value: value && <List items={value.value} />,
      parts: [[null, value]],
    });
  };
  add({
    field: "apply",
    label: "报名时间",
    value:
      apply &&
      formatApply(
        { start: apply.start?.value, end: apply.end?.value, rolling: apply.rolling?.value },
        thisYear,
      ),
    parts: [
      ["开始", apply?.start],
      ["截止", apply?.end],
      ["额满即止", apply?.rolling],
    ],
  });
  add({
    field: "apply_url",
    label: fieldLabel("apply_url"),
    value: apply_url && (
      <a href={apply_url.value} target="_blank" rel="nofollow noopener" className="link break-all">
        {apply_url.value.replace(/^mailto:/, "")}
      </a>
    ),
    parts: [[null, apply_url]],
  });
  add({
    field: "event",
    label: "活动安排",
    value:
      event &&
      [
        formatWindow({ start: event.start?.value, end: event.end?.value }, thisYear),
        event.mode && MODES[event.mode.value],
        event.place?.value,
      ]
        .filter(Boolean)
        .join("，"),
    parts: [
      ["开始", event?.start],
      ["结束", event?.end],
      ["形式", event?.mode],
      ["地点", event?.place],
    ],
  });
  add({
    field: "dates",
    label: "其他时间安排",
    value: dates && (
      <ul className="space-y-0.5">
        {dates.map((date) => (
          <li key={date.label}>
            {date.label}：{formatWindow(date.value, thisYear)}
          </li>
        ))}
      </ul>
    ),
    parts: (dates ?? []).map((date) => [date.label, date]),
  });
  add({
    field: "degrees",
    label: fieldLabel("degrees"),
    value: degrees && degrees.value.map((degree) => DEGREES[degree]).join("、"),
    parts: [[null, degrees]],
  });
  list("majors");
  list("requirements");
  list("materials");
  list("assessment");
  add({ field: "quota", label: fieldLabel("quota"), value: quota?.value, parts: [[null, quota]] });
  list("benefits");
  list("contacts");
  return rows;
}
