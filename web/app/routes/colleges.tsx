import type { InferResponseType } from "hono/client";
import { Link, useLocation } from "react-router";
import { ChipGroup, FilterBar, keepOnly, SearchBox, useFilters } from "~/components/filters";
import { Empty, Page } from "~/components/page";
import { Pagination } from "~/components/pagination";
import { COLLEGE_KINDS, TIER_FILTERS, TIERS, TierTags } from "~/components/tags";
import { Select } from "~/components/ui/select";
import { Table, Td, Th, Tr } from "~/components/ui/table";
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
        school.colleges.length > 0 &&
        (tiers.length === 0 ||
          tiers.some((tier) =>
            tier === "other" ? school.tiers.length === 0 : school.tiers.includes(tier),
          )),
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
  const filtered = filters.q || filters.tiers.length > 0 || filters.region;
  return (
    <Page
      title="院校清单"
      description="鼠钟收录的学校与学院。进入学院页面可查看其通知栏目与历年项目。"
    >
      <FilterBar
        top={
          <>
            <SearchBox value={filters.q} placeholder="搜索学校或学院名称" />
            <div className="grid flex-[1_1_100%] grid-cols-2 gap-2 sm:flex sm:flex-none">
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
            </div>
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
        clear={filtered ? keepOnly(search, ["sort", "per_page"]) : null}
      />
      {schools.length === 0 ? (
        <Empty>{filtered ? "没有符合条件的院校，请调整筛选条件。" : "尚未收录院校。"}</Empty>
      ) : (
        <div>
          <p className="mb-2 text-[13px] text-muted-foreground">
            共 {total} 所学校、{colleges} 个学院
          </p>
          <SchoolTable schools={schools} />
          <SchoolCards schools={schools} />
          <Pagination total={total} page={page} perPage={perPage} />
        </div>
      )}
    </Page>
  );
}

function SchoolName({ school }: { school: School }) {
  return (
    <>
      <span className="font-medium">{school.name}</span>
      {school.short_name && school.short_name !== school.name && (
        <span className="ml-2 text-[13px] text-muted-foreground">{school.short_name}</span>
      )}
    </>
  );
}

function Directions({ directions }: { directions: string[] }) {
  return directions.length > 0 ? (
    directions.join("、")
  ) : (
    <span className="text-subtle-foreground">未注明</span>
  );
}

// One row per college; a school's name and tiers span the rows of its colleges.
function SchoolTable({ schools }: { schools: School[] }) {
  return (
    <div className="max-md:hidden">
      <Table>
        <thead>
          <tr>
            <Th className="w-px">学校</Th>
            <Th>学院</Th>
            <Th className="w-px">单位类型</Th>
            <Th className="w-px">地区</Th>
            <Th>招生方向</Th>
          </tr>
        </thead>
        {schools.map((school) => (
          <tbody key={school.id} className="border-b last:border-b-0 hover:bg-muted/40">
            {school.colleges.map((college, i) => (
              <Tr key={college.id} className="hover:bg-transparent">
                {i === 0 && (
                  <Td rowSpan={school.colleges.length} className="border-r whitespace-nowrap">
                    <SchoolName school={school} />
                    {school.tiers.length > 0 && (
                      <span className="mt-1.5 flex gap-1">
                        <TierTags tiers={school.tiers} />
                      </span>
                    )}
                  </Td>
                )}
                <Td>
                  <Link to={`/colleges/${college.id}`} className="link">
                    {college.name}
                  </Link>
                </Td>
                <Td center className="whitespace-nowrap text-muted-foreground">
                  {COLLEGE_KINDS[college.kind] ?? college.kind}
                </Td>
                <Td center className="whitespace-nowrap">
                  {college.region}
                </Td>
                <Td className="text-muted-foreground">
                  <Directions directions={college.directions} />
                </Td>
              </Tr>
            ))}
          </tbody>
        ))}
      </Table>
    </div>
  );
}

function SchoolCards({ schools }: { schools: School[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {schools.map((school) => (
        <li key={school.id} className="overflow-hidden rounded-xl border bg-card shadow-card">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-3">
            <SchoolName school={school} />
            <span className="flex flex-wrap gap-1">
              <TierTags tiers={school.tiers} />
            </span>
          </div>
          <ul className="divide-y">
            {school.colleges.map((college) => (
              <li key={college.id}>
                <Link
                  to={`/colleges/${college.id}`}
                  className="block px-4 py-2.5 hover:bg-muted/40"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-primary">{college.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {COLLEGE_KINDS[college.kind] ?? college.kind}　{college.region}
                    </span>
                  </span>
                  {college.directions.length > 0 && (
                    <span className="mt-0.5 block text-[13px] text-muted-foreground">
                      {college.directions.join("、")}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
