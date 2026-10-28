import { data, Form, Link, redirect, useNavigation } from "react-router";
import { CollegeInput, SchoolInput } from "../../server/modules/sources/schemas.ts";
import { apiContext } from "../api.server.ts";
import {
  formText,
  readApi,
  requireAdmin,
  type SchoolsPage,
  type SchoolDetail,
  type CollegesPage,
  type CollegeDetail,
} from "../admin.server.ts";
import {
  AdminPage,
  Field,
  FormMessage,
  inputClass,
  KINDS,
  linkClass,
  panelClass,
  Pagination,
  TIERS,
} from "~/components/admin";
import { Button, buttonVariants } from "~/components/ui/button";
import type { Route } from "./+types/admin-colleges.ts";

export async function loader({ request, context }: Route.LoaderArgs): Promise<{
  schools: SchoolsPage;
  school: SchoolDetail | null;
  colleges: CollegesPage | null;
  college: CollegeDetail | null;
  q: string;
  editSchool: boolean;
  saved: boolean;
}> {
  const api = context.get(apiContext).admin;
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const schoolId = params.get("school_id");
  const editCollege = params.get("edit_college");
  const schools = await readApi<SchoolsPage>(
    await api.schools.$get({ query: { q, page: params.get("school_page") ?? "1" } }),
  );
  const [school, colleges, college] = await Promise.all([
    schoolId
      ? api.schools[":id"]
          .$get({ param: { id: schoolId } })
          .then((res) => readApi<SchoolDetail>(res))
      : null,
    schoolId
      ? api.colleges
          .$get({ query: { school_id: schoolId, page: params.get("page") ?? "1" } })
          .then((res) => readApi<CollegesPage>(res))
      : null,
    editCollege
      ? api.colleges[":id"]
          .$get({ param: { id: editCollege } })
          .then((res) => readApi<CollegeDetail>(res))
      : null,
  ]);
  return {
    schools,
    school,
    colleges,
    college,
    q,
    editSchool: params.get("edit_school") === "1",
    saved: params.get("saved") === "1",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  await requireAdmin(request, api);
  const form = await request.formData();
  const intent = formText(form, "intent");
  const id = formText(form, "id");
  const draft = {
    intent,
    name: formText(form, "name"),
    short_name: formText(form, "short_name"),
    tiers: form.getAll("tiers").filter((value) => typeof value === "string"),
    school_id: formText(form, "school_id"),
    kind: formText(form, "kind"),
    region: formText(form, "region"),
    directions: formText(form, "directions"),
  };
  if (intent === "school") {
    const school = SchoolInput.safeParse({
      name: draft.name,
      short_name: draft.short_name,
      tiers: draft.tiers,
    });
    if (!school.success)
      return data({ error: school.error.issues[0].message, draft }, { status: 400 });
    const res = id
      ? await api.admin.schools[":id"].$patch({ param: { id }, json: school.data })
      : await api.admin.schools.$post({ json: school.data });
    if (res.status !== 200 && res.status !== 201)
      return data({ error: (await res.json()).error.message, draft }, { status: res.status });
    const result = await res.json();
    return redirect(`/admin/colleges?school_id=${result.id}&edit_school=1&saved=1`);
  }
  if (intent === "college") {
    const college = CollegeInput.safeParse({
      school_id: Number(draft.school_id),
      name: draft.name,
      kind: draft.kind,
      region: draft.region,
      directions: draft.directions
        .split(/[,，、\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    if (!college.success)
      return data({ error: college.error.issues[0].message, draft }, { status: 400 });
    const res = id
      ? await api.admin.colleges[":id"].$patch({ param: { id }, json: college.data })
      : await api.admin.colleges.$post({ json: college.data });
    if (res.status !== 200 && res.status !== 201)
      return data({ error: (await res.json()).error.message, draft }, { status: res.status });
    const result = await res.json();
    return redirect(
      `/admin/colleges?school_id=${college.data.school_id}&edit_college=${result.id}&saved=1`,
    );
  }
  throw data("未知操作", { status: 400 });
}

export default function Colleges({ loaderData, actionData }: Route.ComponentProps) {
  const { schools, school, colleges, college, q, editSchool, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  const schoolDraft = actionData?.draft.intent === "school" ? actionData.draft : null;
  const collegeDraft = actionData?.draft.intent === "college" ? actionData.draft : null;
  const schoolValues = schoolDraft ?? (editSchool ? school : null);
  const collegeValues = collegeDraft ?? college;
  const schoolOptions =
    school && !schools.items.some((s) => s.id === school.id)
      ? [school, ...schools.items]
      : schools.items;
  return (
    <AdminPage
      title="院校清单"
      description="先添加学校，再维护它的学院、研究所或研究生院。尚未接入来源的学院也可以保留在清单中。"
    >
      <FormMessage error={actionData?.error} saved={saved} />
      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <section className={panelClass}>
          <h2 className="text-lg font-semibold">学校</h2>
          <Form method="get" className="my-4 flex gap-2" aria-label="搜索">
            {college && <input type="hidden" name="edit_college" value={college.id} />}
            {school && <input type="hidden" name="school_id" value={school.id} />}
            <input
              name="q"
              aria-label="搜索学校"
              defaultValue={q}
              placeholder="学校名称或简称"
              className={inputClass}
            />
            <Button variant="outline">搜索</Button>
          </Form>
          <ul className="divide-y divide-border">
            {schools.items.map((s) => (
              <li
                key={s.id}
                className={`flex flex-wrap items-center justify-between gap-2 py-3 ${school?.id === s.id ? "text-brand-strong" : ""}`}
              >
                <div>
                  <p className="font-medium">
                    {s.name}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      {s.short_name}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.tiers.map((t) => TIERS.find((v) => v.value === t)?.label ?? t).join(" · ") ||
                      "未标注层次"}
                  </p>
                </div>
                <div className="flex gap-3 text-sm">
                  <Link to={`?school_id=${s.id}`} className={linkClass}>
                    管理学院
                  </Link>
                  <Link to={`?school_id=${s.id}&edit_school=1`} className={linkClass}>
                    编辑学校
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          {schools.items.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">没有找到学校，可以在右侧新增。</p>
          )}
          <Pagination page={schools.page} nextPage={schools.next_page} name="school_page" />
        </section>
        <section className={panelClass}>
          <h2 className="mb-4 text-lg font-semibold">
            {editSchool && school ? `编辑学校：${school.name}` : "新增学校"}
          </h2>
          <Form
            method="post"
            className="space-y-4"
            key={`school-${editSchool ? school?.id : "new"}`}
          >
            <input type="hidden" name="intent" value="school" />
            {editSchool && school && <input type="hidden" name="id" value={school.id} />}
            <Field label="学校名称">
              <input
                name="name"
                required
                maxLength={200}
                defaultValue={schoolValues?.name ?? ""}
                className={inputClass}
              />
            </Field>
            <Field label="简称">
              <input
                name="short_name"
                maxLength={100}
                defaultValue={schoolValues?.short_name ?? ""}
                className={inputClass}
              />
            </Field>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">层次（可多选）</legend>
              <div className="flex flex-wrap gap-4">
                {TIERS.map((t) => (
                  <label key={t.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="tiers"
                      value={t.value}
                      defaultChecked={schoolValues?.tiers.includes(t.value)}
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-2">
              <Button disabled={busy}>{busy ? "保存中…" : "保存学校"}</Button>
              {editSchool && (
                <Link
                  to={school ? `?school_id=${school.id}` : "?"}
                  className={buttonVariants({ variant: "ghost" })}
                >
                  取消
                </Link>
              )}
            </div>
          </Form>
        </section>
      </div>
      {school ? (
        <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <section className={panelClass}>
            <h2 className="text-lg font-semibold">{school.name}的学院</h2>
            <ul className="mt-3 divide-y divide-border">
              {colleges?.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {KINDS.find((k) => k.value === c.kind)?.label} · {c.region}
                      {c.directions.length > 0 && ` · ${c.directions.join("、")}`}
                    </p>
                  </div>
                  <div className="flex gap-3 text-sm">
                    <Link to={`?school_id=${school.id}&edit_college=${c.id}`} className={linkClass}>
                      编辑
                    </Link>
                    <Link to={`/admin/sources?college_id=${c.id}`} className={linkClass}>
                      管理来源
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
            {colleges?.items.length === 0 && (
              <p className="py-6 text-sm text-muted-foreground">还没有学院，在右侧添加第一个。</p>
            )}
            {colleges && <Pagination page={colleges.page} nextPage={colleges.next_page} />}
          </section>
          <section className={panelClass}>
            <h2 className="mb-4 text-lg font-semibold">
              {college ? `编辑学院：${college.name}` : "新增学院"}
            </h2>
            <Form
              method="post"
              className="space-y-4"
              key={`college-${college?.id ?? "new"}-${school.id}`}
            >
              <input type="hidden" name="intent" value="college" />
              {college && <input type="hidden" name="id" value={college.id} />}
              <Field label="所属学校" hint="找不到目标学校时，可用上方搜索学校。">
                <select
                  name="school_id"
                  defaultValue={collegeValues?.school_id ?? school.id}
                  className={inputClass}
                >
                  {schoolOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="学院名称">
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={collegeValues?.name ?? ""}
                  className={inputClass}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="种类">
                  <select
                    name="kind"
                    defaultValue={collegeValues?.kind ?? "college"}
                    className={inputClass}
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="就读地区">
                  <input
                    name="region"
                    required
                    maxLength={100}
                    defaultValue={collegeValues?.region ?? ""}
                    placeholder="如广东深圳"
                    className={inputClass}
                  />
                </Field>
              </div>
              <Field label="方向" hint="多个方向用逗号或顿号分隔。">
                <input
                  name="directions"
                  defaultValue={collegeDraft?.directions ?? college?.directions.join("、") ?? ""}
                  placeholder="计算机、人工智能"
                  className={inputClass}
                />
              </Field>
              <div className="flex gap-2">
                <Button disabled={busy}>{busy ? "保存中…" : "保存学院"}</Button>
                {college && (
                  <Link
                    to={`?school_id=${school.id}`}
                    className={buttonVariants({ variant: "ghost" })}
                  >
                    取消
                  </Link>
                )}
              </div>
            </Form>
          </section>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          在学校列表中点「管理学院」，即可维护该校的学院并接入来源。
        </p>
      )}
    </AdminPage>
  );
}
