import type { InferResponseType } from "hono/client";
import { useState, type ReactNode } from "react";
import { data, Link, useFetcher } from "react-router";
import { cn } from "~/cn";
import { FormMessage } from "~/components/form";
import { ExternalLink } from "~/components/icons";
import { Empty, Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { KindTag, PROGRAM_KINDS, type TagColor } from "~/components/tags";
import { DateTime } from "~/components/time";
import { Button, buttonVariants } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";
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
type Extracted = NonNullable<Item["extracted"]>;
type Edits = InferResponseType<Api["edits"]["$get"], 200>;
type Fetcher = ReturnType<typeof useFetcher<typeof action>>;

// What each kind of item asks of a reviewer (design §8.3, §8.4), in the order the API lists them.
const REASONS: Record<Reason, { label: string; color: TagColor; guide: string }> = {
  unparsed_date: {
    label: "未识别的时间",
    color: "amber",
    guide: "原文写了时间，但程序未能识别是哪一天。需要的话到项目页补上，补完或无需补充时关闭此条。",
  },
  no_deadline: {
    label: "未写截止",
    color: "red",
    guide:
      "报名通知中未找到报名截止时间。打开通知核对：确实没写的选「确实没写」，写了的到项目页补上。",
  },
  conflicts_edit: {
    label: "与人工修改不同",
    color: "orange",
    guide:
      "这些字段有人修改过，新通知又给出了不同的值。总表暂时保留人工修改的值，请决定是否改用新通知的值。",
  },
  implausible: {
    label: "截止早于发布",
    color: "amber",
    guide: "抽取出的报名截止早于通知发布日期，可能有误。对照原文，值正确再写入总表。",
  },
  evidence_not_found: {
    label: "原句未找到",
    color: "violet",
    guide: "模型引用的原句在通知中找不到，值可能有误。对照原文，值正确再写入总表。",
  },
  evidence_in_picture: {
    label: "图片中的文字",
    color: "gray",
    guide:
      "这些值出自图片或扫描件，文字由模型识别，可能有错字。下载附件对照原图，值正确再写入总表。",
  },
  low_confidence: {
    label: "模型不确定",
    color: "sky",
    guide: "模型对这些值把握不足。对照原文，值正确再写入总表。",
  },
  unknown_program: {
    label: "项目对不上",
    color: "blue",
    guide: "模型认为通知属于已有项目，但该校没有对应的项目。请选择它应归入的项目，或新建项目。",
  },
  unknown_college: {
    label: "学院对不上",
    color: "teal",
    guide: "抽取出的学院不属于该校。请选择它应归入的项目，或选好学院后新建项目。",
  },
  implausible_cohort: {
    label: "届别异常",
    color: "pink",
    guide: "届别应在通知发布年份到其后两年之间。请选择它应归入的项目，或改正届别后新建项目。",
  },
  possible_duplicate: {
    label: "可能重复",
    color: "green",
    guide:
      "新建的项目与该校已有项目的学院、届别和类型都相同。同一次报名的请合并；需另外报名的（如第二批、专项计划）请保留。",
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
  const paging = {
    page: params.get("page") ?? undefined,
    per_page: params.get("per_page") ?? undefined,
  };
  const thisYear = beijingYear(new Date());
  if (params.get("tab") === "edits") {
    const edits = await readApi<Edits>(await api.edits.$get({ query: paging }));
    return { tab: "edits" as const, edits, thisYear };
  }
  const reason = params.get("reason");
  const items = await readApi<Items>(
    await api["review-items"].$get({
      query: { reason: isReason(reason) ? reason : undefined, ...paging },
    }),
  );
  return { tab: "items" as const, items, thisYear };
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
  return data({ error: (await res.json()).error.message }, res.status);
}

export default function Review({ loaderData }: Route.ComponentProps) {
  return (
    <Page title="审核" hideTitle>
      <Segmented
        label="审核"
        items={[
          { to: "/review", label: "待审核", on: loaderData.tab === "items" },
          { to: "/review?tab=edits", label: "修改记录", on: loaderData.tab === "edits" },
        ]}
      />
      {loaderData.tab === "items" ? (
        <Queue items={loaderData.items} thisYear={loaderData.thisYear} />
      ) : (
        <EditList edits={loaderData.edits} thisYear={loaderData.thisYear} />
      )}
    </Page>
  );
}

// The kinds that have items, and the items of one kind, each a question to answer in place.
function Queue({ items, thisYear }: { items: Items; thisYear: number }) {
  const waiting = Object.entries(REASONS).filter(([reason]) => items.counts[reason]);
  if (waiting.length === 0) return <Empty>没有待审核的条目</Empty>;
  const { label, guide } = REASONS[items.reason];
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav
        aria-label="待审核的类别"
        className="flex flex-wrap gap-2 lg:sticky lg:top-20 lg:flex-col lg:gap-0.5 lg:rounded-xl lg:border lg:bg-card lg:p-1.5 lg:shadow-card"
      >
        {waiting.map(([reason, kind]) => {
          const on = reason === items.reason;
          return (
            <Link
              key={reason}
              to={`?reason=${reason}`}
              aria-current={on ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-2 rounded-md border px-3 text-[13px] whitespace-nowrap lg:border-transparent",
                on
                  ? "border-primary/40 bg-primary-soft font-medium text-primary"
                  : "bg-card text-foreground/85 hover:bg-accent lg:bg-transparent",
              )}
            >
              <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOTS[kind.color])} />
              <span className="flex-1">{kind.label}</span>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  on ? "text-primary" : "text-muted-foreground",
                )}
              >
                {items.counts[reason]}
              </span>
            </Link>
          );
        })}
      </nav>
      {items.items.length === 0 ? (
        <Empty>「{label}」已全部处理</Empty>
      ) : (
        <section aria-label={label} className="min-w-0 space-y-3">
          <p className="rounded-xl border border-primary/15 bg-primary-soft px-4 py-3 text-[13px] leading-relaxed text-pretty sm:px-5">
            {guide}
          </p>
          <ol className="space-y-3">
            {items.items.map((item) => (
              <li key={item.id}>
                <Card item={item} reason={items.reason} thisYear={thisYear} />
              </li>
            ))}
          </ol>
          <Pagination total={items.total} page={items.page} perPage={items.per_page} />
        </section>
      )}
    </div>
  );
}

