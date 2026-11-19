import type { InferResponseType } from "hono/client";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { Field, FormMessage } from "../components/form.tsx";
import { List, Row } from "../components/list.tsx";
import { Panel } from "../components/page.tsx";
import { Tag } from "../components/tags.tsx";
import { DateTime } from "../components/time.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { Downloads } from "../components/downloads.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { currentCohort } from "../time.ts";
import { SCOPES } from "../../server/platform/access.ts";
import type { Route } from "./+types/me-agent.ts";

type Api = ReturnType<typeof createApi>;
type Tokens = InferResponseType<Api["me"]["tokens"]["$get"], 200>;
type Token = Tokens["tokens"][number];

const SCOPE_LABELS = {
  read: { label: "只读", hint: "查项目，看自己的订阅、报名和消息", color: "gray" },
  personal: {
    label: "只读和个人操作",
    hint: "还能替你订阅、关注、记报名，提反馈和修改申请",
    color: "blue",
  },
} as const;

export function meta() {
  return [{ title: "Agent · 我的 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const tokens = await readApi<Tokens>(await context.get(apiContext).me.tokens.$get());
  const url = new URL(request.url);
  return {
    ...tokens,
    revoking: Number(url.searchParams.get("revoke")),
    origin: url.origin,
    cohort: currentCohort(new Date()),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext).me.tokens;
  const form = await request.formData();
  if (formText(form, "intent") === "revoke") {
    const res = await api[":id"].$delete({ param: { id: formText(form, "id") } });
    if (res.status !== 204) {
      return data({ error: (await res.json()).error.message, name: "" }, res.status);
    }
    return redirect("/me/agent");
  }
  const name = formText(form, "name");
  const scope = SCOPES.find((s) => s === formText(form, "scope"));
  if (!scope) throw data("不支持的操作", { status: 400 });
  const res = await api.$post({ json: { name, scope } });
  if (res.status !== 201) {
    return data({ error: (await res.json()).error.message, name }, res.status);
  }
  return { token: (await res.json()).token, name };
}

// Personal tokens for one's own Agent, and downloading a cohort (design §13).
export default function Agent({ loaderData, actionData }: Route.ComponentProps) {
  const { tokens, limit, unused_days, revoking, origin, cohort } = loaderData;
  const busy = useNavigation().state !== "idle";
  const made = actionData && "token" in actionData ? actionData : null;
  const say =
    made &&
    `请先读 ${origin}/llms.txt 了解鼠钟。调用它的接口时带上请求头 Authorization: Bearer ${made.token}`;
  return (
    <div className="space-y-5">
      <Panel
        title="个人令牌"
        description="让自己的 Agent（Codex、Claude Code 等）替你查项目、订阅和记报名。令牌代表你本人，不要发给别人"
      >
        <div className="space-y-4">
          <FormMessage error={actionData && "error" in actionData ? actionData.error : undefined} />
          {made && say && (
            <div className="space-y-2 rounded-md border border-success/25 bg-success/5 p-3 text-[13px]">
              <p className="text-success">
                已生成「{made.name}」的令牌。令牌只显示这一次，请马上复制
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={made.token}
                  aria-label="新令牌"
                  onFocus={(event) => event.currentTarget.select()}
                  className="field min-w-0 flex-1 font-mono text-xs"
                />
                <CopyButton text={made.token} />
              </div>
              <p className="text-muted-foreground">把下面这段话发给你的 Agent：</p>
              <div className="flex items-start gap-2">
                <textarea
                  readOnly
                  rows={3}
                  value={say}
                  aria-label="发给 Agent 的话"
                  onFocus={(event) => event.currentTarget.select()}
                  className="field h-auto min-w-0 flex-1 resize-none py-2 font-mono text-xs"
                />
                <CopyButton text={say} />
              </div>
            </div>
          )}
          {/* A new key once a token is made, so the name typed for it is cleared. */}
          <Form key={made?.token} method="post" className="space-y-3">
            <Field label="名字" hint="给哪个 Agent 用，例如「我的 Codex」">
              <input
                name="name"
                required
                maxLength={50}
                defaultValue={made ? "" : actionData?.name}
                className="field"
              />
            </Field>
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-[13px] font-medium">能做什么</legend>
              {SCOPES.map((scope) => (
                <label key={scope} className="flex items-baseline gap-2 text-[13px]">
                  <input
                    type="radio"
                    name="scope"
                    value={scope}
                    defaultChecked={scope === "read"}
                    className="accent-primary"
                  />
                  <span>
                    {SCOPE_LABELS[scope].label}
                    <span className="ml-2 text-muted-foreground">{SCOPE_LABELS[scope].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Button disabled={busy}>生成令牌</Button>
          </Form>
          <p className="text-[13px] text-muted-foreground">
            直接修改、审核和管理只能你本人在网页上做。每人最多 {limit} 个令牌，{unused_days}{" "}
            天没用过的自动失效
          </p>
        </div>
      </Panel>
      <Panel title="我的令牌" flush>
        {tokens.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">还没有令牌</p>
        ) : (
          <List className="rounded-none border-0 shadow-none">
            {tokens.map((token) => (
              <Row
                key={token.id}
                title={
                  <>
                    <span className="font-medium">{token.name}</span>
                    <Tag color={SCOPE_LABELS[token.scope].color}>
                      {SCOPE_LABELS[token.scope].label}
                    </Tag>
                  </>
                }
                meta={
                  <>
                    <span>
                      生成于 <DateTime value={token.created_at} />
                    </span>
                    <span>
                      {token.last_used_at === null ? (
                        "还没用过"
                      ) : (
                        <>
                          最近使用 <DateTime value={token.last_used_at} />
                        </>
                      )}
                    </span>
                  </>
                }
                side={<Revoke token={token} revoking={revoking} busy={busy} />}
              />
            ))}
          </List>
        )}
      </Panel>
      <Panel
        title="下载项目"
        description="一届的全部项目，Agent 也可以用令牌调接口下载；别的届在总表底部下载"
      >
        <Downloads cohort={cohort} />
      </Panel>
    </div>
  );
}

// 作废 asks again on the same row before it revokes.
function Revoke({ token, revoking, busy }: { token: Token; revoking: number; busy: boolean }) {
  return revoking === token.id ? (
    <Form method="post" className="inline-flex items-center gap-1.5">
      <input type="hidden" name="intent" value="revoke" />
      <input type="hidden" name="id" value={token.id} />
      <Button size="xs" variant="destructive" disabled={busy}>
        确认作废
      </Button>
      <Link to="/me/agent" className={buttonVariants({ variant: "outline", size: "xs" })}>
        取消
      </Link>
    </Form>
  ) : (
    <Link
      to={`?revoke=${token.id}`}
      title="作废后，用这个令牌的 Agent 马上就不能用了"
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
