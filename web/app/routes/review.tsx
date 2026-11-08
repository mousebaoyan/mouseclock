import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { data, Form, Link, useNavigation } from "react-router";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { CrawlTime, inputClass, linkClass, panelClass } from "../components/admin.tsx";
import { Pagination } from "../components/pagination.tsx";
import { Chip, KindTag, PROGRAM_KINDS, type TagColor } from "../components/tags.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
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
    label: "没有截止",
    color: "red",
    hint: "报名通知里没找到报名截止：原文确实没写的关掉；写了的到项目页补上报名时间。",
  },
  conflicts_edit: {
    label: "和人改的冲突",
    color: "orange",
    hint: "新的通知改了人改过的字段，表上先留着人改的：通过就换成通知里的。",
  },
  implausible: {
    label: "明显不对",
    color: "amber",
    hint: "报名截止早于通知的发布日期，多半抽错了：对照原文，对的再通过。",
  },
  evidence_not_found: {
    label: "证据找不到",
    color: "violet",
    hint: "抽取给的原文在快照里找不到：对照原文，值对的再通过。",
  },
  low_confidence: {
    label: "拿不准",
    color: "sky",
    hint: "模型拿不准的值：对照原文，对的再通过。",
  },
  unknown_program: {
    label: "编号对不上",
    color: "blue",
    hint: "抽取说是已有的项目，这所学校却没有这个编号：选一个项目并进去，或者新建。",
  },
  unknown_college: {
    label: "学院对不上",
    color: "teal",
    hint: "抽出来的学院不是这所学校的：选一个项目并进去，或者选好学院新建。",
  },
  implausible_cohort: {
    label: "届不对",
    color: "pink",
    hint: "届应在通知发布的年份到之后两年之间：选一个项目并进去，或者改好届新建。",
  },
  possible_duplicate: {
    label: "可能重复",
    color: "green",
    hint: "新建的项目和已有的同一学院、同一届、同一类型：是同一个就并进原来的，第二批这类另算的就保留。",
  },
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
  if (intent !== "accept" && intent !== "reject") throw data("未知操作", { status: 400 });
  const res =
    intent === "accept"
      ? await api.accept.$post({ param, json: decision })
      : await api.reject.$post({ param });
  if (res.status === 204) return null;
  return data({ id: Number(param.id), error: (await res.json()).error.message }, res.status);
}

