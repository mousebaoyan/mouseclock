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
import {
  AdminPage,
  CrawlTime,
  Field,
  FormMessage,
  inputClass,
  linkClass,
  panelClass,
} from "~/components/admin";
import { failureText, RunResult } from "~/components/crawl";
import { Pagination } from "~/components/pagination";
import { Button, buttonVariants } from "~/components/ui/button";
import { beijingDate } from "~/time";
import type { Route } from "./+types/admin-sources.ts";

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
      return data({ error: "抓取配置不是合法 JSON，请检查引号和逗号", draft }, { status: 400 });
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
  return (
    <AdminPage
      title="来源管理"
      description="一个来源是官网的一个通知列表页，保存后将按计划自动抓取。"
    >
      <FormMessage error={actionData?.error} saved={saved} />
      <section className={panelClass}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            已接入来源
            {college && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {college.school_name} · {college.name}
              </span>
            )}
          </h2>
          {college && (
            <Link to="/admin/sources" className={linkClass}>
              查看全部来源
            </Link>
          )}
        </div>
        <Form method="get" aria-label="搜索" className="my-4 flex flex-wrap gap-2">
          {college && <input type="hidden" name="college_id" value={college.id} />}
          <input
            name="q"
            aria-label="搜索来源"
            defaultValue={q}
            placeholder="学校、学院、栏目或网址"
            className={`${inputClass} min-w-40 flex-1 sm:w-auto`}
          />
          <select
            name="availability"
            aria-label="来源状态"
            defaultValue={availability}
            className={`${inputClass} sm:w-40`}
          >
            <option value="">全部状态</option>
            <option value="available">可抓取</option>
            <option value="unavailable">暂时抓不了</option>
          </select>
          <Button variant="outline">筛选</Button>
        </Form>
        <div className="overflow-x-auto">
          <table className="w-full min-w-170 text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th className="py-3 pr-4 font-medium">学院 / 来源</th>
                <th className="py-3 pr-4 font-medium">抓取方式 / 状态</th>
                <th className="py-3 pr-4 font-medium">上次抓取（北京时间）</th>
                <th className="py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sources.items.map((s) => (
                <tr key={s.id}>
                  <td className="max-w-75 py-4 pr-4 align-top">
                    <p className="font-medium">
                      {s.school_name} · {s.college_name}
                    </p>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`${linkClass} mt-1 block break-all`}
                    >
                      {s.section || "未填写栏目名"}
                    </a>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={s.url}>
                      {s.url}
                    </p>
                  </td>
                  <td className="max-w-60 py-4 pr-4 align-top">
                    <p>{s.browser ? "浏览器" : "普通请求"}</p>
                    <p className={`mt-1 ${s.unavailable_reason ? "text-warning" : "text-success"}`}>
                      {s.unavailable_reason ? "暂时抓不了" : "可抓取"}
                    </p>
                    {s.unavailable_reason && (
                      <p className="mt-1 text-xs break-words text-muted-foreground">
                        {s.unavailable_reason}
                      </p>
                    )}
                  </td>
                  <td className="py-4 pr-4 align-top">
                    {s.last_run ? (
                      <div className="space-y-1">
                        <Link
                          to={`/crawl?date=${beijingDate(s.last_run.started_at)}&source_id=${s.id}`}
                          className={`${linkClass} block`}
                        >
                          <CrawlTime value={s.last_run.finished_at} />
                        </Link>
                        <p>
                          <RunResult run={s.last_run} />
                        </p>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">还没抓取</span>
                    )}
                  </td>
                  <td className="py-4 align-top">
                    <Link
                      to={`?edit=${s.id}&college_id=${s.college_id}#source-form`}
                      className={linkClass}
                    >
                      编辑
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sources.items.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            没有符合条件的来源，请在下方接入。
          </p>
        )}
        <Pagination total={sources.total} page={sources.page} perPage={sources.per_page} />
      </section>
      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]" id="source-form">
        <section className={panelClass}>
          <h2 className="text-lg font-semibold">
            {source ? "选择所属学院" : "接入来源：选择学院"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            还没有院校？先到{" "}
            <Link to="/admin/colleges" className={linkClass}>
              院校清单
            </Link>{" "}
            添加。
          </p>
          <Form method="get" className="my-4 flex gap-2" aria-label="搜索">
            {source && <input type="hidden" name="edit" value={source.id} />}
            {college && <input type="hidden" name="college_id" value={college.id} />}
            <input
              name="college_q"
              aria-label="查找所属学院"
              defaultValue={collegeQ}
              placeholder="学校名、简称或学院名"
              className={inputClass}
            />
            <Button variant="outline">查找</Button>
          </Form>
          <ul className="max-h-104 divide-y divide-border overflow-y-auto">
            {colleges.items.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium">{c.school_name}</p>
                  <p className="mt-1 text-muted-foreground">
                    {c.name} · {c.region}
                  </p>
                </div>
                <Link
                  to={`?college_id=${c.id}${source ? `&edit=${source.id}` : ""}#source-form`}
                  className={buttonVariants({
                    variant: college?.id === c.id ? "secondary" : "outline",
                    size: "sm",
                  })}
                >
                  {college?.id === c.id ? "已选择" : "选择"}
                </Link>
              </li>
            ))}
          </ul>
          {colleges.items.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">没有找到学院。</p>
          )}
          <Pagination
            total={colleges.total}
            page={colleges.page}
            perPage={colleges.per_page}
            prefix="college_"
          />
        </section>
        <section className={panelClass}>
          <h2 className="text-lg font-semibold">{source ? "编辑来源" : "接入新来源"}</h2>
          {college ? (
            <>
              <p className="mt-2 mb-4 text-sm text-muted-foreground">
                {college.school_name} · {college.name}
              </p>
              <Form method="post" className="space-y-4" key={formKey}>
                {source && <input type="hidden" name="id" value={source.id} />}
                <input type="hidden" name="college_id" value={college.id} />
                <Field label="通知列表页网址">
                  <input
                    type="url"
                    name="url"
                    required
                    maxLength={2000}
                    defaultValue={fields?.url ?? ""}
                    placeholder="https://学院官网/通知公告"
                    className={inputClass}
                  />
                </Field>
                <Field label="栏目名" hint="填写官网上的栏目名，帮助初筛判断通知。">
                  <input
                    name="section"
                    maxLength={200}
                    defaultValue={fields?.section ?? ""}
                    placeholder="如通知公告、研究生招生"
                    className={inputClass}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input name="browser" type="checkbox" defaultChecked={fields?.browser ?? false} />
                  需要浏览器执行 JavaScript
                </label>
                <Field
                  label="抓取配置（JSON）"
                  hint="留空使用通用抓取。配置须为 JSON 对象，具体字段由抓取节点定义。"
                >
                  <textarea
                    name="config"
                    rows={7}
                    spellCheck={false}
                    defaultValue={draft?.config ?? (config ? JSON.stringify(config, null, 2) : "")}
                    placeholder="{}"
                    className={`${inputClass} font-mono`}
                  />
                </Field>
                <Field
                  label="暂时抓不了的原因"
                  hint="填写后暂停后续抓取；清空并保存即可恢复。正在进行的抓取会继续完成。"
                >
                  <textarea
                    name="unavailable_reason"
                    rows={2}
                    maxLength={1000}
                    defaultValue={fields?.unavailable_reason ?? ""}
                    placeholder="如需要登录、有验证码；可抓取时留空"
                    className={inputClass}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy}>{busy ? "保存中…" : "保存来源"}</Button>
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
            <p className="mt-4 text-sm text-muted-foreground">先在左侧选择一个学院。</p>
          )}
        </section>
      </div>
    </AdminPage>
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
    <p className="text-muted-foreground">
      等抓取节点来领……它每分钟来一次，结果出来这里会自己刷新。
    </p>
  );
}

