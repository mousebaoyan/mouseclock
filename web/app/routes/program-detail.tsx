import type { InferResponseType } from "hono/client";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/cn";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { CrawlTime, linkClass, panelClass } from "../components/admin.tsx";
import { KindTag, RoleTag, StatusTag, Tag, TierTags } from "../components/tags.tsx";
import { beijingYear, countdown, formatApply, formatWindow, statusOf, useNow } from "../time.ts";
import type { Route } from "./+types/program-detail.ts";

type ProgramApi = ReturnType<typeof createApi>["programs"][":id"];
type Program = InferResponseType<ProgramApi["$get"], 200>;
type Version = InferResponseType<ProgramApi["versions"]["$get"], 200>["versions"][number];
type Fields = Program["fields"];
// What every field and part has besides its value.
type Support = Pick<NonNullable<Fields["quota"]>, "evidence" | "version">;
type FieldRow = { label: string; value: ReactNode; parts: [string | null, Support | undefined][] };

export function meta({ loaderData }: Route.MetaArgs) {
  const { program } = loaderData;
  return [{ title: `${program.school.name} · ${program.name} · 鼠钟` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const api = context.get(apiContext).programs[":id"];
  const param = { id: params.id };
  const [program, { versions }] = await Promise.all([
    api.$get({ param }).then((res) => readApi<Program>(res)),
    api.versions.$get({ param }).then((res) => readApi<{ versions: Version[] }>(res)),
  ]);
  return {
    program,
    versions,
    thisYear: beijingYear(new Date()),
    now: Math.floor(Date.now() / 1000),
  };
}

export default function ProgramDetail({ loaderData }: Route.ComponentProps) {
  const { program, versions, thisYear } = loaderData;
  const { school, college, notice, verified } = program;
  const now = useNow(loaderData.now);
  const left = countdown(program, now);
  const rows = rowsOf(program.fields, thisYear);
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-3 py-6 sm:px-5">
      <p className="text-sm">
        <Link to="/" className={linkClass}>
          总表
        </Link>
        <span className="text-muted-foreground"> / {program.name}</span>
      </p>
      <header>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-brand-strong">{school.name}</span>
          <TierTags tiers={school.tiers} />
          <Link to={`/colleges/${college.id}`} className={linkClass}>
            {college.name}
          </Link>
          <span className="text-muted-foreground">{college.region}</span>
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-pretty">{program.name}</h1>
        <p className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
          <KindTag kind={program.kind} />
          <StatusTag status={statusOf(program, now)} />
          {verified && <Tag color="green">已核对</Tag>}
          <span className="text-muted-foreground">
            {program.cohort} 届{left && ` · ${left}`}
          </span>
        </p>
        {verified && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {verified.by} 核对于 <CrawlTime value={verified.at} />
          </p>
        )}
      </header>

      <section className="rounded-xl border border-brand/40 bg-brand/5 p-4 sm:p-5">
        <p className="text-xs font-medium text-brand-strong">原文</p>
        <a
          href={notice.url}
          target="_blank"
          rel="nofollow noopener"
          className={cn(linkClass, "mt-1 block text-base font-medium text-pretty")}
        >
          {notice.title}
        </a>
        <p className="mt-1 text-xs break-all text-muted-foreground">
          {notice.published_on && `${notice.published_on} 发布 · `}
          {notice.url}
        </p>
        {notice.removed && (
          <p className="mt-2 text-sm text-warning">原文已删除，下面各版的快照还能看。</p>
        )}
      </section>

      <section className={panelClass}>
        <h2 className="text-lg font-semibold">项目信息</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          由通知原文整理，每一项都能展开看原文里的句子和它来自哪一版。
        </p>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">通知里还没有整理出信息。</p>
        ) : (
          <dl className="mt-2 divide-y divide-border">
            {rows.map((row) => (
              <div key={row.label} className="py-3.5 sm:grid sm:grid-cols-[7rem_1fr] sm:gap-4">
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className="mt-1 min-w-0 text-sm sm:mt-0">
                  {row.value}
                  <Evidence parts={row.parts} versions={versions} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className={panelClass}>
        <h2 className="text-lg font-semibold">版本</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          每条相关的通知是一版。快照是抓取时存下的原文，原文删了也能看。
        </p>
        <ol className="mt-2 divide-y divide-border">
          {versions.map((version) => (
            <li key={version.number} className="py-3.5 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">第 {version.number} 版</span>
                <RoleTag role={version.role} />
                {version.notice.removed && <Tag color="gray">原文已删除</Tag>}
              </p>
              <a
                href={version.notice.url}
                target="_blank"
                rel="nofollow noopener"
                className={cn(linkClass, "mt-1.5 block text-pretty")}
              >
                {version.notice.title}
              </a>
              {version.changes.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  更新了：{version.changes.map(changeLabel).join("、")}
                </p>
              )}
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {version.notice.published_on && <span>{version.notice.published_on} 发布</span>}
                <span>
                  <CrawlTime value={version.snapshot.fetched_at} /> 抓取
                </span>
                <Link to={`/snapshots/${version.snapshot.id}`} className={linkClass}>
                  看快照
                  {version.attachments.length > 0 && `和 ${version.attachments.length} 个附件`}
                </Link>
              </p>
            </li>
          ))}
        </ol>
      </section>
    </main>
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
    <details className="mt-1.5">
      <summary className="w-fit cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
        原文依据
      </summary>
      <ul className="mt-2 space-y-3">
        {groups.map(({ key, labels, part }) => {
          const from = part.version;
          const files = from && versions.find((item) => item.number === from.number)?.attachments;
          return (
            <li key={key} className="space-y-1.5">
              {groups.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground">{labels.join("、")}</p>
              )}
              {part.evidence.map(({ quote, attachment }) => (
                <blockquote key={quote} className="border-l-2 border-brand/50 pl-3 text-pretty">
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
                    来自第 {from.number} 版：
                    <Link to={`/snapshots/${from.snapshot_id}`} className={linkClass}>
                      {from.notice.title}
                    </Link>
                  </>
                ) : (
                  "人工修改"
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

const MODES = { online: "线上", offline: "线下", hybrid: "线上和线下" };
const DEGREES = { master: "硕士", direct_phd: "直博" };

// The keys a version changed (program_fields), as people say them.
const CHANGES: Partial<Record<string, string>> = {
  "apply:start": "报名开始",
  "apply:end": "报名截止",
  "apply:rolling": "额满即止",
  apply_url: "报名入口",
  "event:start": "活动开始",
  "event:end": "活动结束",
  "event:mode": "活动形式",
  "event:place": "活动地点",
  degrees: "招收类型",
  majors: "招收专业",
  requirements: "报名要求",
  materials: "要交的材料",
  assessment: "考核方式",
  quota: "名额",
  benefits: "待遇",
  contacts: "联系方式",
};

function changeLabel(key: string) {
  return key.startsWith("dates:") ? key.slice("dates:".length) : (CHANGES[key] ?? key);
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

// The fields in the order of design §8.2; the other dates each get a row of their own.
function rowsOf(fields: Fields, thisYear: number) {
  const rows: FieldRow[] = [];
  const { apply, apply_url, event, dates = [], degrees, quota } = fields;
  const list = (label: string, field: Fields["majors"]) => {
    if (field) rows.push({ label, value: <List items={field.value} />, parts: [[null, field]] });
  };
  if (apply) {
    rows.push({
      label: "报名时间",
      value: formatApply(
        { start: apply.start?.value, end: apply.end?.value, rolling: apply.rolling?.value },
        thisYear,
      ),
      parts: [
        ["开始", apply.start],
        ["截止", apply.end],
        ["额满即止", apply.rolling],
      ],
    });
  }
  if (apply_url) {
    rows.push({
      label: "报名入口",
      value: (
        <a
          href={apply_url.value}
          target="_blank"
          rel="nofollow noopener"
          className={cn(linkClass, "break-all")}
        >
          {apply_url.value.replace(/^mailto:/, "")}
        </a>
      ),
      parts: [[null, apply_url]],
    });
  }
  if (event) {
    rows.push({
      label: "活动时间",
      value: [
        formatWindow({ start: event.start?.value, end: event.end?.value }, thisYear),
        event.mode && MODES[event.mode.value],
        event.place?.value,
      ]
        .filter(Boolean)
        .join(" · "),
      parts: [
        ["开始", event.start],
        ["结束", event.end],
        ["形式", event.mode],
        ["地点", event.place],
      ],
    });
  }
  for (const date of dates) {
    rows.push({
      label: date.label,
      value: formatWindow(date.value, thisYear),
      parts: [[null, date]],
    });
  }
  if (degrees) {
    rows.push({
      label: "招收类型",
      value: degrees.value.map((degree) => DEGREES[degree]).join("、"),
      parts: [[null, degrees]],
    });
  }
  list("招收专业", fields.majors);
  list("报名要求", fields.requirements);
  list("要交的材料", fields.materials);
  list("考核方式", fields.assessment);
  if (quota) rows.push({ label: "名额", value: quota.value, parts: [[null, quota]] });
  list("待遇", fields.benefits);
  list("联系方式", fields.contacts);
  return rows;
}