// One item: which program and notice it is about, what to decide and the buttons that decide it.
// Each sends on its own, so the rest of the list stays as it is while it does.
function Card({ item, reason, thisYear }: { item: Item; reason: Reason; thisYear: number }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <article
      aria-busy={busy}
      className={cn(
        "rounded-xl border bg-card shadow-card transition-opacity",
        busy && "pointer-events-none opacity-50",
      )}
    >
      <header className="space-y-0.5 border-b px-4 py-3 sm:px-5">
        {item.program && (
          <Link
            to={`/programs/${item.program.id}`}
            className="font-medium break-keep wrap-anywhere hover:text-primary"
          >
            {item.program.school} {item.program.college} {item.program.name}
          </Link>
        )}
        <p className="text-[13px] text-muted-foreground">
          来自通知{" "}
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
      </header>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {item.field ? (
          <FieldCheck
            item={item}
            field={item.field}
            conflict={reason === "conflicts_edit"}
            fetcher={fetcher}
            thisYear={thisYear}
          />
        ) : (
          item.extracted && (
            <ProgramCheck
              item={item}
              extracted={item.extracted}
              reason={reason}
              fetcher={fetcher}
              thisYear={thisYear}
            />
          )
        )}
        <FormMessage error={fetcher.data?.error} />
      </div>
    </article>
  );
}

