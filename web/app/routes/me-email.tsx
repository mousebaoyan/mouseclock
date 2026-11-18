import type { InferResponseType } from "hono/client";
import { data, Form, redirect, useNavigation } from "react-router";
import { FormMessage } from "~/components/form";
import { Panel } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { Route } from "./+types/me-email.ts";

type Api = ReturnType<typeof createApi>;
type Settings = InferResponseType<Api["me"]["email-settings"]["$get"], 200>;

export function meta() {
  return [{ title: "邮件提醒 · 我的 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const settings = await readApi<Settings>(
    await context.get(apiContext).me["email-settings"].$get(),
  );
  return { settings, saved: new URL(request.url).searchParams.has("saved") };
}

// Only the switches changed here are sent, so those become the member's own; the rest keep
// following the owner's default (design §11.2).
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const on = new Set(form.getAll("on"));
  const was = new Set(form.getAll("was"));
  const changed = form
    .getAll("kind")
    .filter((kind) => typeof kind === "string")
    .filter((kind) => on.has(kind) !== was.has(kind));
  const res = await context.get(apiContext).me["email-settings"].$patch({
    json: Object.fromEntries(changed.map((kind) => [kind, on.has(kind)])),
  });
  if (res.status !== 200) return data({ error: (await res.json()).error.message }, res.status);
  return redirect("/me/email?saved=1");
}

export default function EmailSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <Panel
      title="邮件提醒"
      description="消息都会出现在站内的消息页；勾选的几类同时发到你的 QQ 邮箱"
    >
      <Form method="post" className="space-y-4">
        <FormMessage error={actionData?.error} saved={saved && "已保存"} />
        {!settings.receives && (
          <p className="text-[13px] text-muted-foreground">
            你的账号没有绑定 QQ 号，收不到邮件，消息仍会出现在站内
          </p>
        )}
        {settings.kinds.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">目前没有会发邮件的消息</p>
        ) : (
          <ul className="space-y-3">
            {settings.kinds.map((kind) => (
              <li key={kind.kind} className="flex items-center justify-between gap-3">
                <input type="hidden" name="kind" value={kind.kind} />
                {kind.enabled && <input type="hidden" name="was" value={kind.kind} />}
                <Checkbox name="on" value={kind.kind} defaultChecked={kind.enabled}>
                  {kind.label}
                </Checkbox>
                <span className="text-xs text-subtle-foreground">
                  默认{kind.default_enabled ? "发送" : "不发送"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {settings.kinds.length > 0 && <Button disabled={busy}>保存</Button>}
      </Form>
    </Panel>
  );
}
