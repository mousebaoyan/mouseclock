import type { InferResponseType } from "hono/client";
import { Form, Link, useNavigation } from "react-router";
import { FEEDBACK_STATUSES, FeedbackBody } from "~/components/feedback";
import { Empty } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { Tag } from "~/components/tags";
import { DateTime } from "~/components/time";
import { Button } from "~/components/ui/button";
import { beijingYear } from "../../server/modules/programs/time.ts";
import { formText } from "../admin.server.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { Route } from "./+types/me-feedback.ts";

type Page = InferResponseType<ReturnType<typeof createApi>["me"]["feedback"]["$get"], 200>;

export function meta() {
  return [{ title: "反馈 · 我的 · 鼠钟" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const query = {
    page: params.get("page") ?? undefined,
    per_page: params.get("per_page") ?? undefined,
  };
  const page = await readApi<Page>(await context.get(apiContext).me.feedback.$get({ query }));
  return { ...page, thisYear: beijingYear(new Date()) };
}

// Withdrawing one still waiting.
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const id = formText(form, "feedback_id");
  const res = await context.get(apiContext).feedback[":id"].$delete({ param: { id } });
  if (res.status === 204) return null;
  return { error: (await res.json()).error.message };
}

// All one's feedback and how each ended, the latest first (design §12.1).
export default function MeFeedback({ loaderData, actionData }: Route.ComponentProps) {
  const { items, total, page, per_page, thisYear } = loaderData;
  const busy = useNavigation().state !== "idle";
  if (total === 0) return <Empty>还没有提过反馈，在项目页上点「反馈」</Empty>;
  return (
    <div className="space-y-4">
      {actionData?.error && (
        <p role="alert" className="text-[13px] text-destructive">
          {actionData.error}
        </p>
      )}
      <ul className="space-y-3">
        {items.map((f) => (
          <li
            key={f.id}
            className="space-y-2 rounded-xl border bg-card px-4 py-3.5 shadow-card sm:px-5"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                to={`/programs/${f.program.id}`}
                className="min-w-0 text-[15px] font-semibold text-pretty hover:text-primary"
              >
                {f.program.school} {f.program.college}「{f.program.name}」
              </Link>
              <Tag color={FEEDBACK_STATUSES[f.status].color}>
                {FEEDBACK_STATUSES[f.status].label}
              </Tag>
            </div>
            <FeedbackBody feedback={f} thisYear={thisYear} />
            {f.review && (
              <p className="rounded-md bg-muted/70 px-3 py-2 text-[13px] wrap-anywhere">
                {f.review.by} 于 <DateTime value={f.review.at} /> 处理
                {f.review.note && <>：{f.review.note}</>}
              </p>
            )}
            <div className="flex items-center gap-2 text-xs text-subtle-foreground">
              提于 <DateTime value={f.created_at} />
              {f.status === "pending" && (
                <Form method="post" className="ml-auto">
                  <input type="hidden" name="feedback_id" value={f.id} />
                  <Button variant="ghost" size="xs" disabled={busy}>
                    撤回
                  </Button>
                </Form>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Pagination total={total} page={page} perPage={per_page} />
    </div>
  );
}
