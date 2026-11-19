import type { InferResponseType } from "hono/client";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { TagInput, TagPatch } from "../../server/modules/programs/schemas.ts";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { Field, FormMessage } from "../components/form.tsx";
import { List, Row } from "../components/list.tsx";
import { Page, Panel } from "../components/page.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { forgetTable } from "../table-cache.ts";
import type { Route } from "./+types/admin-tags.ts";

type Tags = InferResponseType<ReturnType<typeof createApi>["admin"]["tags"]["$get"], 200>;

export function meta() {
  return [{ title: "学院标签 · 鼠钟" }];
}

// `?edit=` opens a preset's form, `?delete=` asks before deleting it.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { tags } = await readApi<Tags>(await context.get(apiContext).admin.tags.$get());
  const params = new URL(request.url).searchParams;
  return {
    tags,
    editing: Number(params.get("edit")) || null,
    deleting: Number(params.get("delete")) || null,
    saved: params.has("saved"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext).admin.tags;
  const form = await request.formData();
  const intent = formText(form, "intent");
  const param = { id: formText(form, "id") };
  let res;
  if (intent === "delete") {
    res = await api[":id"].$delete({ param });
  } else if (intent === "move") {
    res = await api[":id"].$patch({ param, json: { sort: Number(formText(form, "sort")) } });
  } else {
    const values = { name: formText(form, "name"), description: formText(form, "description") };
    if (intent === "create") {
      const input = TagInput.safeParse(values);
      if (!input.success) return data({ error: input.error.issues[0].message }, 400);
      res = await api.$post({ json: input.data });
    } else {
      const input = TagPatch.safeParse(values);
      if (!input.success) return data({ error: input.error.issues[0].message }, 400);
      res = await api[":id"].$patch({ param, json: input.data });
    }
  }
  if (res.status !== 201 && res.status !== 204) {
    return data({ error: (await res.json()).error.message }, res.status);
  }
  return redirect("/admin/tags?saved=1");
}

// Renamed or deleted presets change the tags the table filters by.
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  forgetTable();
  return serverAction();
}

// 管理 · 学院标签 (design §9.3): the presets members pick from, in the order they are shown.
export default function AdminTags({ loaderData, actionData }: Route.ComponentProps) {
  const { tags, editing, deleting, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <Page title="学院标签" hideTitle>
      <Panel
        title="学院标签"
        description="成员只能从这些标签里选；改名不影响已经贴的，删除连同大家贴的一起删"
        flush
      >
        {(actionData?.error || saved) && (
          <div className="border-b px-4 py-3 sm:px-5">
            <FormMessage error={actionData?.error} saved={saved && "已保存"} />
          </div>
        )}
        <List className="rounded-none border-0 shadow-none">
          {tags.map((tag, i) => (
            <Row
              key={tag.id}
              title={<span className="font-medium">{tag.name}</span>}
              meta={
                <>
                  <span className="min-w-0 wrap-anywhere">{tag.description}</span>
                  <span className="tabular-nums">{tag.voters} 人贴过</span>
                </>
              }
              side={
                <div className="flex flex-wrap justify-end gap-1">
                  {[
                    { label: "上移", sort: tag.sort - 1, off: i === 0 },
                    { label: "下移", sort: tag.sort + 1, off: i === tags.length - 1 },
                  ].map((move) => (
                    <Form key={move.label} method="post" preventScrollReset>
                      <input type="hidden" name="intent" value="move" />
                      <input type="hidden" name="id" value={tag.id} />
                      <input type="hidden" name="sort" value={move.sort} />
                      <Button size="xs" variant="ghost" disabled={busy || move.off}>
                        {move.label}
                      </Button>
                    </Form>
                  ))}
                  <Link
                    to={`?edit=${tag.id}`}
                    preventScrollReset
                    className={buttonVariants({ size: "xs", variant: "ghost" })}
                  >
                    修改
                  </Link>
                  <Link
                    to={`?delete=${tag.id}`}
                    preventScrollReset
                    className={buttonVariants({ size: "xs", variant: "ghost" })}
                  >
                    删除
                  </Link>
                </div>
              }
            >
              {editing === tag.id && (
                <TagForm tag={tag} busy={busy} cancel="?" key={`edit-${tag.id}`} />
              )}
              {deleting === tag.id && (
                <Form method="post" className="mt-3 space-y-3 rounded-md border bg-muted/50 p-3">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={tag.id} />
                  <p className="text-[13px]">
                    删除「{tag.name}」？
                    {tag.voters > 0
                      ? `${tag.voters} 个人贴过，他们贴的会一起删掉。`
                      : "还没有人贴过。"}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" disabled={busy}>
                      删除
                    </Button>
                    <Link to="?" className={buttonVariants({ size: "sm", variant: "outline" })}>
                      取消
                    </Link>
                  </div>
                </Form>
              )}
            </Row>
          ))}
        </List>
      </Panel>
      <Panel title="新增标签" description="用词要中性；说明讲清楚贴它是什么意思">
        {/* Empty again once one is added. */}
        <TagForm tag={null} busy={busy} key={tags.map((t) => t.id).join()} />
      </Panel>
    </Page>
  );
}

function TagForm({
  tag,
  busy,
  cancel,
}: {
  tag: Tags["tags"][number] | null;
  busy: boolean;
  cancel?: string;
}) {
  return (
    <Form method="post" className="mt-3 space-y-3 first:mt-0">
      <input type="hidden" name="intent" value={tag ? "update" : "create"} />
      {tag && <input type="hidden" name="id" value={tag.id} />}
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Field label="标签名">
          <input
            name="name"
            required
            maxLength={20}
            defaultValue={tag?.name ?? ""}
            className="field"
          />
        </Field>
        <Field label="说明">
          <input
            name="description"
            required
            maxLength={200}
            defaultValue={tag?.description ?? ""}
            className="field"
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy}>
          {tag ? "保存" : "添加"}
        </Button>
        {cancel && (
          <Link to={cancel} className={buttonVariants({ size: "sm", variant: "outline" })}>
            取消
          </Link>
        )}
      </div>
    </Form>
  );
}
