import type { InferResponseType } from "hono/client";
import { Link, useLocation } from "react-router";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Group, List, Row } from "~/components/list";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { COLLEGE_KINDS, TierTags } from "~/components/tags";
import { TIER_FILTERS, TIERS, topTier } from "~/tiers";
import { Select } from "~/components/ui/select";
import { PER_PAGE } from "../../server/platform/paging.ts";
import { apiContext, readApi, type createApi } from "../api.server.ts";
import type { Route } from "./+types/colleges.ts";

type CollegeList = InferResponseType<ReturnType<typeof createApi>["colleges"]["$get"], 200>;
type School = CollegeList["schools"][number];

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
  const at = TIERS.findIndex((tier) => school.tiers.includes(tier.value));
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
  const region = params.get("region") ?? "";
  const sort = SORTS.find((item) => item.value === params.get("sort"))?.value ?? "";
  const perPage = PER_PAGE.find((n) => String(n) === params.get("per_page")) ?? PER_PAGE[0];
  const matched = schools
    .map((school) => {
      const named = [school.name, school.short_name].some((text) => text.toLowerCase().includes(q));
      // A search for a school keeps all its colleges; one for a college keeps those it names.
      const colleges = school.colleges.filter(
        (college) =>
          (!region || college.region === region) &&
          (named || college.name.toLowerCase().includes(q)),
      );
      return { ...school, colleges };
    })
    .filter(
      (school) =>
        school.colleges.length > 0 && (tiers.length === 0 || tiers.includes(topTier(school.tiers))),
    );
  matched.sort(
    (a, b) =>
      (sort === "tier" ? rank(a) - rank(b) : 0) ||
      (sort === "region" ? collator.compare(regionOf(a), regionOf(b)) : 0) ||
      collator.compare(a.name, b.name),
  );
  const pages = Math.max(1, Math.ceil(matched.length / perPage));
  const page = Math.min(Math.max(1, Number(params.get("page")) || 1), pages);
  return {
    schools: matched.slice((page - 1) * perPage, page * perPage),
    total: matched.length,
    colleges: matched.reduce((sum, school) => sum + school.colleges.length, 0),
    page,
    perPage,
    filters: { q: params.get("q") ?? "", tiers, region, sort },
    regions: [...new Set(schools.flatMap((s) => s.colleges.map((c) => c.region)))].sort(
      collator.compare,
    ),
  };
}

export default function Colleges({ loaderData }: Route.ComponentProps) {
  const { schools, total, colleges, page, perPage, filters, regions } = loaderData;
  const { search } = useLocation();
  const { set } = useFilters();
  const active = filters.tiers.length > 0 || Boolean(filters.region);
  const filtered = active || Boolean(filters.q);
  return (
    <Page title="院校清单" hideTitle>
      <FilterBar
        search={<SearchBox value={filters.q} placeholder="搜索学校或学院名称" />}
        selects={
          <>
            <Select
              aria-label="地区"
              value={filters.region}
              onValueChange={(value) => set("region", value)}
              options={[
                { value: "", label: "全部地区" },
                ...regions.map((r) => ({ value: r, label: r })),
              ]}
              className="sm:w-32"
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
              <ChipGroup name="tier" label="层次" picked={filters.tiers} choices={TIER_FILTERS} />
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
      {school.tiers.length > 0 && (
        <p className="flex flex-wrap gap-1 lg:mt-2">
          <TierTags tiers={school.tiers} />
        </p>
      )}
    </div>
  );
}

// Each school with its colleges beside it.
function Schools({ schools }: { schools: School[] }) {
  return (
    <div className="space-y-6">
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
