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
import { Select } from "../components/ui/select.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import type { Route } from "./+types/admin-settings.ts";

type Api = ReturnType<typeof createApi>;
type Tokens = InferResponseType<Api["admin"]["crawler-tokens"]["$get"], 200>;
type Rules = InferResponseType<Api["admin"]["email-rules"]["$get"], 200>;
type Accounts = InferResponseType<Api["admin"]["mail-accounts"]["$get"], 200>;

const RULES = [
  { value: "default_on", label: "默认发" },
  { value: "default_off", label: "默认不发" },
  { value: "never", label: "不发" },
] as const;

export function meta() {
  return [{ title: "系统设置 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const admin = context.get(apiContext).admin;
  const [tokens, rules, accounts] = await Promise.all([
    admin["crawler-tokens"].$get().then((res) => readApi<Tokens>(res)),
    admin["email-rules"].$get().then((res) => readApi<Rules>(res)),
    admin["mail-accounts"].$get().then((res) => readApi<Accounts>(res)),
  ]);
  return {
    tokens,
    rules,
    accounts,
    revoking: Number(params.get("revoke")),
    saved: params.get("saved"),
  };
}

function isRule(value: string) {
  return RULES.find((rule) => rule.value === value)?.value;
}

// One row per mailbox in order, and a blank row last that adds one when filled in; a ticked 删除
// leaves one out. A saved mailbox's emptied address is sent as it is, for the API to turn down.
function accountsOf(form: FormData) {
  const field = (name: string) => form.getAll(name).map((v) => (typeof v === "string" ? v : ""));
  const [hosts, ports, usernames, passwords] = ["host", "port", "username", "password"].map(field);
  const removed = new Set(field("remove"));
  const blank = usernames.length - 1;
  return usernames.flatMap((username, i) =>
    removed.has(String(i)) || (i === blank && username.trim() === "")
      ? []
      : [
          {
            host: hosts[i],
            port: Number(ports[i]),
            username,
            password: passwords[i] === "" ? undefined : passwords[i],
          },
        ],
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext).admin["crawler-tokens"];
  const form = await request.formData();
  const intent = formText(form, "intent");
  if (intent === "create") {
    const name = formText(form, "name");
    const res = await api.$post({ json: { name } });
    if (res.status !== 201) {
      return data(
        { error: (await res.json()).error.message, name, at: "tokens" },
        { status: res.status },
      );
    }
    return { token: (await res.json()).token, name };
  }
  if (intent === "rules") {
    const admin = context.get(apiContext).admin;
    const rules = Object.fromEntries(
      [...form.entries()].flatMap(([key, value]) => {
        const rule = typeof value === "string" ? isRule(value) : undefined;
        return key.startsWith("rule:") && rule ? [[key.slice(5), rule]] : [];
      }),
    );
    const res = await admin["email-rules"].$put({ json: rules });
    if (res.status !== 204) {
      return data(
        { error: (await res.json()).error.message, name: "", at: "rules" },
        { status: res.status },
      );
    }
    return redirect("/admin/settings?saved=rules#email");
  }
  if (intent === "accounts") {
    const res = await context
      .get(apiContext)
      .admin["mail-accounts"].$put({ json: { accounts: accountsOf(form) } });
    if (res.status !== 204) {
      return data(
        { error: (await res.json()).error.message, name: "", at: "accounts" },
        { status: res.status },
      );
    }
    return redirect("/admin/settings?saved=accounts#mailboxes");
  }
  if (intent === "test") {
    const res = await context
      .get(apiContext)
      .admin["mail-accounts"].test.$post({ json: { qq: formText(form, "qq") } });
    if (res.status !== 200) {
      return data(
        { error: (await res.json()).error.message, name: "", at: "accounts" },
        { status: res.status },
      );
    }
    return { tested: await res.json(), name: "" };
  }
  if (intent === "revoke") {
    const res = await api[":id"].revoke.$post({ param: { id: formText(form, "id") } });
    if (res.status !== 204) {
      return data(
        { error: (await res.json()).error.message, name: "", at: "tokens" },
        { status: res.status },
      );
    }
    return redirect("/admin/settings?saved=1");
  }
  throw data("不支持的操作", { status: 400 });
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { tokens, rules, accounts, revoking, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  const made = actionData && "token" in actionData ? actionData : null;
  const failed = actionData && "error" in actionData ? actionData : null;
  // Each panel shows what went wrong with its own form.
  const errorAt = (at: string) => (failed?.at === at ? failed.error : undefined);
  const tested = actionData && "tested" in actionData ? actionData.tested : null;
  return (
    <Page title="系统设置" hideTitle>
      <Panel
        id="email"
        title="邮件规则"
        description="每类消息是否发邮件。成员没改过的按默认，改过的按自己的；设为「不发」的任何人都不发"
      >
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="rules" />
          <FormMessage error={errorAt("rules")} saved={saved === "rules" && "已保存"} />
          <ul className="space-y-3">
            {rules.map((rule) => (
              <li key={rule.kind} className="flex items-center justify-between gap-3">
                <span className="text-sm">{rule.label}</span>
                <Select
                  name={`rule:${rule.kind}`}
                  defaultValue={rule.rule}
                  options={RULES}
                  aria-label={`${rule.label}的邮件规则`}
                  className="w-32"
                />
              </li>
            ))}
          </ul>
          <Button disabled={busy}>保存规则</Button>
        </Form>
      </Panel>
      <Panel
        id="mailboxes"
        title="发信邮箱"
        description="按顺序使用，一个发不出去时换下一个。密码加密保存，不会再显示"
      >
        <div className="space-y-4">
          <FormMessage error={errorAt("accounts")} saved={saved === "accounts" && "已保存"} />
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="accounts" />
            {[...accounts, null].map((account, i) => (
              <div
                key={account?.username ?? "new"}
                className="grid gap-2 sm:grid-cols-[2fr_1fr_2fr_2fr_auto] sm:items-center"
              >
                <input
                  name="host"
                  defaultValue={account?.host ?? "smtp.qq.com"}
                  aria-label="SMTP 服务器"
                  placeholder="SMTP 服务器"
                  className="field"
                />
                <input
                  name="port"
                  type="number"
                  defaultValue={account?.port ?? 465}
                  aria-label="端口"
                  className="field"
                />
                <input
                  name="username"
                  defaultValue={account?.username}
                  required={account !== null}
                  aria-label="邮箱"
                  placeholder={account ? "邮箱" : "新增邮箱，例如 name@qq.com"}
                  className="field"
                />
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  aria-label="密码"
                  placeholder={account ? "已设置，留空不改" : "授权码"}
                  className="field"
                />
                {account ? (
                  <Checkbox name="remove" value={String(i)}>
                    删除
                  </Checkbox>
                ) : (
                  <span />
                )}
              </div>
            ))}
            <Button disabled={busy}>保存邮箱</Button>
          </Form>
          {accounts.length > 0 && (
            <Form method="post" className="flex flex-wrap items-start gap-2 border-t pt-4">
              <input type="hidden" name="intent" value="test" />
              <Field
                label="试发到"
                hint="填你自己的 QQ 号，每个邮箱各发一封"
                className="min-w-48 flex-1"
              >
                <input name="qq" required inputMode="numeric" className="field" />
              </Field>
              <Button variant="outline" disabled={busy} className="mt-6.5">
                试发
              </Button>
            </Form>
          )}
          {tested && (
            <ul className="space-y-1 text-[13px]">
              {tested.map((result) => (
                <li key={result.username}>
                  {result.username}：
                  {result.error === null ? (
                    <span className="text-success">已发出</span>
                  ) : (
                    <span className="text-destructive">{result.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
      <Panel
        title="抓取节点令牌"
        description="每个抓取节点使用一个令牌，更换机器或令牌泄露时请作废后重新生成"
      >
        <div className="space-y-4">
          <FormMessage error={errorAt("tokens")} saved={saved === "1" && !made && "已保存"} />
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