function FieldCheck({
  item,
  field,
  conflict,
  fetcher,
  thisYear,
}: {
  item: Item;
  field: NonNullable<Item["field"]>;
  conflict: boolean;
  fetcher: Fetcher;
  thisYear: number;
}) {
  const { current } = field;
  const now = current && formatValue(field.key, current.value, thisYear);
  return (
    <>
      <div>
        <p className="text-[13px] text-muted-foreground">{fieldLabel(field.key)}</p>
        {conflict && now !== null ? (
          <dl className="mt-1.5 grid divide-y overflow-hidden rounded-lg border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="px-3.5 py-2.5">
              <dt className="text-xs text-muted-foreground">现在（人工修改）</dt>
              <dd className="mt-1">{now}</dd>
            </div>
            <div className="px-3.5 py-2.5">
              <dt className="text-xs text-muted-foreground">新通知</dt>
              <dd className="mt-1 font-medium">
                <Value fieldKey={field.key} value={field.value} thisYear={thisYear} />
              </dd>
            </div>
          </dl>
        ) : (
          <>
            <div className="mt-0.5 text-[15px] font-medium">
              <Value fieldKey={field.key} value={field.value} thisYear={thisYear} />
            </div>
            {now !== null && now !== formatValue(field.key, field.value, thisYear) && (
              <p className="mt-1 text-[13px] text-muted-foreground">总表现在：{now}</p>
            )}
          </>
        )}
      </div>
      <Evidence evidence={field.evidence} snapshotId={item.notice.snapshot_id} />
      <fetcher.Form method="post" className="flex flex-wrap gap-2">
        <input type="hidden" name="id" value={item.id} />
        <Button name="intent" value="accept">
          {conflict ? "改用新通知的值" : "正确，写入总表"}
        </Button>
        <Button variant="outline" name="intent" value="reject">
          {conflict ? "保留现在的值" : "有误，不写入"}
        </Button>
      </fetcher.Form>
    </>
  );
}

// A list of several things one to a line, anything else as the page shows the field.
function Value({
  fieldKey,
  value,
  thisYear,
}: {
  fieldKey: string;
  value: NonNullable<Item["field"]>["value"];
  thisYear: number;
}) {
  if (Array.isArray(value) && value.length > 1) {
    return (
      <ul className="list-disc space-y-0.5 pl-5">
        {value.map((entry) => (
          <li key={entry}>{formatValue(fieldKey, [entry], thisYear)}</li>
        ))}
      </ul>
    );
  }
  return formatValue(fieldKey, value, thisYear);
}