export default function Review({ loaderData, actionData }: Route.ComponentProps) {
  const { items, edits, thisYear } = loaderData;
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-3 py-6 sm:px-5">
      <header>
        <h1 className="text-2xl font-semibold">审核</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          抽取拿不准的字段和项目在这里由人决定：对照原文，通过就上表，驳回就只关掉这一条（总体设计
          §12.2）。每次处理都记进操作日志。
        </p>
      </header>

      <section className={panelClass}>
        <nav aria-label="待审的种类" className="flex flex-wrap gap-2">
          {Object.entries(REASONS).map(([reason, { label, color }]) => (
            <Chip key={reason} to={`?reason=${reason}`} on={reason === items.reason} color={color}>
              {label} {items.counts[reason] ?? 0}
            </Chip>
          ))}
        </nav>
        {items.items.length > 0 && (
          <p className="mt-3 text-sm text-muted-foreground">{REASONS[items.reason].hint}</p>
        )}
        {items.items.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            「{REASONS[items.reason].label}」的条目都处理完了。
          </p>
        ) : (
          <ol className="mt-2 divide-y divide-border">
            {items.items.map((item) => (
              <li key={item.id} className="space-y-2 py-4 text-sm">
                <ItemHeader item={item} />
                {item.field ? (
                  <FieldItem item={item} field={item.field} thisYear={thisYear} />
                ) : (
                  <ProgramItem item={item} reason={items.reason} thisYear={thisYear} />
                )}
                {actionData?.id === item.id && (
                  <p role="alert" className="text-destructive">
                    {actionData.error}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
        <Pagination total={items.total} page={items.page} perPage={items.per_page} />
      </section>

      <section className={panelClass}>
        <h2 className="text-lg font-semibold">最近修改</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          全站的人工修改和撤销，在项目的详情页能撤销。
        </p>
        {edits.items.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">还没有人改过。</p>
        ) : (
          <ol className="mt-2 divide-y divide-border">
            {edits.items.map((edit) => (
              <li key={edit.id} className="space-y-1 py-3 text-sm">
                <p className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{edit.user.display_name}</span>
                  <span className="text-muted-foreground">
                    {edit.reverts_id === null ? "修改了" : `撤销了 #${edit.reverts_id}：`}
                  </span>
                  <Link to={`/programs/${edit.program.id}#edits`} className={linkClass}>
                    {edit.program.school} · {edit.program.college} · {edit.program.name}
                  </Link>
                  <span className="text-muted-foreground">的{fieldLabel(edit.field)}</span>
                </p>
                <p>
                  <span className="text-muted-foreground line-through decoration-1">
                    {formatValue(edit.field, edit.old_value, thisYear)}
                  </span>
                  {" → "}
                  {formatValue(edit.field, edit.new_value, thisYear)}
                </p>
                <p className="text-xs text-muted-foreground">
                  #{edit.id} · <CrawlTime value={edit.created_at} />
                  {edit.reason !== null && ` · 理由：${edit.reason}`}
                </p>
              </li>
            ))}
          </ol>
        )}
        <Pagination
          total={edits.total}
          page={edits.page}
          perPage={edits.per_page}
          prefix="edits_"
        />
      </section>
    </main>
  );
}

function ItemHeader({ item }: { item: Item }) {
  return (
    <div className="space-y-1">
      {item.program && (
        <p>
          <Link to={`/programs/${item.program.id}`} className={`${linkClass} font-medium`}>
            {item.program.school} · {item.program.college} · {item.program.name}
          </Link>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        通知：
        <Link to={`/snapshots/${item.notice.snapshot_id}`} className={linkClass}>
          {item.notice.title}
        </Link>
        {" · "}
        <a href={item.notice.url} target="_blank" rel="nofollow noopener" className={linkClass}>
          原文
        </a>
        {" · "}#{item.id} · <CrawlTime value={item.created_at} />
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
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[7rem_1fr]">
        <dt className="text-muted-foreground">{fieldLabel(field.key)}</dt>
        <dd>
          第 {field.version} 版抽出来的：
          <span className="font-medium">{formatValue(field.key, field.value, thisYear)}</span>
          <span className="text-xs text-muted-foreground">
            （置信度 {field.confidence.toFixed(2)}）
          </span>
        </dd>
        <dt className="text-muted-foreground">原文</dt>
        <dd className="space-y-1">
          {field.evidence.map(({ quote, attachment }) => (
            <blockquote key={quote} className="border-l-2 border-brand/50 pl-3 text-pretty">
              {quote}
              {attachment !== undefined && (
                <span className="text-muted-foreground">（第 {attachment + 1} 个附件）</span>
              )}
            </blockquote>
          ))}
        </dd>
        <dt className="text-muted-foreground">现在</dt>
        <dd>
          {current === null
            ? "表上还没有"
            : `${formatValue(field.key, current.value, thisYear)}（${
                current.version === null ? "人改的" : `来自第 ${current.version} 版`
              }）`}
        </dd>
      </dl>
      <Decide id={item.id} accept="通过，上表" reject="驳回" />
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
    <p className="flex flex-wrap items-center gap-2">
      抽出来的：
      <KindTag kind={program.kind} />
      <span className="font-medium">{program.name}</span>
      <span className="text-muted-foreground">
        {program.cohort} 届 ·{" "}
        {college?.name ?? `学院 ${program.college_id}（不在这所学校的清单里）`}
        {program.program_id !== undefined && ` · 编号 ${program.program_id}`} · 报名时间{" "}
        {formatApply(program.fields.apply?.value ?? null, thisYear)}
      </span>
    </p>
  );
  if (reason === "no_deadline") {
    return (
      <>
        <Decide id={item.id} accept="原文确实没写" reject="已改好，关掉">
          {item.program && (
            <Link
              to={`/programs/${item.program.id}?edit=apply`}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              原文写了，去改报名时间
            </Link>
          )}
        </Decide>
      </>
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
        <Form method="post" preventScrollReset className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="intent" value="accept" />
          <input type="hidden" name="id" value={item.id} />
          <select name="program_id" aria-label="原来的项目" className={`${inputClass} w-auto`}>
            {similar.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（报名 {formatApply(p.apply, thisYear)}）
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={busy || similar.length === 0}>
            是重复的，并进去
          </Button>
        </Form>
        <Decide id={item.id} accept="不是重复的，保留" />
      </>
    );
  }
  return (
    <>
      {summary}
      <Form method="post" preventScrollReset className="space-y-2">
        <input type="hidden" name="id" value={item.id} />
        <Choice title="并进已有的项目">
          <select name="program_id" aria-label="已有的项目" className={inputClass}>
            <option value="">新建一个（在下面选学院和届）</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {collegeName(p.college_id)} · {p.cohort} 届 · {PROGRAM_KINDS[p.kind].label} ·{" "}
                {p.name}
              </option>
            ))}
          </select>
        </Choice>
        <Choice title="或者新建">
          <div className="grid gap-2 sm:grid-cols-[1fr_6rem_7rem]">
            <select
              name="college_id"
              aria-label="学院"
              defaultValue={college?.id}
              className={inputClass}
            >
              {colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              name="cohort"
              type="number"
              aria-label="届"
              defaultValue={program.cohort}
              className={inputClass}
            />
            <select
              name="kind"
              aria-label="类型"
              defaultValue={program.kind}
              className={inputClass}
            >
              {Object.entries(PROGRAM_KINDS).map(([kind, { label }]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </Choice>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" name="intent" value="accept" disabled={busy}>
            通过，归并
          </Button>
          <Button size="sm" variant="ghost" name="intent" value="reject" disabled={busy}>
            驳回，这条通知不归并
          </Button>
        </div>
      </Form>
    </>
  );
}

function Choice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

// Accepting with nothing to choose, and rejecting.
function Decide({
  id,
  accept,
  reject,
  children,
}: {
  id: number;
  accept?: string;
  reject?: string;
  children?: ReactNode;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form method="post" preventScrollReset className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {accept && (
        <Button size="sm" name="intent" value="accept" disabled={busy}>
          {accept}
        </Button>
      )}
      {reject && (
        <Button size="sm" variant="ghost" name="intent" value="reject" disabled={busy}>
          {reject}
        </Button>
      )}
      {children}
    </Form>
  );
}
