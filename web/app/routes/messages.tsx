import type { InferResponseType } from "hono/client";
import { useEffect } from "react";
import { data, Link, useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";
import { Empty, Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { Tag } from "~/components/tags";
import { DateTime } from "~/components/time";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { Route } from "./+types/messages.ts";

type Messages = InferResponseType<ReturnType<typeof createApi>["messages"]["$get"], 200>;

export function meta() {
  return [{ title: "消息 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const messages = await readApi<Messages>(
    await context.get(apiContext).messages.$get({
      query: {
        page: params.get("page") ?? undefined,
        per_page: params.get("per_page") ?? undefined,
      },
    }),
  );
  return { messages };
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const res = await context
    .get(apiContext)
    .messages.seen.$post({ json: { up_to: Number(formText(form, "up_to")) } });
  if (res.status !== 204) throw data((await res.json()).error.message, { status: res.status });
  return null;
}

// Marking them seen updates the bell, but this page keeps its 新 marks until it is opened again.
export function shouldRevalidate({
  formAction,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return formAction === "/messages" ? false : defaultShouldRevalidate;
}

// What the page shows counts as seen once it is open (design §11.1): up to its newest message, so
// those that come meanwhile stay unseen.
export default function MessageList({ loaderData }: Route.ComponentProps) {
  const { messages } = loaderData;
  const { submit } = useFetcher();
  const newest = messages.items.some((message) => !message.seen) ? messages.items[0].id : null;
  useEffect(() => {
    if (newest !== null) void submit({ up_to: newest }, { method: "post", action: "/messages" });
  }, [newest, submit]);
  return (
    <Page title="消息" hideTitle>
      {messages.items.length === 0 ? (
        <Empty>暂无消息</Empty>
      ) : (
        <Panel flush>
          <ol className="divide-y">
            {messages.items.map((message) => (
              <li key={message.id}>
                <Link
                  to={message.link}
                  className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-accent sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
                >
                  <p className="flex min-w-0 items-center gap-2 font-medium">
                    {!message.seen && <Tag color="red">新</Tag>}
                    <span className="min-w-0">{message.title}</span>
                  </p>
                  <p className="text-xs text-subtle-foreground sm:row-span-2 sm:text-right">
                    <DateTime value={message.created_at} />
                  </p>
                  <p className="text-[13px] text-muted-foreground">{message.body}</p>
                </Link>
              </li>
            ))}
          </ol>
          <div className="px-4 pb-4 empty:hidden sm:px-5">
            <Pagination total={messages.total} page={messages.page} perPage={messages.per_page} />
          </div>
        </Panel>
      )}
    </Page>
  );
}
