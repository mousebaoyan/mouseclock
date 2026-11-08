import { data, Form, Link, redirect, useNavigation } from "react-router";
import { CollegeInput, SchoolInput } from "../../server/modules/sources/schemas.ts";
import { apiContext, readApi } from "../api.server.ts";
import {
  formText,
  type SchoolsPage,
  type SchoolDetail,
  type CollegesPage,
  type CollegeDetail,
} from "../admin.server.ts";
import { Field, FormMessage } from "~/components/form";
import { Search } from "~/components/icons";
import { Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { COLLEGE_KINDS, TierTags } from "~/components/tags";
import { TIERS } from "~/tiers";
import { Button, buttonVariants } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Select } from "~/components/ui/select";
import { List, Row } from "~/components/list";
import { Missing } from "~/components/program";
import { Table, Td, Th, Tr } from "~/components/ui/table";
import { cn } from "~/cn";
import type { Route } from "./+types/admin-colleges.ts";

export function meta() {
  return [{ title: "院校管理 · 鼠钟" }];
}

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
    await api.schools.$get({
      query: {
        q,
        page: params.get("school_page") ?? undefined,
        per_page: params.get("school_per_page") ?? undefined,
      },
    }),
  );
  const [school, colleges, college] = await Promise.all([
    schoolId
      ? api.schools[":id"]
          .$get({ param: { id: schoolId } })
          .then((res) => readApi<SchoolDetail>(res))
      : null,
    schoolId
      ? api.colleges
          .$get({
            query: {
              school_id: schoolId,
              page: params.get("page") ?? undefined,
              per_page: params.get("per_page") ?? undefined,
            },
          })
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
      `/admin/colleges?school_id=${result.school_id}&edit_college=${result.id}&saved=1`,
    );
  }
  throw data("不支持的操作", { status: 400 });
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
  const schoolForm = (
    <Panel title={editSchool && school ? `编辑学校：${school.name}` : "新增学校"}>
      <Form method="post" className="space-y-4" key={`school-${editSchool ? school?.id : "new"}`}>
        <input type="hidden" name="intent" value="school" />
        {editSchool && school && <input type="hidden" name="id" value={school.id} />}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="学校名称">
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={schoolValues?.name ?? ""}
              className="field"
            />
          </Field>
          <Field label="简称">
            <input
              name="short_name"
              maxLength={100}
              defaultValue={schoolValues?.short_name ?? ""}
              className="field"
            />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">层次（可多选）</legend>
          <div className="flex flex-wrap gap-5">
            {TIERS.map((t) => (
              <Checkbox
                key={t.value}
                name="tiers"
                value={t.value}
                defaultChecked={schoolValues?.tiers.includes(t.value)}
              >
                {t.label}
              </Checkbox>
            ))}
          </div>
        </fieldset>
        <div className="flex gap-2">
          <Button disabled={busy}>{busy ? "正在保存…" : "保存学校"}</Button>
          {editSchool && (
            <Link
              to={school ? `?school_id=${school.id}` : "?"}
              className={buttonVariants({ variant: "outline" })}
            >
              取消
            </Link>
          )}
        </div>
      </Form>
    </Panel>
  );
  return (
    <Page title="院校管理" hideTitle>
      <FormMessage error={actionData?.error} saved={saved && "已保存"} />
      <div className="grid items-start gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Panel
          title="学校"
          actions={
            <Link to="?" className={buttonVariants({ variant: "outline", size: "sm" })}>
              新增学校
            </Link>
          }
          flush
        >
          <Form method="get" className="flex gap-2 border-b p-3" aria-label="搜索学校">
            {college && <input type="hidden" name="edit_college" value={college.id} />}
            {school && <input type="hidden" name="school_id" value={school.id} />}
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">搜索学校</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle-foreground" />
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="学校名称或简称"
                className="field pl-9"
              />
            </label>
            <Button variant="outline">搜索</Button>
          </Form>
          {schools.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">未找到学校</p>
          ) : (
            <ul className="divide-y">
              {schools.items.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`?school_id=${s.id}`}
                    preventScrollReset
                    aria-current={school?.id === s.id ? "true" : undefined}
                    className="flex items-center justify-between gap-3 border-l-2 border-transparent px-4 py-2.5 hover:bg-muted/50 aria-[current]:border-primary aria-[current]:bg-primary-soft"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{s.name}</span>
                      {s.short_name && (
                        <span className="block text-xs text-muted-foreground">{s.short_name}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <TierTags tiers={s.tiers} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="px-3 pb-3 empty:hidden">
            <Pagination
              total={schools.total}
              page={schools.page}
              perPage={schools.per_page}
              prefix="school_"
            />
          </div>
        </Panel>
        <div className="min-w-0 space-y-5">
          {!school || editSchool ? (
            schoolForm
          ) : (
            <>
              <Panel
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {school.name}
                    <TierTags tiers={school.tiers} />
                  </span>
                }
                description={school.short_name && `简称：${school.short_name}`}
                actions={
                  <Link
                    to={`?school_id=${school.id}&edit_school=1`}
                    preventScrollReset
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    编辑学校
                  </Link>
                }
                flush
              >
                {colleges?.items.length === 0 ? (
                  <p className="px-4 py-6 text-center text-[13px] text-muted-foreground sm:px-5">
                    该校尚无学院，请在下方添加
                  </p>
                ) : (
                  <>
                    <Table bare className="max-xl:hidden">
                      <thead>
                        <tr>
                          <Th>学院</Th>
                          <Th>类型</Th>
                          <Th>所在地</Th>
                          <Th>招生方向</Th>
                          <Th>
                            <span className="sr-only">操作</span>
                          </Th>
                        </tr>
                      </thead>
                      <tbody>
                        {colleges?.items.map((c) => (
                          <Tr key={c.id} className={cn(college?.id === c.id && "bg-primary-soft")}>
                            <Td className="font-medium">{c.name}</Td>
                            <Td center>{COLLEGE_KINDS[c.kind] ?? c.kind}</Td>
                            <Td center>{c.region}</Td>
                            <Td className="text-muted-foreground">
                              {c.directions.join("、") || <Missing />}
                            </Td>
                            <Td center>
                              <CollegeActions school={school.id} college={c.id} />
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                    <List className="rounded-none border-0 shadow-none xl:hidden">
                      {colleges?.items.map((c) => (
                        <Row
                          key={c.id}
                          selected={college?.id === c.id}
                          title={<span className="font-medium">{c.name}</span>}
                          meta={
                            <>
                              <span>{COLLEGE_KINDS[c.kind] ?? c.kind}</span>
                              <span>{c.region}</span>
                              {c.directions.length > 0 && (
                                <span>招生方向：{c.directions.join("、")}</span>
                              )}
                            </>
                          }
                          side={<CollegeActions school={school.id} college={c.id} />}
                        />
                      ))}
                    </List>
                  </>
                )}
                {colleges && (
                  <div className="px-4 pb-4 empty:hidden sm:px-5">
                    <Pagination
                      total={colleges.total}
                      page={colleges.page}
                      perPage={colleges.per_page}
                    />
                  </div>
                )}
              </Panel>
              <Panel title={college ? `编辑学院：${college.name}` : "新增学院"}>
                <Form
                  method="post"
                  className="space-y-4"
                  key={`college-${college?.id ?? "new"}-${school.id}`}
                >
                  <input type="hidden" name="intent" value="college" />
                  {college && <input type="hidden" name="id" value={college.id} />}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <span className="block text-[13px] font-medium">所属学校</span>
                      <Select
                        name="school_id"
                        aria-label="所属学校"
                        defaultValue={String(collegeValues?.school_id ?? school.id)}
                        options={schoolOptions.map((s) => ({ value: String(s.id), label: s.name }))}
                      />
                      <p className="text-xs text-muted-foreground">找不到学校时可在左侧搜索</p>
                    </div>
                    <Field label="学院名称">
                      <input
                        name="name"
                        required
                        maxLength={200}
                        defaultValue={collegeValues?.name ?? ""}
                        className="field"
                      />
                    </Field>
                    <div className="space-y-1.5">
                      <span className="block text-[13px] font-medium">单位类型</span>
                      <Select
                        name="kind"
                        aria-label="单位类型"
                        defaultValue={collegeValues?.kind ?? "college"}
                        options={Object.entries(COLLEGE_KINDS).map(([value, label = value]) => ({
                          value,
                          label,
                        }))}
                      />
                    </div>
                    <Field label="所在地区">
                      <input
                        name="region"
                        required
                        maxLength={100}
                        defaultValue={collegeValues?.region ?? ""}
                        placeholder="例如：广东"
                        className="field"
                      />
                    </Field>
                  </div>
                  <Field label="招生方向" hint="多个方向以逗号或顿号分隔">
                    <input
                      name="directions"
                      defaultValue={
                        collegeDraft?.directions ?? college?.directions.join("、") ?? ""
                      }
                      placeholder="计算机、人工智能"
                      className="field"
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button disabled={busy}>{busy ? "正在保存…" : "保存学院"}</Button>
                    {college && (
                      <Link
                        to={`?school_id=${school.id}`}
                        className={buttonVariants({ variant: "outline" })}
                      >
                        取消
                      </Link>
                    )}
                  </div>
                </Form>
              </Panel>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

function CollegeActions({ school, college }: { school: number; college: number }) {
  return (
    <span className="inline-flex gap-1">
      <Link
        to={`?school_id=${school}&edit_college=${college}`}
        className={buttonVariants({ variant: "outline", size: "xs" })}
      >
        编辑
      </Link>
      <Link
        to={`/admin/sources?college_id=${college}`}
        className={buttonVariants({ variant: "outline", size: "xs" })}
      >
        来源
      </Link>
    </span>
  );
}
