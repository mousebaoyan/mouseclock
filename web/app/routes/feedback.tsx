import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { FEEDBACK_STATUSES, FeedbackBody } from "~/components/feedback";
import { Page } from "~/components/page";
import { Tag } from "~/components/tags";
import { DateTime } from "~/components/time";
import { beijingYear } from "../../server/modules/programs/time.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { Route } from "./+types/feedback.ts";

type Feedback = InferResponseType<ReturnType<typeof createApi>["feedback"][":id"]["$get"], 200>;

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `反馈 #${loaderData.feedback.id} · 鼠钟` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const feedback = await readApi<Feedback>(
    await context.get(apiContext).feedback[":id"].$get({ param: { id: params.id } }),
  );
  return { feedback, thisYear: beijingYear(new Date()) };
}

// One feedback and how it ended, which an edit made from it links to (design §12.2).
export default function FeedbackPage({ loaderData }: Route.ComponentProps) {
  const { feedback: f, thisYear } = loaderData;
  return (
    <Page
      title={`${f.kind === "edit" ? "修改申请" : "反馈"} #${f.id}`}
      crumbs={[{ to: `/programs/${f.program.id}`, label: f.program.name }]}
      meta={
        <>
          <Link to={`/programs/${f.program.id}`} className="hover:text-primary">
            {f.program.school} {f.program.college}「{f.program.name}」
          </Link>
          <Tag color={FEEDBACK_STATUSES[f.status].color}>{FEEDBACK_STATUSES[f.status].label}</Tag>
        </>
      }
    >
      <div className="space-y-3 rounded-xl border bg-card px-4 py-3.5 shadow-card sm:px-5">
        <FeedbackBody feedback={f} thisYear={thisYear} />
        <p className="text-xs text-subtle-foreground">
          {f.user.display_name} 提于 <DateTime value={f.created_at} />
          {f.via === "agent" && "，通过 Agent"}
        </p>
        {f.review && (
          <p className="rounded-md bg-muted/70 px-3 py-2 text-[13px] wrap-anywhere">
            {f.review.by} 于 <DateTime value={f.review.at} /> 处理
            {f.review.note && <>：{f.review.note}</>}
          </p>
        )}
      </div>
    </Page>
  );
}