function ProbeResult({ probe, adoptTo }: { probe: SourceProbe; adoptTo: string }) {
  return (
    <section id="probe" className="mt-5 space-y-3 border-t border-border pt-4 text-sm">
      <h3 className="font-semibold">
        试抓 <span className="font-normal break-all text-muted-foreground">{probe.url}</span>
      </h3>
      {probe.finished_at === null ? (
        <WaitingForCrawler />
      ) : probe.failure ? (
        <p className="text-destructive">没抓成，{failureText(probe.failure, probe.detail)}</p>
      ) : (
        <>
          <p>抓到 {probe.items.length} 条：</p>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {probe.items.map((item) => (
              <li key={item.url} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {item.published_on ?? "没有日期"}
                </span>
                <a href={item.url} target="_blank" rel="nofollow noopener" className={linkClass}>
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
          {probe.suggested_config ? (
            <>
              <p className="text-muted-foreground">生成的配置：</p>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
                {JSON.stringify(probe.suggested_config, null, 2)}
              </pre>
            </>
          ) : (
            <p className="text-muted-foreground">不用配置，通用抓取就行。</p>
          )}
          <Link to={adoptTo} className={buttonVariants({ size: "sm" })}>
            采用，填进上面的表单
          </Link>
        </>
      )}
    </section>
  );
}
