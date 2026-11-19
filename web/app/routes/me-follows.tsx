import type { InferResponseType } from "hono/client";
import { Link } from "react-router";
import { Follow } from "~/components/follow";
import { Group, List, Row } from "~/components/list";
import { Empty } from "~/components/page";
import { SchoolLogo } from "~/components/school-logo";
import { REQUEST_STATUSES, Tag } from "~/components/tags";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { currentCohort } from "../time.ts";
import type { Route } from "./+types/me-follows.ts";

type Follows = InferResponseType<ReturnType<typeof createApi>["me"]["follows"]["$get"], 200>;

export function meta() {
  return [{ title: "关注 · 我的 · 鼠钟" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const cohort = currentCohort(new Date());
  const { follows } = await readApi<Follows>(
    await context.get(apiContext).me.follows.$get({ query: { cohort: String(cohort) } }),
  );
  // In pinyin order, as 院校清单 has them.
  const schools = [...Map.groupBy(follows, (f) => f.school.id).values()].sort((a, b) =>
    collator.compare(a[0].school.name, b[0].school.name),
  );
  return { schools, cohort };
}

const collator = new Intl.Collator("zh-CN");

// The colleges one follows by school (design §11.4): this cohort's programs and the latest
// notice of each, which a graduate school's source can bring for one not crawled itself, and for
// such a one how its ask is going.
export default function MeFollows({ loaderData }: Route.ComponentProps) {
  const { schools, cohort } = loaderData;
  if (schools.length === 0) {
    return <Empty>还没有关注的学院，在学院页或院校清单里点「关注」</Empty>;
  }
  return (
    <div className="space-y-6">
      {schools.map((follows) => {
        const { school } = follows[0];
        return (
          <Group
            key={school.id}
            label={
              <span className="flex items-center gap-2.5 font-medium">
                <SchoolLogo school={school} size="sm" />
                {school.name}
              </span>
            }
          >
            <List>
              {follows.map(({ college, programs, latest_notice, crawled, request }) => (
                <Row
                  key={college.id}
                  title={
                    <>
                      <Link
                        to={`/colleges/${college.id}`}
                        className="text-[15px] font-medium hover:text-primary"
                      >
                        {college.name}
                      </Link>
                      {!crawled && <Tag color="gray">未收录</Tag>}
                    </>
                  }
                  meta={
                    <>
                      <span>
                        {cohort} 届 {programs} 个项目
                      </span>
                      <span>{latest_notice ? `最近一条通知 ${latest_notice}` : "还没有通知"}</span>
                      {request && (
                        <Link
                          to={`/requests?status=${request.status}`}
                          className="hover:text-primary"
                        >
                          求收录{REQUEST_STATUSES[request.status]}
                        </Link>
                      )}
                    </>
                  }
                  side={<Follow college={college.id} following />}
                />
              ))}
            </List>
          </Group>
        );
      })}
    </div>
  );
}
