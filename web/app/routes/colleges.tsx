import type { InferResponseType } from "hono/client";
import { Link, useLocation } from "react-router";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Group, List, Row } from "~/components/list";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { Missing } from "~/components/program";
import { COLLEGE_KINDS, TierTag } from "~/components/tags";
import { TIER_FILTERS, TIERS } from "~/tiers";
import { MultiSelect, Select } from "~/components/ui/select";
import { Table, Td, Tr } from "~/components/ui/table";
import { PER_PAGE } from "../../server/platform/paging.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import { anyOf, choices, tally } from "../facets.ts";
import type { Route } from "./+types/colleges.ts";

type CollegeList = InferResponseType<ReturnType<typeof createApi>["colleges"]["$get"], 200>;
// The short names are only for search, which the loader does; the page goes without them.
type School = Omit<CollegeList["schools"][number], "short_names">;

export function meta() {
  return [{ title: "院校清单 · 鼠钟" }, { name: "description", content: "鼠钟收录的学校与学院" }];
}

const SORTS = [
  { value: "", label: "按学校名称" },
  { value: "tier", label: "按院校层次" },
  { value: "region", label: "按所在地区" },
];

const collator = new Intl.Collator("zh-CN");

// A school's place among the tiers, highest first; schools with none come last.
function rank(school: School) {
  const at = TIERS.findIndex((tier) => tier.value === school.tier);
  return at === -1 ? TIERS.length : at;
}

// Colleges of a school are almost always in its city.
function regionOf(school: School) {
  return school.colleges[0].region;
}

// The schools the address asks for, filtered and sorted here: the whole list is small, and the
// page only gets the schools it shows.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { schools } = await readApi<CollegeList>(await context.get(apiContext).colleges.$get());
  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const tiers = params.getAll("tier");
  const regions = params.getAll("region");
  const directions = params.getAll("direction");
  const sort = SORTS.find((item) => item.value === params.get("sort"))?.value ?? "";
  const perPage = PER_PAGE.find((n) => String(n) === params.get("per_page")) ?? PER_PAGE[0];
  // The schools, each with the colleges, that every filter but `skip` lets through. The short
  // names are only for search, and stay here.
  const narrowed = (skip?: "tier" | "region" | "direction") =>
    schools
      .filter((school) => skip === "tier" || anyOf(tiers, [school.tier ?? "other"]))
      .map(({ short_names, ...school }) => {
        const named = [school.name, ...short_names].some((text) => text.toLowerCase().includes(q));
        // A search for a school keeps all its colleges; one for a college keeps those it names.
        const colleges = school.colleges.filter(
          (college) =>
            (skip === "region" || anyOf(regions, [college.region])) &&
            (skip === "direction" || anyOf(directions, college.directions)) &&
            (named || college.name.toLowerCase().includes(q)),
        );
        return { ...school, colleges };
      })
      .filter((school) => school.colleges.length > 0);
  const matched = narrowed();
  matched.sort(
    (a, b) =>
      (sort === "tier" ? rank(a) - rank(b) : 0) ||
      (sort === "region" ? collator.compare(regionOf(a), regionOf(b)) : 0) ||
      collator.compare(a.name, b.name),
  );
  const pages = Math.max(1, Math.ceil(matched.length / perPage));
  const page = Math.min(Math.max(1, Number(params.get("page")) || 1), pages);
  const all = schools.flatMap((school) => school.colleges);
  return {
    schools: matched.slice((page - 1) * perPage, page * perPage),
    total: matched.length,
    colleges: matched.reduce((sum, school) => sum + school.colleges.length, 0),
    page,
    perPage,
    filters: { q: params.get("q") ?? "", tiers, regions, directions, sort },
    // A tier counts schools, a region or direction colleges: what each belongs to.
    counts: {
      tier: tally(narrowed("tier").map((school) => school.tier ?? "other")),
      region: tally(narrowed("region").flatMap((school) => school.colleges.map((c) => c.region))),
      direction: tally(
        narrowed("direction").flatMap((school) => school.colleges.flatMap((c) => c.directions)),
      ),
    },
    regions: choices(all.map((college) => college.region)),
    directions: choices(all.flatMap((college) => college.directions)),
  };
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
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 lg:block">
      <p className="text-base font-semibold">{school.name}</p>
      <p className="text-[13px] text-muted-foreground lg:mt-0.5">{regionOf(school)}</p>
      {school.tier && (
        <p className="lg:mt-2">
          <TierTag tier={school.tier} />
        </p>
      )}
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
                <span className="inline-flex items-center gap-2 font-medium whitespace-nowrap">
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
                  // Only what sets a college apart: most are colleges, in their school's city.
                  (college.kind !== "college" ||
                    college.region !== regionOf(school) ||
                    college.directions.length > 0) && (
                    <>
                      {college.kind !== "college" && (
                        <span>{COLLEGE_KINDS[college.kind] ?? college.kind}</span>
                      )}
                      {college.region !== regionOf(school) && <span>{college.region}</span>}
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
