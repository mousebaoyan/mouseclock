import type { InferResponseType } from "hono/client";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { Field, FormMessage } from "../components/form.tsx";
import { Page, Panel } from "../components/page.tsx";
import { DateTime } from "../components/time.tsx";
import { List, Row } from "../components/list.tsx";
import { Table, Td, Tr } from "../components/ui/table.tsx";
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
  throw data("不支持的操作", { status: 400 });
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { tokens, revoking, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  const made = actionData && "token" in actionData ? actionData : null;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  return (
    <Page title="系统设置" hideTitle>
      <Panel
        title="抓取节点令牌"
        description="每个抓取节点使用一个令牌，更换机器或令牌泄露时请作废后重新生成"
      >
        <div className="space-y-4">
          <FormMessage error={error} saved={saved && !made && "已保存"} />
          {made && (
            <div className="space-y-2 rounded-md border border-success/25 bg-success/5 p-3 text-[13px]">
              <p className="text-success">
                已生成「{made.name}
                」的令牌，令牌仅显示这一次，请立即复制到抓取节点的配置中
              </p>
              <input
                readOnly
                value={made.token}
                aria-label="新令牌"
                onFocus={(event) => event.currentTarget.select()}
                className="field font-mono text-xs"
              />
            </div>
          )}
          {/* A new key once a token is made, so the name typed for it is cleared. */}
          <Form key={made?.token} method="post" className="flex flex-wrap items-start gap-2">
            <input type="hidden" name="intent" value="create" />
            <Field
              label="令牌名称"
              hint="标明用于哪个抓取节点，例如「上海」"
              className="min-w-48 flex-1"
            >
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={made ? "" : actionData?.name}
                className="field"
              />
            </Field>
            <Button disabled={busy} className="mt-6.5">
              生成令牌
            </Button>
          </Form>
        </div>
      </Panel>
      <Panel title="已有令牌" flush>
        {tokens.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">暂无令牌</p>
        ) : (
          <>
            <Table
              bare
              className="max-lg:hidden"
              head={["名称", "状态", "生成时间", "最近领取任务"]}
              actions="操作"
            >
              {tokens.map((token) => (
                <Tr key={token.id}>
                  <Td className="font-medium">{token.name}</Td>
                  <Td nowrap>
                    <TokenState token={token} />
                  </Td>
                  <Td nowrap>
                    <DateTime value={token.created_at} />
                  </Td>
                  <Td nowrap>
                    {token.last_seen_at === null ? (
                      <span className="text-subtle-foreground">尚未领取</span>
                    ) : (
                      <DateTime value={token.last_seen_at} />
                    )}
                  </Td>
                  <Td nowrap>
                    <Revoke token={token} revoking={revoking} busy={busy} />
                  </Td>
                </Tr>
              ))}
            </Table>
            <List className="rounded-none border-0 shadow-none lg:hidden">
              {tokens.map((token) => (
                <Row
                  key={token.id}
                  title={
                    <>
                      <span className="font-medium">{token.name}</span>
                      <TokenState token={token} />
                    </>
                  }
                  meta={
                    <>
                      <span>
                        生成于 <DateTime value={token.created_at} />
                      </span>
                      <span>
                        {token.last_seen_at === null ? (
                          "尚未领取任务"
                        ) : (
                          <>
                            最近领取任务 <DateTime value={token.last_seen_at} />
                          </>
                        )}
                      </span>
                    </>
                  }
                  side={<Revoke token={token} revoking={revoking} busy={busy} />}
                />
              ))}
            </List>
          </>
        )}
        {tokens.some((token) => token.id === revoking && token.revoked_at === null) && (
          <p className="border-t px-4 py-2.5 text-[13px] text-destructive sm:px-5">
            作废后，使用该令牌的抓取节点将立即无法连接
          </p>
        )}
      </Panel>
    </Page>
  );
}

type Token = Tokens[number];

function TokenState({ token }: { token: Token }) {
  return token.revoked_at === null ? (
    <Tag color="green">使用中</Tag>
  ) : (
    <Tag color="gray">已作废</Tag>
  );
}

// 作废 asks again on the same row before it revokes; once revoked, when it was.
function Revoke({ token, revoking, busy }: { token: Token; revoking: number; busy: boolean }) {
  if (token.revoked_at !== null) {
    return (
      <span className="text-xs text-muted-foreground">
        作废于 <DateTime value={token.revoked_at} />
      </span>
    );
  }
  return revoking === token.id ? (
    <Form method="post" className="inline-flex items-center gap-1.5">
      <input type="hidden" name="intent" value="revoke" />
      <input type="hidden" name="id" value={token.id} />
      <Button size="xs" variant="destructive" disabled={busy}>
        确认作废
      </Button>
      <Link to="/admin/settings" className={buttonVariants({ variant: "outline", size: "xs" })}>
        取消
      </Link>
    </Form>
  ) : (
    <Link
      to={`?revoke=${token.id}`}
      title="作废后，使用该令牌的抓取节点将立即无法连接"
      className={buttonVariants({
        variant: "outline",
        size: "xs",
        className: "text-destructive hover:text-destructive",
      })}
    >
      作废
    </Link>
  );
}
