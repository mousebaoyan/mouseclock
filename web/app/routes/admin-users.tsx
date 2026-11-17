import type { InferResponseType } from "hono/client";
import { data, Form, redirect, useNavigation } from "react-router";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { FormMessage } from "../components/form.tsx";
import { List, Row } from "../components/list.tsx";
import { Page, Panel } from "../components/page.tsx";
import { DateTime } from "../components/time.tsx";
import { Button } from "../components/ui/button.tsx";
import { UserAvatar } from "../components/user-avatar.tsx";
import type { Route } from "./+types/admin-users.ts";

type Api = ReturnType<typeof createApi>;
type Users = InferResponseType<Api["admin"]["users"]["$get"], 200>;

export function meta() {
  return [{ title: "修改权限 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const users = await context
    .get(apiContext)
    .admin.users.$get()
    .then((res) => readApi<Users>(res));
  return { users, saved: new URL(request.url).searchParams.has("saved") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const res = await context
    .get(apiContext)
    .admin.users[":id"]["restore-edits"].$post({ param: { id: formText(form, "id") } });
  if (res.status !== 204) {
    return data({ error: (await res.json()).error.message }, { status: res.status });
  }
  return redirect("/admin/users?saved=1");
}

// Taken back with all of a person's edits, from the program page's record of edits (design §12.4);
// given back here.
export default function Users({ loaderData, actionData }: Route.ComponentProps) {
  const { users, saved } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <Page title="修改权限" hideTitle>
      <Panel
        title="已收回修改权限的用户"
        description="在项目页的修改记录中撤销某人的全部修改时，其修改权限一并收回。恢复后可重新修改，已撤销的修改不会恢复"
        flush
      >
        {(actionData?.error || saved) && (
          <div className="border-b px-4 py-3 sm:px-5">
            <FormMessage error={actionData?.error} saved={saved && "已恢复"} />
          </div>
        )}
        {users.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            没有被收回修改权限的用户
          </p>
        ) : (
          <List className="rounded-none border-0 shadow-none">
            {users.map((user) => (
              <Row
                key={user.id}
                title={
                  <span className="flex min-w-0 items-center gap-3">
                    <UserAvatar user={user} />
                    <span className="min-w-0">
                      <span className="block font-medium">{user.display_name}</span>
                      <span className="block text-[13px] text-muted-foreground">
                        收回于 <DateTime value={user.revoked_at} />
                      </span>
                    </span>
                  </span>
                }
                side={
                  <Form method="post">
                    <input type="hidden" name="id" value={user.id} />
                    <Button size="xs" variant="outline" disabled={busy}>
                      恢复修改权限
                    </Button>
                  </Form>
                }
              />
            ))}
          </List>
        )}
      </Panel>
    </Page>
  );
}
