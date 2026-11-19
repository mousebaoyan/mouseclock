import type { InferResponseType } from "hono/client";
import { useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useFetcher,
  useLocation,
  useNavigation,
  useRouteLoaderData,
} from "react-router";
import { cn } from "~/cn";
import { keepOnly } from "~/components/filters";
import { Field, FormMessage } from "~/components/form";
import { List, Row } from "~/components/list";
import { Empty, Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { DateTime } from "~/components/time";
import { Button, buttonVariants } from "~/components/ui/button";
import { REQUEST_STATUSES } from "~/components/tags";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import {
  InclusionRequestInput,
  InclusionRequestPatch,
  RequestStatus,
} from "../../server/modules/sources/schemas.ts";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { loader as rootLoader } from "../root.tsx";
import type { Route } from "./+types/requests.ts";

type Api = ReturnType<typeof createApi>;
type Requests = InferResponseType<Api["inclusion-requests"]["$get"], 200>;
type Request = Requests["items"][number];
type CollegeList = InferResponseType<Api["colleges"]["$get"], 200>;

export function meta() {
  return [{ title: "求收录 · 鼠钟" }];
}

// `?new` opens the form, `?college=` with a college picked from its page; `?edit=` opens an ask
// for admins.
export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const api = context.get(apiContext);
  const status = RequestStatus.safeParse(params.get("status")).data ?? "queued";
  const asking = params.has("new");
  const editing = Number(params.get("edit")) || null;
  const [requests, colleges] = await Promise.all([
    api["inclusion-requests"]
      .$get({
        query: {
          status,
          page: params.get("page") ?? undefined,
          per_page: params.get("per_page") ?? undefined,
        },
      })
      .then(readApi<Requests>),
    // The list to pick from, to ask or for admins to match an ask to.
    asking || editing ? api.colleges.$get().then(readApi<CollegeList>) : null,
  ]);
  return {
    requests,
    status,
    asking,
    editing,
    picked: Number(params.get("college")) || null,
    asked: params.get("asked"),
    schools: colleges?.schools.map(({ id, name, colleges: list }) => ({
      id,
      name,
      colleges: list.map((c) => ({ id: c.id, name: c.name })),
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const form = await request.formData();
  const intent = formText(form, "intent");
  const param = { id: formText(form, "id") };
  if (request.method === "PUT" || request.method === "DELETE") {
    const vote = api["inclusion-requests"][":id"].vote;
    const res =
      request.method === "PUT" ? await vote.$put({ param }) : await vote.$delete({ param });
    if (res.status === 204) return null;
    return data({ error: (await res.json()).error.message, college: null }, res.status);
  }
  if (intent === "ask") {
    const school = formText(form, "school");
    const college = formText(form, "college");
    const asked = {
      url_hint: formText(form, "url_hint").trim() || null,
      note: formText(form, "note"),
    };
    const input = InclusionRequestInput.safeParse(
      college && college !== "other"
        ? { college_id: Number(college), ...asked }
        : school && school !== "other"
          ? { school_id: Number(school), college_name: formText(form, "college_name"), ...asked }
          : {
              school_name: formText(form, "school_name"),
              college_name: formText(form, "college_name"),
              ...asked,
            },
    );
    if (!input.success) return data({ error: input.error.issues[0].message, college: null }, 400);
    const res = await api["inclusion-requests"].$post({ json: input.data });
    if (res.status === 200 || res.status === 201) {
      return redirect(`/requests?asked=${res.status === 201 ? "new" : "vote"}`);
    }
    const { error } = await res.json();
    // Already crawled: the page says so and links to the college.
    const crawled = error.code === "already_included" && "college_id" in input.data;
    return data({ error: error.message, college: crawled ? Number(college) : null }, res.status);
  }
  const admin = api.admin["inclusion-requests"][":id"];
  let res;
  if (intent === "merge") {
    res = await admin.merge.$post({ param, json: { into: Number(formText(form, "into")) } });
  } else {
    const status = formText(form, "status");
    const patches: Record<string, unknown> = {
      status: status === "unavailable" ? { status, reason: formText(form, "reason") } : { status },
      match_college: { college_id: Number(formText(form, "college")) },
      match_school: { school_id: Number(formText(form, "school")) },
    };
    if (!Object.hasOwn(patches, intent)) throw data("不支持的操作", { status: 400 });
    const patch = InclusionRequestPatch.safeParse(patches[intent]);
    if (!patch.success) return data({ error: patch.error.issues[0].message, college: null }, 400);
    res = await admin.$patch({ param, json: patch.data });
  }
  if (res.status !== 204) {
    return data({ error: (await res.json()).error.message, college: null }, res.status);
  }
  // Back to the column and page it was on.
  return redirect(`/requests?${new URLSearchParams(formText(form, "back"))}`);
}

// 求收录 (design §10.1): colleges members want crawled, in columns by how far each went.
export default function Requests({ loaderData, actionData }: Route.ComponentProps) {
  const { requests, status, asking, editing, picked, asked, schools } = loaderData;
  const me = useRouteLoaderData<typeof rootLoader>("root")?.me;
  const muted = me?.muted ?? true;
  return (
    <Page title="求收录" hideTitle>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="进度"
          items={requests.counts.map((c) => ({
            to: `?status=${c.status}`,
            label: REQUEST_STATUSES[c.status],
            count: c.count,
            on: c.status === status,
          }))}
        />
        {!muted && !asking && (
          <Link to="?new" className={buttonVariants({ size: "sm" })}>
            求收录
          </Link>
        )}
      </div>
      {muted && <p className="text-[13px] text-muted-foreground">禁言中，不能提求收录和同求</p>}
      {asked && (
        <FormMessage
          saved={asked === "new" ? "已提交，排在「排队中」" : "这个学院已经有人提过了，算你同求"}
        />
      )}
      {asking && schools && !muted && (
        <Panel title="求收录" description="想看的学院还没收录，就提一个；有人提过的直接算同求">
          <AskForm
            schools={schools}
            picked={picked}
            error={actionData?.error}
            crawled={actionData?.college ?? null}
          />
        </Panel>
      )}
      {!asking && actionData?.error && <FormMessage error={actionData.error} />}
      <div>
        {requests.items.length === 0 ? (
          <Empty>{`没有${REQUEST_STATUSES[status]}的求收录`}</Empty>
        ) : (
          <List>
            {requests.items.map((item) => (
              <RequestRow
                key={item.id}
                item={item}
                muted={muted}
                admin={me?.can.admin ?? false}
                editing={me?.can.admin === true && editing === item.id}
                schools={schools}
              />
            ))}
          </List>
        )}
        {/* Still there past the last page, say once its last ask left. */}
        {requests.total > 0 && (
          <Pagination total={requests.total} page={requests.page} perPage={requests.per_page} />
        )}
      </div>
    </Page>
  );
}

function RequestRow({
  item,
  muted,
  admin,
  editing,
  schools,
}: {
  item: Request;
  muted: boolean;
  admin: boolean;
  editing: boolean;
  schools: { id: number; name: string; colleges: { id: number; name: string }[] }[] | undefined;
}) {
  const name = `${item.school.name} ${item.college.name}`;
  // The column and page stay as they are while it's handled.
  const list = new URLSearchParams(keepOnly(useLocation().search, ["status", "page", "per_page"]));
  const opened = new URLSearchParams(list);
  opened.set("edit", String(item.id));
  return (
    <Row
      title={
        item.college.id === null ? (
          <span className="text-[15px] font-medium">{name}</span>
        ) : (
          <Link
            to={`/colleges/${item.college.id}`}
            className="text-[15px] font-medium hover:text-primary"
          >
            {name}
          </Link>
        )
      }
      meta={
        <>
          <span>
            提于 <DateTime value={item.created_at} />
          </span>
          {item.url_hint && (
            <a
              href={item.url_hint}
              target="_blank"
              rel="nofollow noopener"
              className="hover:text-primary"
            >
              通知列表页
            </a>
          )}
          {item.reason && <span>原因：{item.reason}</span>}
          {admin && <span className="tabular-nums">#{item.id}</span>}
          {admin && (
            <Link
              to={`?${editing ? list : opened}`}
              preventScrollReset
              className="hover:text-primary"
            >
              {editing ? "收起" : "处理"}
            </Link>
          )}
        </>
      }
      side={<VoteButton item={item} muted={muted} />}
    >
      {item.note && <p className="mt-1.5 text-[13px] text-pretty wrap-anywhere">{item.note}</p>}
      {editing && schools && <Handle item={item} schools={schools} back={String(list)} />}
    </Row>
  );
}

// 同求 and how many did; while it goes it shows what it will be.
function VoteButton({ item, muted }: { item: Request; muted: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const going = fetcher.formMethod === undefined ? null : fetcher.formMethod === "PUT";
  const on = going ?? item.mine;
  const count = item.votes + (on === item.mine ? 0 : on ? 1 : -1);
  const closed = item.status === "included";
  return (
    <fetcher.Form method={on ? "delete" : "put"} className="relative">
      <input type="hidden" name="id" value={item.id} />
      <button
        type="submit"
        aria-pressed={on}
        // Following the college counts as voting, until one stops following it.
        disabled={muted || closed || item.following || fetcher.state !== "idle"}
        title={item.following ? "关注着这个学院，就算同求了" : undefined}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] whitespace-nowrap tabular-nums pointer-coarse:h-9 disabled:cursor-default",
          on
            ? "border-primary/60 bg-primary-soft font-medium text-primary"
            : "bg-card text-foreground/80 enabled:hover:border-input enabled:hover:text-foreground",
        )}
      >
        {closed ? "同求过" : item.following ? "关注着" : "同求"}
        <span className="text-xs font-normal opacity-60">{count}</span>
      </button>
      {fetcher.state === "idle" && fetcher.data && (
        <p
          role="alert"
          className="absolute top-full right-0 z-10 mt-1.5 w-max max-w-60 rounded-lg border bg-card px-3 py-2 text-left text-xs shadow-card"
        >
          {fetcher.data.error}
        </p>
      )}
    </fetcher.Form>
  );
}

function AskForm({
  schools,
  picked,
  error,
  crawled,
}: {
  schools: { id: number; name: string; colleges: { id: number; name: string }[] }[];
  picked: number | null;
  error: string | undefined;
  crawled: number | null;
}) {
  const from = schools.find((s) => s.colleges.some((c) => c.id === picked));
  const [school, setSchool] = useState(from ? String(from.id) : "");
  const [college, setCollege] = useState(picked && from ? String(picked) : "");
  const listed = schools.find((s) => String(s.id) === school);
  const busy = useNavigation().state !== "idle";
  const other = { value: "other", label: "清单里没有，手动填写" };
  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value="ask" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">学校</span>
          <Select
            name="school"
            aria-label="学校"
            value={school}
            onValueChange={(value) => {
              setSchool(value);
              setCollege("");
            }}
            options={[
              { value: "", label: "选择学校" },
              ...schools.map((s) => ({ value: String(s.id), label: s.name })),
              other,
            ]}
          />
          {school === "other" && (
            <input
              name="school_name"
              required
              maxLength={200}
              placeholder="学校名称"
              className="field"
            />
          )}
        </div>
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">学院</span>
          {listed ? (
            <Select
              name="college"
              aria-label="学院"
              value={college}
              onValueChange={setCollege}
              options={[
                { value: "", label: "选择学院" },
                ...listed.colleges.map((c) => ({ value: String(c.id), label: c.name })),
                other,
              ]}
            />
          ) : null}
          {(school === "other" || college === "other") && (
            <input
              name="college_name"
              required
              maxLength={200}
              placeholder="学院名称"
              className="field"
            />
          )}
        </div>
        <Field label="通知列表页的链接" hint="知道的话附上，没有可以不填">
          <input
            name="url_hint"
            type="url"
            maxLength={2000}
            placeholder="https://"
            className="field"
          />
        </Field>
        <Field label="备注" hint="最多 500 字">
          <input name="note" maxLength={500} className="field" />
        </Field>
      </div>
      {error && <FormMessage error={error} />}
      {crawled !== null && (
        <Link to={`/colleges/${crawled}`} className="text-[13px] text-primary hover:underline">
          去学院页
        </Link>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy}>
          提交
        </Button>
        <Link to="?" className={buttonVariants({ size: "sm", variant: "outline" })}>
          取消
        </Link>
      </div>
    </Form>
  );
}

// For admins: how far it went, which college of the list it is, or that it's another's twin.
function Handle({
  item,
  schools,
  back,
}: {
  item: Request;
  schools: { id: number; name: string; colleges: { id: number; name: string }[] }[];
  back: string;
}) {
  const busy = useNavigation().state !== "idle";
  const [status, setStatus] = useState<string>(item.status);
  const hidden = (intent: string) => (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="back" value={back} />
    </>
  );
  return (
    <div className="mt-3 space-y-3 rounded-md border bg-muted/50 p-3">
      <Form method="post" className="flex flex-wrap items-end gap-2">
        {hidden("status")}
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium">进度</span>
          <Select
            name="status"
            aria-label="进度"
            value={status}
            onValueChange={setStatus}
            // Included is a college on the list being crawled.
            options={Object.entries(REQUEST_STATUSES)
              .filter(([value]) => value !== "included" || item.college.id !== null)
              .map(([value, label]) => ({ value, label }))}
            className="w-32"
          />
        </div>
        {status === "unavailable" && (
          <input
            name="reason"
            required
            maxLength={500}
            defaultValue={item.reason ?? ""}
            placeholder="原因，比如要登录才能看"
            aria-label="暂时抓不了的原因"
            className="field min-w-48 flex-1"
          />
        )}
        <Button size="sm" disabled={busy}>
          保存
        </Button>
      </Form>
      {item.college.id === null && (
        <Form method="post" className="flex flex-wrap items-end gap-2">
          {hidden("match_college")}
          <div className="min-w-0 flex-1 space-y-1.5">
            <span className="block text-[13px] font-medium">对上清单里的学院</span>
            <Select
              name="college"
              aria-label="对上清单里的学院"
              options={schools.flatMap((s) =>
                s.colleges.map((c) => ({ value: String(c.id), label: `${s.name} ${c.name}` })),
              )}
            />
          </div>
          <Button size="sm" variant="outline" disabled={busy}>
            对上
          </Button>
        </Form>
      )}
      {item.college.id === null && (
        <p className="text-xs text-muted-foreground">
          清单里没有的学院，先在
          <Link to="/admin/colleges" className="text-primary hover:underline">
            院校管理
          </Link>
          里加上再对上；对上的学院接入了来源，就自动算已收录
        </p>
      )}
      {item.school.id === null && (
        <Form method="post" className="flex flex-wrap items-end gap-2">
          {hidden("match_school")}
          <div className="min-w-0 flex-1 space-y-1.5">
            <span className="block text-[13px] font-medium">只对上学校</span>
            <Select
              name="school"
              aria-label="只对上学校"
              options={schools.map((s) => ({ value: String(s.id), label: s.name }))}
            />
          </div>
          <Button size="sm" variant="outline" disabled={busy}>
            对上
          </Button>
        </Form>
      )}
      <Form method="post" className="flex flex-wrap items-end gap-2">
        {hidden("merge")}
        <Field label="是重复的，并进" hint="填另一条的编号，在各栏里每条后面的 # 号">
          <input name="into" required inputMode="numeric" pattern="[0-9]+" className="field w-32" />
        </Field>
        <Button size="sm" variant="outline" disabled={busy}>
          合并
        </Button>
      </Form>
    </div>
  );
}
