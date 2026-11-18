import type { InferResponseType } from "hono/client";
import { data, Form, useNavigation } from "react-router";
import { Empty } from "~/components/page";
import { ProgramCard, ProgramCards, ProgramPlace } from "~/components/program";
import { Subscribe } from "~/components/subscribe";
import { Button } from "~/components/ui/button";
import { beijingYear } from "../../server/modules/programs/time.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { forgetTable } from "../table-cache.ts";
import { useNow } from "../time.ts";
import type { Route } from "./+types/me-subscriptions.ts";

type Subscriptions = InferResponseType<
  ReturnType<typeof createApi>["me"]["subscriptions"]["$get"],
  200
>;

export function meta() {
  return [{ title: "订阅 · 我的 · 鼠钟" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const subscriptions = await readApi<Subscriptions>(
    await context.get(apiContext).me.subscriptions.$get(),
  );
  return {
    ...subscriptions,
    thisYear: beijingYear(new Date()),
    now: Math.floor(Date.now() / 1000),
  };
}

// Unsubscribing from all the closed ones at once.
export async function action({ context }: Route.ActionArgs) {
  const res = await context.get(apiContext).me.subscriptions.closed.$delete();
  if (res.status !== 204) throw data((await res.json()).error.message, { status: res.status });
  return null;
}

// The counts on the table's cards change with it.
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  const result = await serverAction();
  forgetTable();
  return result;
}

// The open ones first, by deadline, then the closed ones (design §11.3).
export default function MeSubscriptions({ loaderData }: Route.ComponentProps) {
  const { programs, limit, thisYear } = loaderData;
  const now = useNow(loaderData.now);
  const closed = programs.filter((p) => p.closes_at <= now).length;
  const clearing = useNavigation().formMethod === "DELETE";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          已订阅 {programs.length} 个，最多 {limit} 个
        </p>
        {closed > 0 && (
          <Form method="delete">
            <Button type="submit" variant="outline" size="sm" disabled={clearing}>
              取消全部已截止的（{closed} 个）
            </Button>
          </Form>
        )}
      </div>
      {programs.length === 0 ? (
        <Empty>暂无订阅</Empty>
      ) : (
        <ProgramCards>
          {programs.map((program) => (
            <ProgramCard
              key={program.id}
              program={program}
              now={now}
              thisYear={thisYear}
              notice={program.notice.url}
              place={<ProgramPlace program={program} thisYear={thisYear} />}
              subscribe={<Subscribe program={program} subscribed />}
            />
          ))}
        </ProgramCards>
      )}
    </div>
  );
}
