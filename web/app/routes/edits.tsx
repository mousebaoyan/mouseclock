import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { Empty, Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { DateTime } from "~/components/time";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { fieldLabel, formatValue } from "../fields.ts";
import { beijingYear } from "../../server/modules/programs/time.ts";
import type { Route } from "./+types/edits.ts";

type Edits = InferResponseType<ReturnType<typeof createApi>["edits"]["$get"], 200>;

export function meta() {
  return [{ title: "修改记录 · 鼠钟" }];
}

// Everyone signed in sees every edit across the site (design §12.4), not only reviewers.
export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const edits = await readApi<Edits>(
    await context.get(apiContext).edits.$get({
      query: {
        page: params.get("page") ?? undefined,
        per_page: params.get("per_page") ?? undefined,
      },
    }),
  );
  return { edits, thisYear: beijingYear(new Date()) };
}

export default function RecentEdits({ loaderData }: Route.ComponentProps) {
  const { edits, thisYear } = loaderData;
  return (
    <Page title="修改记录" hideTitle>
      {edits.items.length === 0 ? (
        <Empty>暂无修改记录</Empty>
      ) : (
        <Panel flush>
          <ol className="divide-y">
            {edits.items.map((edit) => (
              <li
                key={edit.id}
                className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
              >
                <p className="min-w-0">
                  <span className="font-medium">{edit.user.display_name}</span>
                  <span className="text-muted-foreground">
                    {edit.reverts_id === null ? " 修改了 " : ` 撤销了 #${edit.reverts_id}，涉及 `}
                  </span>
                  <Link to={`/programs/${edit.program.id}#edits`} className="link">
                    {edit.program.school} {edit.program.college} {edit.program.name}
                  </Link>
                  <span className="text-muted-foreground"> 的{fieldLabel(edit.field)}</span>
                </p>
                <p className="text-xs text-subtle-foreground sm:row-span-2 sm:text-right">
                  #{edit.id}　<DateTime value={edit.created_at} />
                </p>
                <p className="text-[13px]">
                  <span className="text-muted-foreground line-through decoration-1">
                    {formatValue(edit.field, edit.old_value, thisYear)}
                  </span>
                  <span className="mx-1.5 text-subtle-foreground">→</span>
                  {formatValue(edit.field, edit.new_value, thisYear)}
                  {edit.reason !== null && (
                    <span className="ml-3 text-muted-foreground">理由：{edit.reason}</span>
                  )}
                </p>
              </li>
            ))}
          </ol>
          <div className="px-4 pb-4 empty:hidden sm:px-5">
            <Pagination total={edits.total} page={edits.page} perPage={edits.per_page} />
          </div>
        </Panel>
      )}
    </Page>
  );
}