// The sentences a value was taken from, each with where to check it: the snapshot opened at the
// sentence, or the attachment it is in. Both open beside the list, which keeps its place.
function Evidence({
  evidence,
  snapshotId,
}: {
  evidence: { quote: string; attachment?: number }[];
  snapshotId: number;
}) {
  return (
    <ul className="space-y-2">
      {evidence.map(({ quote, attachment }) => (
        <li key={quote} className="rounded-lg bg-muted/70 px-3.5 py-2.5">
          <blockquote className="text-[13px] leading-relaxed whitespace-pre-line text-pretty">
            {quote}
          </blockquote>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {attachment === undefined ? (
              <>
                出自通知正文
                <a
                  href={quoteLink(snapshotId, quote)}
                  target="_blank"
                  rel="noopener"
                  className="link ml-2"
                >
                  在快照中查看
                </a>
              </>
            ) : (
              <>
                出自附件 {attachment + 1}
                <a
                  href={`/api/v1/snapshots/${snapshotId}/attachments/${attachment}`}
                  download
                  className="link ml-2"
                >
                  下载附件
                </a>
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

// The snapshot scrolled to the quote and marked, where the browser has text fragments; a long
// quote by its first and last words, as it may run across lines and cells.
function quoteLink(snapshotId: number, quote: string) {
  const words = quote.replace(/\s+/g, " ").trim();
  const ends = words.length <= 40 ? [words] : [words.slice(0, 16), words.slice(-16)];
  const text = ends.map((end) => encodeURIComponent(end.trim()).replaceAll("-", "%2D")).join(",");
  return `/snapshots/${snapshotId}#:~:text=${text}`;
}

function ProgramCheck({
  item,
  extracted,
  reason,
  fetcher,
  thisYear,
}: {
  item: Item;
  extracted: Extracted;
  reason: Reason;
  fetcher: Fetcher;
  thisYear: number;
}) {
  const id = <input type="hidden" name="id" value={item.id} />;
  const program = item.program;
  if (reason === "no_deadline") {
    return (
      <>
        <p className="text-[15px] font-medium">这条报名通知确实没有写报名截止吗？</p>
        <fetcher.Form method="post" className="flex flex-wrap gap-2">
          {id}
          <Button name="intent" value="accept">
            确实没写
          </Button>
          {program && (
            <Link
              to={`/programs/${program.id}?edit=apply`}
              target="_blank"
              className={buttonVariants({ variant: "outline" })}
            >
              写了，去补充
            </Link>
          )}
          <Button variant="ghost" name="intent" value="reject">
            已补充，关闭
          </Button>
        </fetcher.Form>
      </>
    );
  }
  if (reason === "unparsed_date") {
    const unresolved = extracted.program.unresolved_dates ?? [];
    return (
      <>
        {unresolved.map((date, index) => (
          <div key={index} className="space-y-2">
            <div>
              <p className="text-[13px] text-muted-foreground">
                {date.field === "dates" ? "其他时间" : fieldLabel(date.field.replace(".", ":"))}
              </p>
              <p className="mt-0.5 text-[15px] font-medium">{date.text}</p>
            </div>
            <Evidence evidence={date.evidence} snapshotId={item.notice.snapshot_id} />
          </div>
        ))}
        <p className="text-[15px] font-medium">需要把时间补到项目里吗？</p>
        <fetcher.Form method="post" className="flex flex-wrap gap-2">
          {id}
          <Button name="intent" value="reject">
            不需要补充
          </Button>
          {program && (
            <Link
              to={`/programs/${program.id}?edit=${unresolved.at(0)?.field.split(".")[0] ?? "dates"}`}
              target="_blank"
              className={buttonVariants({ variant: "outline" })}
            >
              需要，去补充
            </Link>
          )}
          <Button variant="ghost" name="intent" value="accept">
            已补充，关闭
          </Button>
        </fetcher.Form>
      </>
    );
  }
  if (reason === "possible_duplicate") {
    return <Duplicate item={item} extracted={extracted} fetcher={fetcher} thisYear={thisYear} />;
  }
  return <Placing item={item} extracted={extracted} fetcher={fetcher} thisYear={thisYear} />;
}

function Duplicate({
  item,
  extracted,
  fetcher,
  thisYear,
}: {
  item: Item;
  extracted: Extracted;
  fetcher: Fetcher;
  thisYear: number;
}) {
  const { program } = extracted;
  const similar = extracted.programs.filter(
    (p) =>
      p.id !== item.program?.id &&
      p.college_id === program.college_id &&
      p.cohort === program.cohort &&
      p.kind === program.kind,
  );
  const [chosen, setChosen] = useState(similar.length === 1 ? similar[0].id : null);
  return (
    <>
      <Summary title="新通知里的项目" extracted={extracted} thisYear={thisYear} />
      {similar.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-[15px] font-medium">它和哪个已有项目是同一次报名？</legend>
          {similar.map((p) => (
            <Choice
              key={p.id}
              name={`same-${item.id}`}
              checked={chosen === p.id}
              onChange={() => setChosen(p.id)}
              label={
                <>
                  <span className="font-medium">{p.name}</span>
                  <a
                    href={`/programs/${p.id}`}
                    target="_blank"
                    rel="noopener"
                    className="link ml-2 text-[13px]"
                  >
                    查看
                  </a>
                  <span className="block text-[13px] text-muted-foreground">
                    报名时间：{formatApply(p.apply, thisYear)}
                  </span>
                </>
              }
            />
          ))}
        </fieldset>
      )}
      <fetcher.Form method="post" className="flex flex-wrap gap-2">
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="intent" value="accept" />
        {similar.length > 0 && (
          <Button name="program_id" value={chosen ?? ""} disabled={chosen === null}>
            是同一个，合并到所选
          </Button>
        )}
        <Button variant="outline">不是，保留为新项目</Button>
      </fetcher.Form>
    </>
  );
}

// A notice whose program, college or cohort doesn't fit the school: a person places it in one of
// the school's programs, or a new one.
function Placing({
  item,
  extracted,
  fetcher,
  thisYear,
}: {
  item: Item;
  extracted: Extracted;
  fetcher: Fetcher;
  thisYear: number;
}) {
  const { program, colleges, programs } = extracted;
  const [mode, setMode] = useState<"existing" | "new">(programs.length > 0 ? "existing" : "new");
  const collegeName = (id: number) => colleges.find((c) => c.id === id)?.name ?? "";
  return (
    <>
      <Summary title="通知里的项目" extracted={extracted} thisYear={thisYear} />
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="id" value={item.id} />
        <fieldset className="space-y-2">
          <legend className="mb-2 text-[15px] font-medium">这条通知应归入哪个项目？</legend>
          {programs.length > 0 && (
            <Choice
              name={`place-${item.id}`}
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
              label={<span className="font-medium">归入已有项目</span>}
            >
              <Select
                name="program_id"
                aria-label="已有项目"
                options={programs.map((p) => ({
                  value: String(p.id),
                  label: `${collegeName(p.college_id)}　${p.cohort} 届　${PROGRAM_KINDS[p.kind].label}　${p.name}`,
                }))}
              />
            </Choice>
          )}
          <Choice
            name={`place-${item.id}`}
            checked={mode === "new"}
            onChange={() => setMode("new")}
            label={<span className="font-medium">新建项目</span>}
          >
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem]">
              <Select
                name="college_id"
                aria-label="学院"
                defaultValue={String(
                  colleges.find((c) => c.id === program.college_id)?.id ?? colleges[0].id,
                )}
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
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button name="intent" value="accept">
            确定
          </Button>
          <Button variant="outline" name="intent" value="reject">
            不收这条通知
          </Button>
        </div>
      </fetcher.Form>
    </>
  );
}

// What extraction made of the notice's program.
function Summary({
  title,
  extracted,
  thisYear,
}: {
  title: string;
  extracted: Extracted;
  thisYear: number;
}) {
  const { program, colleges } = extracted;
  const college = colleges.find((c) => c.id === program.college_id);
  return (
    <div>
      <p className="text-[13px] text-muted-foreground">{title}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <KindTag kind={program.kind} />
        <span className="text-[15px] font-medium">{program.name}</span>
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {program.cohort} 届　{college?.name ?? "学院不在该校的学院清单中"}　报名时间：
        {formatApply(program.fields.apply?.value ?? null, thisYear)}
      </p>
    </div>
  );
}

// One of a few answers to pick, with what the answer needs filled in under it once picked.
function Choice({
  name,
  checked,
  onChange,
  label,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        checked ? "border-primary/45 bg-primary-soft/60" : "hover:bg-accent/60",
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onChange}
          className="mt-0.5 size-4 shrink-0 appearance-none rounded-full border border-input bg-card transition-[border] outline-none checked:border-[5px] checked:border-primary focus-visible:ring-3 focus-visible:ring-ring/25"
        />
        <span className="min-w-0 flex-1">{label}</span>
      </label>
      {checked && children && <div className="px-3.5 pb-3.5 sm:pl-10.5">{children}</div>}
    </div>
  );
}

function EditList({ edits, thisYear }: { edits: Edits; thisYear: number }) {
  if (edits.items.length === 0) return <Empty>暂无修改记录</Empty>;
  return (
    <Panel flush>
      <ol className="divide-y">
        {edits.items.map((edit) => (
          <li
            key={edit.id}
            className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
          >
            <p className="min-w-0">
              <span className="font-medium">{edit.user.display_name}</span>
              <span className="text-muted-foreground">
                {edit.reverts_id === null ? " 修改了 " : ` 撤销了 #${edit.reverts_id}，涉及 `}
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
      <div className="px-4 pb-4 empty:hidden sm:px-5">
        <Pagination total={edits.total} page={edits.page} perPage={edits.per_page} />
      </div>
    </Panel>
  );
}
