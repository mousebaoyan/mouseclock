import { useEffect } from "react";
import { data, Form, Link, redirect, useNavigation, useRevalidator } from "react-router";
import { ProbeInput, SourceInput } from "../../server/modules/sources/schemas.ts";
import { apiContext, readApi } from "../api.server.ts";
import {
  formText,
  type SourcesPage,
  type CollegesPage,
  type CollegeDetail,
  type SourceDetail,
  type SourceProbe,
} from "../admin.server.ts";
import { failureText, RunResult } from "~/components/crawl";
import { Field, FormMessage } from "~/components/form";
import { Check, Search } from "~/components/icons";
import { Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { Tag } from "~/components/tags";
import { DateTime } from "~/components/time";
import { Button, buttonVariants } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Select } from "~/components/ui/select";
import { List, Row } from "~/components/list";
import { beijingDate } from "~/time";
import type { Route } from "./+types/admin-sources.ts";

export function meta() {
  return [{ title: "来源管理 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs): Promise<{
  sources: SourcesPage;
  colleges: CollegesPage;
  source: SourceDetail | null;
  college: CollegeDetail | null;
  probe: SourceProbe | null;
  adopt: boolean;
  q: string;
  collegeQ: string;
  availability: string;
  saved: boolean;
}> {
  const api = context.get(apiContext).admin;
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const collegeQ = params.get("college_q") ?? "";
  const collegeId = params.get("college_id") ?? undefined;
  const editId = params.get("edit");
  const probeId = params.get("probe");
  const availability = params.get("availability");
  const sourceQuery = new URLSearchParams(params);
  if (!availability) sourceQuery.delete("availability");
  const [sources, colleges, source, probe] = await Promise.all([
    api.sources
      .$get({
        query: Object.fromEntries(sourceQuery),
      })
      .then((res) => readApi<SourcesPage>(res)),
    api.colleges
      .$get({
        query: {
          q: collegeQ,
          page: params.get("college_page") ?? undefined,
          per_page: params.get("college_per_page") ?? undefined,
        },
      })
      .then((res) => readApi<CollegesPage>(res)),
    editId
      ? api.sources[":id"].$get({ param: { id: editId } }).then((res) => readApi<SourceDetail>(res))
      : null,
    probeId
      ? api["source-probes"][":id"]
          .$get({ param: { id: probeId } })
          .then((res) => readApi<SourceProbe>(res))
      : null,
  ]);
  const selectedId = collegeId ?? (source ? String(source.college_id) : null);
  const college = selectedId
    ? await readApi<CollegeDetail>(await api.colleges[":id"].$get({ param: { id: selectedId } }))
    : null;
  return {
    sources,
    colleges,
    source,
    college,
    probe,
    adopt: params.has("adopt"),
    q,
    collegeQ,
    availability: availability ?? "",
    saved: params.get("saved") === "1",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const form = await request.formData();
  const id = formText(form, "id");
  const draft = {
    college_id: formText(form, "college_id"),
    url: formText(form, "url"),
    section: formText(form, "section"),
    browser: form.get("browser") === "on",
    config: formText(form, "config"),
    unavailable_reason: formText(form, "unavailable_reason"),
  };
  let config: unknown = null;
  if (draft.config.trim()) {
    try {
      config = JSON.parse(draft.config);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return data({ error: "抓取配置不是有效的 JSON，请检查引号与逗号", draft }, { status: 400 });
    }
  }
  // Trying the page before saving it (design §7.2): the result shows under the form.
  if (formText(form, "intent") === "probe") {
    const probe = ProbeInput.safeParse({ url: draft.url, browser: draft.browser, config });
    if (!probe.success)
      return data({ error: probe.error.issues[0].message, draft }, { status: 400 });
    const res = await api.admin["source-probes"].$post({ json: probe.data });
    if (res.status !== 201)
      return data({ error: (await res.json()).error.message, draft }, { status: res.status });
    const params = new URLSearchParams({
      college_id: draft.college_id,
      probe: String((await res.json()).id),
    });
    if (id) params.set("edit", id);
    return redirect(`/admin/sources?${params}#probe`);
  }
  const parsed = SourceInput.safeParse({
    ...draft,
    college_id: Number(draft.college_id),
    config,
    unavailable_reason: draft.unavailable_reason.trim() || null,
  });
  if (!parsed.success)
    return data({ error: parsed.error.issues[0].message, draft }, { status: 400 });
  const res = id
    ? await api.admin.sources[":id"].$patch({ param: { id }, json: parsed.data })
    : await api.admin.sources.$post({ json: parsed.data });
  if (res.status !== 200 && res.status !== 201)
    return data({ error: (await res.json()).error.message, draft }, { status: res.status });
  const result = await res.json();
  return redirect(`/admin/sources?college_id=${result.college_id}&edit=${result.id}&saved=1`);
}

export default function Sources({ loaderData, actionData }: Route.ComponentProps) {
  const { sources, colleges, source, college, probe, adopt, q, collegeQ, availability, saved } =
    loaderData;
  const busy = useNavigation().state !== "idle";
  const draft = actionData?.draft;
  // The page tried fills the form, and the config the crawler suggests once it is adopted.
  const tried = draft ? null : probe;
  const fields =
    draft ??
    (tried
      ? {
          url: tried.url,
          browser: tried.browser,
          section: source?.section ?? "",
          unavailable_reason: source?.unavailable_reason ?? null,
        }
      : source);
  const config = tried ? (adopt ? tried.suggested_config : tried.config) : source?.config;
  const formKey = `source-${source?.id ?? "new"}-${tried?.id ?? ""}-${adopt}`;
  const selectCollege = (id: number) =>
    `?college_id=${id}${source ? `&edit=${source.id}` : ""}#source-form`;
  return (
    <Page title="来源管理" hideTitle>
      <FormMessage error={actionData?.error} saved={saved && "已保存"} />
      <Panel
        title={
          college ? (
            <>
              已接入来源
              <span className="ml-2 font-normal text-muted-foreground">
                {college.school_name}
                {college.name}
              </span>
            </>
          ) : (
            "已接入来源"
          )
        }
        actions={
          college && (
            <Link
              to="/admin/sources"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              查看全部来源
            </Link>
          )
        }
        flush
      >
        <Form
          method="get"
          aria-label="筛选来源"
          className="flex flex-wrap gap-2 border-b p-3 sm:px-5"
        >
          {college && <input type="hidden" name="college_id" value={college.id} />}
          <label className="relative min-w-0 flex-[1_1_16rem]">
            <span className="sr-only">搜索来源</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle-foreground" />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="学校、学院、栏目名称或网址"
              className="field pl-9"
            />
          </label>
          <Select
            name="availability"
            aria-label="来源状态"
            defaultValue={availability}
            options={[
              { value: "", label: "全部状态" },
              { value: "available", label: "正常" },
              { value: "unavailable", label: "暂停抓取" },
            ]}
            className="w-32"
          />
          <Button variant="outline">筛选</Button>
        </Form>
        {sources.items.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
            没有符合条件的来源
          </p>
        ) : (
          <List className="rounded-none border-0 shadow-none">
            {sources.items.map((s) => (
              <Row
                key={s.id}
                selected={source?.id === s.id}
                title={
                  <>
                    <span className="font-medium">
                      {s.school_name}
                      <span className="ml-1">{s.college_name}</span>
                    </span>
                    {s.unavailable_reason ? (
                      <span title={s.unavailable_reason}>
                        <Tag color="amber">暂停抓取</Tag>
                      </span>
                    ) : null}
                    {s.browser && <Tag color="gray">浏览器渲染</Tag>}
                  </>
                }
                meta={
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    title={s.url}
                    className="max-w-full truncate hover:text-primary"
                  >
                    {s.section || "未填写栏目名称"}　{s.url}
                  </a>
                }
                side={
                  s.last_run ? (
                    <Link
                      to={`/crawl?date=${beijingDate(s.last_run.started_at)}&source_id=${s.id}`}
                      className="hover:opacity-80"
                    >
                      <RunResult run={s.last_run} className="text-[13px]" />
                    </Link>
                  ) : (
                    <span className="text-[13px] text-subtle-foreground">尚未抓取</span>
                  )
                }
                sideMeta={
                  <span className="flex items-center gap-2">
                    {s.last_run && <DateTime value={s.last_run.finished_at} />}
                    <Link
                      to={`?edit=${s.id}&college_id=${s.college_id}#source-form`}
                      className={buttonVariants({ variant: "outline", size: "xs" })}
                    >
                      编辑
                    </Link>
                  </span>
                }
              />
            ))}
          </List>
        )}
        <div className="px-4 pb-4 empty:hidden sm:px-5">
          <Pagination total={sources.total} page={sources.page} perPage={sources.per_page} />
        </div>
      </Panel>
      <div
        id="source-form"
        className="grid scroll-mt-20 items-start gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]"
      >
        <Panel
          title="选择学院"
          description={
            <>
              找不到学院时，请先到
              <Link to="/admin/colleges" className="link mx-0.5">
                院校管理
              </Link>
              添加
            </>
          }
          flush
        >
          <Form method="get" className="flex gap-2 border-b p-3" aria-label="查找学院">
            {source && <input type="hidden" name="edit" value={source.id} />}
            {college && <input type="hidden" name="college_id" value={college.id} />}
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">查找学院</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle-foreground" />
              <input
                type="search"
                name="college_q"
                defaultValue={collegeQ}
                placeholder="学校名称、简称或学院名称"
                className="field pl-9"
              />
            </label>
            <Button variant="outline">查找</Button>
          </Form>
          {colleges.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">未找到学院</p>
          ) : (
            <ul className="max-h-104 divide-y overflow-y-auto">
              {colleges.items.map((c) => (
                <li key={c.id}>
                  <Link
                    to={selectCollege(c.id)}
                    aria-current={college?.id === c.id ? "true" : undefined}
                    className="flex items-center justify-between gap-3 border-l-2 border-transparent px-4 py-2.5 text-sm hover:bg-muted/50 aria-[current]:border-primary aria-[current]:bg-primary-soft"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{c.school_name}</span>
                      <span className="block text-[13px] text-muted-foreground">
                        {c.name}　{c.region}
                      </span>
                    </span>
                    {college?.id === c.id && <Check className="shrink-0 text-primary" />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="px-3 pb-3 empty:hidden">
            <Pagination
              total={colleges.total}
              page={colleges.page}
              perPage={colleges.per_page}
              prefix="college_"
            />
          </div>
        </Panel>
        <Panel
          title={source ? "编辑来源" : "接入新来源"}
          description={college ? `${college.school_name}${college.name}` : undefined}
        >
          {college ? (
            <>
              <Form method="post" className="space-y-4" key={formKey}>
                {source && <input type="hidden" name="id" value={source.id} />}
                <input type="hidden" name="college_id" value={college.id} />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
                  <Field label="通知列表页网址">
                    <input
                      type="url"
                      name="url"
                      required
                      maxLength={2000}
                      defaultValue={fields?.url ?? ""}
                      placeholder="https://"
                      className="field"
                    />
                  </Field>
                  <Field label="栏目名称">
                    <input
                      name="section"
                      maxLength={200}
                      defaultValue={fields?.section ?? ""}
                      placeholder="例如：通知公告"
                      className="field"
                    />
                  </Field>
                </div>
                <Checkbox name="browser" value="on" defaultChecked={fields?.browser ?? false}>
                  需要浏览器执行 JavaScript
                </Checkbox>
                <Field
                  label="抓取配置（JSON）"
                  hint="留空则使用通用抓取；配置须为 JSON 对象，字段由抓取节点定义"
                >
                  <textarea
                    name="config"
                    rows={7}
                    spellCheck={false}
                    defaultValue={draft?.config ?? (config ? JSON.stringify(config, null, 2) : "")}
                    placeholder="{}"
                    className="field h-auto py-2 font-mono text-xs leading-relaxed"
                  />
                </Field>
                <Field
                  label="暂停抓取的原因"
                  hint="填写后暂停后续抓取，清空并保存即可恢复；正在进行的抓取会继续完成"
                >
                  <textarea
                    name="unavailable_reason"
                    rows={2}
                    maxLength={1000}
                    defaultValue={fields?.unavailable_reason ?? ""}
                    placeholder="例如：需要登录、有验证码；可正常抓取时留空"
                    className="field h-auto py-2"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy}>{busy ? "正在保存…" : "保存来源"}</Button>
                  <Button variant="outline" name="intent" value="probe" disabled={busy}>
                    试抓
                  </Button>
                  {source && (
                    <Link
                      to={`?college_id=${college.id}#source-form`}
                      className={buttonVariants({ variant: "ghost" })}
                    >
                      取消编辑
                    </Link>
                  )}
                </div>
              </Form>
              {probe && (
                <ProbeResult
                  probe={probe}
                  adoptTo={`?college_id=${college.id}${source ? `&edit=${source.id}` : ""}&probe=${probe.id}&adopt=1#source-form`}
                />
              )}
            </>
          ) : (
            <p className="py-6 text-center text-[13px] text-muted-foreground">请先在左侧选择学院</p>
          )}
        </Panel>
      </div>
    </Page>
  );
}

// The crawler takes a probe the next time it asks for work, within a minute or so; until it
// reports, the page looks again every few seconds.
const PROBE_POLL_MS = 5000;

function WaitingForCrawler() {
  const { revalidate } = useRevalidator();
  useEffect(() => {
    const timer = setInterval(() => void revalidate(), PROBE_POLL_MS);
    return () => clearInterval(timer);
  }, [revalidate]);
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
      等待抓取节点领取任务，结果返回后本页自动刷新
    </p>
  );
}

function ProbeResult({ probe, adoptTo }: { probe: SourceProbe; adoptTo: string }) {
  return (
    <section id="probe" className="mt-5 scroll-mt-20 space-y-3 rounded-lg border bg-muted/40 p-4">
      <h3 className="text-sm font-semibold">
        试抓结果
        <span className="ml-2 font-normal break-all text-muted-foreground">{probe.url}</span>
      </h3>
      {probe.finished_at === null ? (
        <WaitingForCrawler />
      ) : probe.failure ? (
        <FormMessage error={`试抓失败：${failureText(probe.failure, probe.detail)}`} />
      ) : (
        <>
          <p className="text-[13px]">共抓取到 {probe.items.length} 条通知：</p>
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border bg-card text-[13px]">
            {probe.items.map((item) => (
              <li key={item.url} className="flex gap-3 px-3 py-2">
                <span className="w-20 shrink-0 text-muted-foreground tabular-nums">
                  {item.published_on ?? "无日期"}
                </span>
                <a href={item.url} target="_blank" rel="nofollow noopener" className="link">
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
          {probe.suggested_config ? (
            <>
              <p className="text-[13px] text-muted-foreground">建议配置：</p>
              <pre className="overflow-x-auto rounded-md border bg-card p-3 text-xs">
                {JSON.stringify(probe.suggested_config, null, 2)}
              </pre>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">无需配置，使用通用抓取即可</p>
          )}
          <Link to={adoptTo} className={buttonVariants({ size: "sm" })}>
            采用此配置
          </Link>
        </>
      )}
    </section>
  );
}
