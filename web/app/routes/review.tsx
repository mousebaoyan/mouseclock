import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { data, Form, Link, useNavigation } from "react-router";
import { cn } from "~/cn";
import { FormMessage } from "~/components/form";
import { ExternalLink } from "~/components/icons";
import { Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { KindTag, PROGRAM_KINDS, type TagColor } from "~/components/tags";
import { DateTime } from "~/components/time";
import { Button, buttonVariants } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { fieldLabel, formatValue } from "../fields.ts";
import { beijingYear, formatApply } from "../time.ts";
import { KINDS } from "../../server/modules/programs/schemas.ts";
import type { Route } from "./+types/review.ts";

type Api = ReturnType<typeof createApi>;
type Items = InferResponseType<Api["review-items"]["$get"], 200>;
type Item = Items["items"][number];
type Reason = Items["reason"];
type Edits = InferResponseType<Api["edits"]["$get"], 200>;

// Why each item waits (design §8.3, §8.4), in the order the API lists them.
const REASONS: Record<Reason, { label: string; color: TagColor; hint: string }> = {
  no_deadline: {
    label: "缺少截止时间",
    color: "red",
    hint: "通知中未找到报名截止时间：原文确未写明的选择「原文未写明」，已写明的请到项目页补充",
  },
  conflicts_edit: {
    label: "与人工修改冲突",
    color: "orange",
    hint: "新通知改动了人工修改过的字段，总表暂时保留人工修改的值，通过后改用通知中的值",
  },
  implausible: {
    label: "数值异常",
    color: "amber",
    hint: "报名截止早于通知发布日期，可能抽取有误，请对照原文确认",
  },
  evidence_not_found: {
    label: "证据未找到",
    color: "violet",
    hint: "抽取给出的原文句子在快照中找不到，请对照原文确认",
  },
  low_confidence: {
    label: "置信度低",
    color: "sky",
    hint: "模型对该值把握不足，请对照原文确认",
  },
  unknown_program: {
    label: "项目编号不符",
    color: "blue",
    hint: "抽取认为这是已有项目，但该校没有对应编号，请选择要归入的项目或新建",
  },
  unknown_college: {
    label: "学院不符",
    color: "teal",
    hint: "抽取出的学院不属于该校，请选择要归入的项目，或选择学院后新建",
  },
  implausible_cohort: {
    label: "届别异常",
    color: "pink",
    hint: "届别应在通知发布年份到其后两年之间，请选择要归入的项目，或修正届别后新建",
  },
  possible_duplicate: {
    label: "疑似重复",
    color: "green",
    hint: "与已有项目的学院、届别和类型相同：同一项目请合并，另一批次请保留",
  },
};

const DOTS: Record<TagColor, string> = {
  red: "bg-tag-red",
  orange: "bg-tag-orange",
  amber: "bg-tag-amber",
  green: "bg-tag-green",
  teal: "bg-tag-teal",
  sky: "bg-tag-sky",
  blue: "bg-tag-blue",
  violet: "bg-tag-violet",
  pink: "bg-tag-pink",
  gray: "bg-tag-gray",
};

function isReason(value: string | null): value is Reason {
  return value !== null && Object.hasOwn(REASONS, value);
}

export function meta() {
  return [{ title: "审核 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const params = new URL(request.url).searchParams;
  const reason = params.get("reason");
  const [items, edits] = await Promise.all([
    api["review-items"]
      .$get({
        query: {
          reason: isReason(reason) ? reason : undefined,
          page: params.get("page") ?? undefined,
          per_page: params.get("per_page") ?? undefined,
        },
      })
      .then((res) => readApi<Items>(res)),
    api.edits
      .$get({
        query: {
          page: params.get("edits_page") ?? undefined,
          per_page: params.get("edits_per_page") ?? undefined,
        },
      })
      .then((res) => readApi<Edits>(res)),
  ]);
  return { items, edits, thisYear: beijingYear(new Date()) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext)["review-items"][":id"];
  const form = await request.formData();
  const intent = formText(form, "intent");
  const param = { id: formText(form, "id") };
  const number = (name: string) => {
    const value = formText(form, name);
    return value ? Number(value) : undefined;
  };
  // The program to merge into, or for a new one the college, cohort and kind the form also has.
  const decision =
    number("program_id") !== undefined || !form.has("college_id")
      ? { program_id: number("program_id") }
      : {
          college_id: number("college_id"),
          cohort: number("cohort"),
          kind: KINDS.find((kind) => kind === formText(form, "kind")),
        };
  if (intent !== "accept" && intent !== "reject") throw data("不支持的操作", { status: 400 });
  const res =
    intent === "accept"
      ? await api.accept.$post({ param, json: decision })
      : await api.reject.$post({ param });
  if (res.status === 204) return null;
  return data({ id: Number(param.id), error: (await res.json()).error.message }, res.status);
}

export default function Review({ loaderData, actionData }: Route.ComponentProps) {
  const { items, edits, thisYear } = loaderData;
  const reason = REASONS[items.reason];
  return (
    <Page title="审核" hideTitle>
      <div className="grid items-start gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav
          aria-label="待审核的类别"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:sticky lg:top-20 lg:flex lg:flex-col lg:gap-0.5 lg:rounded-lg lg:border lg:bg-card lg:p-1.5"
        >
          {Object.entries(REASONS).map(([key, { label, color }]) => {
            const on = key === items.reason;
            const count = items.counts[key] ?? 0;
            return (
              <Link
                key={key}
                to={`?reason=${key}`}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-[13px] whitespace-nowrap lg:border-transparent",
                  on
                    ? "border-primary/40 bg-primary-soft font-medium text-primary lg:border-primary/30"
                    : "bg-card text-foreground/85 hover:bg-accent lg:bg-transparent",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 rounded-full", DOTS[color])}
                />
                <span className="flex-1">{label}</span>
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    count === 0
                      ? "text-subtle-foreground"
                      : on
                        ? "text-primary"
                        : "text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 space-y-5">
          <Panel title={reason.label} description={reason.hint} flush>
            {items.items.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-muted-foreground sm:px-5">
                「{reason.label}」类别下的条目已全部处理
              </p>
            ) : (
              <ol className="divide-y">
                {items.items.map((item) => (
                  <li key={item.id} className="space-y-3 px-4 py-4 sm:px-5">
                    <ItemHeader item={item} />
                    {item.field ? (
                      <FieldItem item={item} field={item.field} thisYear={thisYear} />
                    ) : (
                      <ProgramItem item={item} reason={items.reason} thisYear={thisYear} />
                    )}
                    {actionData?.id === item.id && <FormMessage error={actionData.error} />}
                  </li>
                ))}
              </ol>
            )}
            <div className="px-4 pb-4 empty:hidden sm:px-5">
              <Pagination total={items.total} page={items.page} perPage={items.per_page} />
            </div>
          </Panel>
          <Panel title="最近修改" flush>
            {edits.items.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-muted-foreground sm:px-5">暂无修改记录</p>
            ) : (
              <ol className="divide-y">
                {edits.items.map((edit) => (
                  <li
                    key={edit.id}
                    className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
                  >
                    <p className="min-w-0">
                      <span className="font-medium">{edit.user.display_name}</span>
                      <span className="text-muted-foreground">
                        {edit.reverts_id === null
                          ? " 修改了 "
                          : ` 撤销了 #${edit.reverts_id}，涉及 `}
                      </span>
                      <Link to={`/programs/${edit.program.id}#edits`} className="link">
                        {edit.program.school} {edit.program.college} {edit.program.name}
                      </Link>
                      <span className="text-muted-foreground"> 的{fieldLabel(edit.field)}</span>
                    </p>
                    <p className="text-xs text-subtle-foreground sm:row-span-2 sm:text-right">
                      #{edit.id}　<DateTime value={edit.created_at} />
                    </p>
                    <p className="text-[13px]">
                      <span className="text-muted-foreground line-through decoration-1">
                        {formatValue(edit.field, edit.old_value, thisYear)}
                      </span>
                      <span className="mx-1.5 text-subtle-foreground">→</span>
                      {formatValue(edit.field, edit.new_value, thisYear)}
                      {edit.reason !== null && (
                        <span className="ml-3 text-muted-foreground">理由：{edit.reason}</span>
                      )}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <div className="px-4 pb-4 empty:hidden sm:px-5">
              <Pagination
                total={edits.total}
                page={edits.page}
                perPage={edits.per_page}
                prefix="edits_"
              />
            </div>
          </Panel>
        </div>
      </div>
    </Page>
  );
}

function ItemHeader({ item }: { item: Item }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        {item.program && (
          <Link
            to={`/programs/${item.program.id}`}
            className="link font-medium break-keep wrap-anywhere"
          >
            {item.program.school} {item.program.college} {item.program.name}
          </Link>
        )}
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          来源通知：
          <Link to={`/snapshots/${item.notice.snapshot_id}`} className="link">
            {item.notice.title}
          </Link>
          <a
            href={item.notice.url}
            target="_blank"
            rel="nofollow noopener"
            className="link ml-2 inline-flex items-center gap-0.5"
          >
            原文
            <ExternalLink className="size-3" />
          </a>
        </p>
      </div>
      <p className="text-xs text-subtle-foreground">
        #{item.id}　<DateTime value={item.created_at} />
      </p>
    </div>
  );
}

function FieldItem({
  item,
  field,
  thisYear,
}: {
  item: Item;
  field: NonNullable<Item["field"]>;
  thisYear: number;
}) {
  const { current } = field;
  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <p className="flex items-center justify-between gap-3 border-b bg-muted/60 px-3 py-1.5 text-[13px]">
          <span className="font-medium">{fieldLabel(field.key)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            置信度 {field.confidence.toFixed(2)}
          </span>
        </p>
        <dl className="grid divide-y text-sm sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">抽取值（第 {field.version} 版）</dt>
            <dd className="mt-1 font-medium">{formatValue(field.key, field.value, thisYear)}</dd>
          </div>
          <div className="px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">
              当前值
              {current !== null &&
                (current.version === null ? "（人工修改）" : `（第 ${current.version} 版）`)}
            </dt>
            <dd className="mt-1">
              {current === null ? (
                <span className="text-subtle-foreground">总表中尚无此项</span>
              ) : (
                formatValue(field.key, current.value, thisYear)
              )}
            </dd>
          </div>
        </dl>
        <div className="space-y-1.5 border-t px-3 py-2.5">
          {field.evidence.map(({ quote, attachment }) => (
            <blockquote
              key={quote}
              className="border-l-2 border-primary/50 pl-3 text-[13px] leading-relaxed text-pretty"
            >
              {quote}
              {attachment !== undefined && (
                <span className="text-muted-foreground">（第 {attachment + 1} 个附件）</span>
              )}
            </blockquote>
          ))}
        </div>
      </div>
      <Decide id={item.id} accept="通过并写入总表" reject="驳回" />
    </>
  );
}

function ProgramItem({ item, reason, thisYear }: { item: Item; reason: Reason; thisYear: number }) {
  const busy = useNavigation().state !== "idle";
  const extracted = item.extracted;
  if (!extracted) return null;
  const { program, colleges, programs } = extracted;
  const college = colleges.find((c) => c.id === program.college_id);
  const collegeName = (id: number) => colleges.find((c) => c.id === id)?.name ?? "";
  const summary = (
    <div className="rounded-md border px-3 py-2.5 text-sm">
      <p className="text-xs text-muted-foreground">抽取结果</p>
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <KindTag kind={program.kind} />
        <span className="font-medium">{program.name}</span>
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {program.cohort} 届　
        {college?.name ?? `学院编号 ${program.college_id}（不在该校的学院清单中）`}
        {program.program_id !== undefined && `　项目编号 ${program.program_id}`}　报名时间：
        {formatApply(program.fields.apply?.value ?? null, thisYear)}
      </p>
    </div>
  );
  if (reason === "no_deadline") {
    return (
      <Decide id={item.id} accept="原文未写明" reject="已补充，关闭此条">
        {item.program && (
          <Link
            to={`/programs/${item.program.id}?edit=apply`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            前往补充报名时间
          </Link>
        )}
      </Decide>
    );
  }
  if (reason === "possible_duplicate") {
    const self = item.program?.id;
    const similar = programs.filter(
      (p) =>
        p.id !== self &&
        p.college_id === program.college_id &&
        p.cohort === program.cohort &&
        p.kind === program.kind,
    );
    return (
      <>
        {summary}
        <div className="flex flex-wrap items-center gap-2">
          <Form
            method="post"
            preventScrollReset
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            <input type="hidden" name="intent" value="accept" />
            <input type="hidden" name="id" value={item.id} />
            {similar.length > 0 && (
              <Select
                name="program_id"
                aria-label="原项目"
                options={similar.map((p) => ({
                  value: String(p.id),
                  label: `${p.name}（报名时间：${formatApply(p.apply, thisYear)}）`,
                }))}
                className="h-8 w-auto max-w-full"
              />
            )}
            <Button size="sm" disabled={busy || similar.length === 0}>
              合并到所选项目
            </Button>
          </Form>
          <Decide id={item.id} accept="不是重复，保留" acceptVariant="outline" />
        </div>
      </>
    );
  }
  return (
    <>
      {summary}
      <Form method="post" preventScrollReset className="space-y-3">
        <input type="hidden" name="id" value={item.id} />
        <Choice title="归入已有项目">
          <Select
            name="program_id"
            aria-label="已有项目"
            defaultValue=""
            options={[
              { value: "", label: "不归入，新建项目（在下方选择学院与届别）" },
              ...programs.map((p) => ({
                value: String(p.id),
                label: `${collegeName(p.college_id)}　${p.cohort} 届　${PROGRAM_KINDS[p.kind].label}　${p.name}`,
              })),
            ]}
          />
        </Choice>
        <Choice title="或新建项目">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem]">
            <Select
              name="college_id"
              aria-label="学院"
              defaultValue={String(college?.id ?? colleges[0].id)}
              options={colleges.map((c) => ({ value: String(c.id), label: c.name }))}
            />
            <input
              name="cohort"
              inputMode="numeric"
              pattern="\d{4}"
              aria-label="届"
              defaultValue={program.cohort}
              className="field"
            />
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
        </Choice>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" name="intent" value="accept" disabled={busy}>
            通过并归并
          </Button>
          <Button size="sm" variant="outline" name="intent" value="reject" disabled={busy}>
            驳回，不归并此通知
          </Button>
        </div>
      </Form>
    </>
  );
}

function Choice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-medium">{title}</p>
      {children}
    </div>
  );
}

// Accepting with nothing to choose, and rejecting.
function Decide({
  id,
  accept,
  acceptVariant,
  reject,
  children,
}: {
  id: number;
  accept?: string;
  acceptVariant?: "outline";
  reject?: string;
  children?: ReactNode;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form method="post" preventScrollReset className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {accept && (
        <Button size="sm" variant={acceptVariant} name="intent" value="accept" disabled={busy}>
          {accept}
        </Button>
      )}
      {reject && (
        <Button size="sm" variant="outline" name="intent" value="reject" disabled={busy}>
          {reject}
        </Button>
      )}
      {children}
    </Form>
  );
}
