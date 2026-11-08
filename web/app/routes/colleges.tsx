import type { InferResponseType } from "hono/client";
import { Link, useLocation } from "react-router";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Group, List, Row } from "~/components/list";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { SchoolLogo } from "~/components/school-logo";
import { Missing } from "~/components/program";
import { COLLEGE_KINDS, TierTag } from "~/components/tags";
import { TIER_FILTERS } from "~/tiers";
import { MultiSelect, Select } from "~/components/ui/select";
import { Table, Td, Tr } from "~/components/ui/table";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { collegeView, regionsOf, SORTS } from "../college-list.ts";
import type { Route } from "./+types/colleges.ts";

type CollegeList = InferResponseType<ReturnType<typeof createApi>["colleges"]["$get"], 200>;
// The short names are only for search, which the loader does; the page goes without them.
type School = Omit<CollegeList["schools"][number], "short_names">;

export function meta() {
  return [{ title: "院校清单 · 鼠钟" }, { name: "description", content: "鼠钟收录的学校与学院" }];
}

// The schools the address asks for (college-list.ts).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { schools } = await readApi<CollegeList>(await context.get(apiContext).colleges.$get());
  return collegeView(schools, new URL(request.url).searchParams);
}

export default function Colleges({ loaderData }: Route.ComponentProps) {
  const { schools, total, colleges, page, perPage, filters, counts, regions, directions } =
    loaderData;
  const { search } = useLocation();
  const { set } = useFilters();
  const active = filters.tiers.length + filters.regions.length + filters.directions.length > 0;
  const filtered = active || Boolean(filters.q);
  return (
    <Page title="院校清单" hideTitle>
      <FilterBar
        search={<SearchBox value={filters.q} placeholder="搜索学校或学院名称" />}
        selects={
          <>
            <MultiSelect
              aria-label="地区"
              all="全部地区"
              picked={filters.regions}
              onPickedChange={(values) => set("region", values)}
              options={regions.map((r) => ({ value: r, label: r, count: counts.region[r] ?? 0 }))}
              className="sm:w-36"
            />
            <MultiSelect
              aria-label="方向"
              all="全部方向"
              picked={filters.directions}
              onPickedChange={(values) => set("direction", values)}
              options={directions.map((d) => ({
                value: d,
                label: d,
                count: counts.direction[d] ?? 0,
              }))}
              className="sm:w-36"
            />
            <Select
              aria-label="排序"
              value={filters.sort}
              onValueChange={(value) => set("sort", value)}
              options={SORTS}
              className="sm:w-34"
            />
          </>
        }
        rows={[
          {
            label: "层次",
            content: (
              <ChipGroup
                name="tier"
                label="层次"
                picked={filters.tiers}
                choices={TIER_FILTERS}
                counts={counts.tier}
              />
            ),
          },
        ]}
        active={active}
        clear={filtered ? keepOnly(search, ["sort", "per_page"]) : null}
      />
      {schools.length === 0 ? (
        <Empty>{filtered ? "没有符合条件的院校" : "尚未收录院校"}</Empty>
      ) : (
        <div>
          <p className="mb-4 text-[13px] text-muted-foreground">
            共 {total} 所学校、{colleges} 个学院
          </p>
          <SchoolTable schools={schools} />
          <Schools schools={schools} />
          <Pagination total={total} page={page} perPage={perPage} />
        </div>
      )}
    </Page>
  );
}

function SchoolLabel({ school }: { school: School }) {
  return (
    <div className="flex items-center gap-3">
      <SchoolLogo school={school} size="md" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
          {school.name}
          <TierTag tier={school.tier} />
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{regionsOf(school).join("、")}</p>
      </div>
    </div>
  );
}

// Wide screens: each school once, with its tier, beside the rows of its colleges.
function SchoolTable({ schools }: { schools: School[] }) {
  return (
    <Table className="max-lg:hidden" head={["学校", "学院", "类型", "所在地", "招生方向"]}>
      {schools.map((school) =>
        school.colleges.map((college, i) => (
          <Tr key={college.id}>
            {i === 0 && (
              <Td rowSpan={school.colleges.length} className="border-r">
                <span className="inline-flex items-center gap-2.5 font-medium whitespace-nowrap">
                  <SchoolLogo school={school} size="sm" />
                  {school.name}
                  <TierTag tier={school.tier} />
                </span>
              </Td>
            )}
            <Td>
              <Link to={`/colleges/${college.id}`} className="hover:text-primary">
                {college.name}
              </Link>
            </Td>
            <Td nowrap>{COLLEGE_KINDS[college.kind] ?? college.kind}</Td>
            <Td nowrap>{college.region}</Td>
            <Td className="text-muted-foreground">
              {college.directions.join("、") || <Missing />}
            </Td>
          </Tr>
        )),
      )}
    </Table>
  );
}

// Phones: each school with its colleges beneath it.
function Schools({ schools }: { schools: School[] }) {
  return (
    <div className="space-y-6 lg:hidden">
      {schools.map((school) => (
        <Group key={school.id} label={<SchoolLabel school={school} />}>
          <List>
            {school.colleges.map((college) => (
              <Row
                key={college.id}
                title={
                  <Link
                    to={`/colleges/${college.id}`}
                    className="text-[15px] font-medium hover:text-primary"
                  >
                    {college.name}
                  </Link>
                }
                meta={
                  // Only what sets a college apart: most are colleges, in their school's one city.
                  (college.kind !== "college" ||
                    regionsOf(school).length > 1 ||
                    college.directions.length > 0) && (
                    <>
                      {college.kind !== "college" && (
                        <span>{COLLEGE_KINDS[college.kind] ?? college.kind}</span>
                      )}
                      {regionsOf(school).length > 1 && <span>{college.region}</span>}
                      {college.directions.length > 0 && (
                        <span>招生方向：{college.directions.join("、")}</span>
                      )}
                    </>
                  )
                }
              />
            ))}
          </List>
        </Group>
      ))}
    </div>
  );
}
