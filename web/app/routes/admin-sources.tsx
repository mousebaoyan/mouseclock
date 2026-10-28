import { data, Form, Link, redirect, useNavigation } from "react-router";
import { SourceDetail as SourceSchema } from "../../server/modules/sources/schemas.ts";
import { apiContext } from "../api.server.ts";
import {
  formText,
  readApi,
  writeApi,
  type SourcesPage,
  type CollegesPage,
  type CollegeDetail,
  type SourceDetail,
} from "../admin.server.ts";
import {
  AdminPage,
  CrawlTime,
  Field,
  FormMessage,
  inputClass,
  linkClass,
  panelClass,
  Pagination,
} from "~/components/admin";
import { Button, buttonVariants } from "~/components/ui/button";
import type { Route } from "./+types/admin-sources.ts";

export async function loader({ request, context }: Route.LoaderArgs): Promise<{
  sources: SourcesPage;
  colleges: CollegesPage;
  source: SourceDetail | null;
  college: CollegeDetail | null;
  q: string;
  collegeQ: string;
  availability: string;
  saved: boolean;
}> {
  const api = context.get(apiContext).client.admin;
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const collegeQ = params.get("college_q") ?? "";
  const collegeId = params.get("college_id") ?? undefined;
  const editId = params.get("edit");
  const availability = params.get("availability");
  const sourceQuery = new URLSearchParams(params);
  if (!availability) sourceQuery.delete("availability");
  const [sources, colleges, source] = await Promise.all([
    api.sources
      .$get({
        query: Object.fromEntries(sourceQuery),
      })
      .then((res) => readApi<SourcesPage>(res)),
    api.colleges
      .$get({ query: { q: collegeQ, page: params.get("college_page") ?? "1" } })
      .then((res) => readApi<CollegesPage>(res)),
    editId
      ? api.sources[":id"].$get({ param: { id: editId } }).then((res) => readApi<SourceDetail>(res))
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
  const values = {
    ...draft,
    college_id: Number(draft.college_id),
    config,
    unavailable_reason: draft.unavailable_reason.trim() || null,
  };
  const endpoint = api.client.admin.sources;
  const result = await writeApi(
    api,
    id ? endpoint[":id"].$url({ param: { id } }) : endpoint.$url(),
    id ? "PATCH" : "POST",
    values,
    SourceSchema,
  );
  if (result.error !== undefined)
    return data({ error: result.error, draft }, { status: result.status });
  return redirect(
    `/admin/sources?college_id=${result.value.college_id}&edit=${result.value.id}&saved=1`,
  );
}

export default function Sources({ loaderData, actionData }: Route.ComponentProps) {
  const { sources, colleges, source, college, q, collegeQ, availability, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  const draft = actionData?.draft;
  const fields = draft ?? source;
  const formKey = `source-${source?.id ?? "new"}`;
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
                      <div>
                        <CrawlTime value={s.last_run.finished_at} />
                        <span
                          className={`mt-1 block ${s.last_run.failure ? "text-destructive" : s.last_run.notice_failure_count > 0 ? "text-warning" : "text-success"}`}
                        >
                          {s.last_run.failure
                            ? `列表失败：${s.last_run.detail || s.last_run.failure}`
                            : s.last_run.notice_failure_count > 0
                              ? `列表成功，${s.last_run.notice_failure_count} 条通知未抓成`
                              : "成功"}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          列表 {s.last_run.listed} · 新增 {s.last_run.new_count} · 有用{" "}
                          {s.last_run.useful_count}
                        </span>
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
        <Pagination page={sources.page} nextPage={sources.next_page} />
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
          <Pagination page={colleges.page} nextPage={colleges.next_page} name="college_page" />
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
                    defaultValue={
                      draft?.config ??
                      (source?.config ? JSON.stringify(source.config, null, 2) : "")
                    }
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
                <div className="flex gap-2">
                  <Button disabled={busy}>{busy ? "保存中…" : "保存来源"}</Button>
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
            </>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">先在左侧选择一个学院。</p>
          )}
        </section>
      </div>
    </AdminPage>
  );
}
