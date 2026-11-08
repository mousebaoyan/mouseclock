import type { InferResponseType } from "hono/client";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { CrawlTime, Field, FormMessage, inputClass, panelClass } from "../components/admin.tsx";
import { Tag } from "../components/tags.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import type { Route } from "./+types/admin-settings.ts";

type Api = ReturnType<typeof createApi>;
type Tokens = InferResponseType<Api["admin"]["crawler-tokens"]["$get"], 200>;

export function meta() {
  return [{ title: "系统设置 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const tokens = await context
    .get(apiContext)
    .admin["crawler-tokens"].$get()
    .then((res) => readApi<Tokens>(res));
  return { tokens, revoking: Number(params.get("revoke")), saved: params.has("saved") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext).admin["crawler-tokens"];
  const form = await request.formData();
  const intent = formText(form, "intent");
  if (intent === "create") {
    const name = formText(form, "name");
    const res = await api.$post({ json: { name } });
    if (res.status !== 201) {
      return data({ error: (await res.json()).error.message, name }, { status: res.status });
    }
    return { token: (await res.json()).token, name };
  }
  if (intent === "revoke") {
    const res = await api[":id"].revoke.$post({ param: { id: formText(form, "id") } });
    if (res.status !== 204) {
      return data({ error: (await res.json()).error.message, name: "" }, { status: res.status });
    }
    return redirect("/admin/settings?saved=1");
  }
  throw data("未知操作", { status: 400 });
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { tokens, revoking, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  const made = actionData && "token" in actionData ? actionData : null;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-3 py-6 sm:px-5">
      <header>
        <p className="mb-2 text-sm font-medium text-brand-strong">站长</p>
        <h1 className="text-2xl font-semibold">系统设置</h1>
      </header>

      <section className={`${panelClass} space-y-4`}>
        <div>
          <h2 className="text-lg font-semibold">抓取节点令牌</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            抓取节点用它调网站的接口（接口
            §6）。每个抓取节点一个，换机器或者泄露了就作废，重新生成。
          </p>
        </div>
        <FormMessage error={error} saved={saved && !made} />
        {made && (
          <div className="space-y-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
            <p className="text-success">
              「{made.name}
              」的令牌生成了。它只显示这一次，现在复制下来填进抓取节点的配置；忘了就只能作废、重新生成。
            </p>
            <input
              readOnly
              value={made.token}
              aria-label="新令牌"
              onFocus={(event) => event.currentTarget.select()}
              className={`${inputClass} font-mono`}
            />
          </div>
        )}
        {/* A new key once a token is made, so the name typed for it is cleared. */}
        <Form key={made?.token} method="post" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="create" />
          <div className="min-w-48 flex-1">
            <Field label="名字" hint="用在哪个抓取节点，比如「上海」">
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={made ? "" : actionData?.name}
                className={inputClass}
              />
            </Field>
          </div>
          <Button disabled={busy} className="mb-6">
            生成令牌
          </Button>
        </Form>

        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有令牌。</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <span className="font-medium">{token.name}</span>
                {token.revoked_at !== null && <Tag color="red">已作废</Tag>}
                <span className="text-xs text-muted-foreground">
                  生成于 <CrawlTime value={token.created_at} /> · 上次来领活{" "}
                  {token.last_seen_at === null ? (
                    "还没有"
                  ) : (
                    <CrawlTime value={token.last_seen_at} />
                  )}
                  {token.revoked_at !== null && (
                    <>
                      {" "}
                      · 作废于 <CrawlTime value={token.revoked_at} />
                    </>
                  )}
                </span>
                {token.revoked_at === null &&
                  (revoking === token.id ? (
                    <Form method="post" className="ml-auto flex flex-wrap items-center gap-2">
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="id" value={token.id} />
                      <span className="text-destructive">作废后用它的抓取节点马上就连不上了。</span>
                      <Button size="sm" variant="destructive" disabled={busy}>
                        确认作废
                      </Button>
                      <Link
                        to="/admin/settings"
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                      >
                        取消
                      </Link>
                    </Form>
                  ) : (
                    <Link
                      to={`?revoke=${token.id}`}
                      className={`${buttonVariants({ variant: "ghost", size: "sm" })} ml-auto`}
                    >
                      作废
                    </Link>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
