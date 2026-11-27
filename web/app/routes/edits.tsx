import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { Empty, Page, Panel } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { EditSummary } from "~/components/program-edit";
import { apiContext, readApi, type createApi } from "../api.server.ts";
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
              <li key={edit.id} className="px-4 py-4 text-sm sm:px-5">
                <p className="mb-2 text-pretty">
                  <Link to={`/programs/${edit.program.id}#edits`} className="hover:text-primary">
                    <span className="text-muted-foreground">
                      {edit.program.school} {edit.program.college}
                    </span>
                    <span className="ml-2 font-medium">{edit.program.name}</span>
                  </Link>
                </p>
                <EditSummary edit={edit} thisYear={thisYear} />
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
