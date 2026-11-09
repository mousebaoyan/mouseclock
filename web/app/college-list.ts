import { PER_PAGE } from "../server/platform/paging.ts";
import { anyOf, choices, tally } from "./facets.ts";
import { TIERS } from "./tiers.ts";

// 院校清单's search, filters, sorting and pages (design §10), read from the address. The whole
// list is small, so the page works them out from all of it, and gets only the schools it shows.

type School = {
  name: string;
  short_names: string[];
  tier: string | null;
  colleges: { name: string; region: string; directions: string[] }[];
};

export const SORTS = [
  { value: "", label: "按学校名称" },
  { value: "tier", label: "按院校层次" },
  { value: "region", label: "按所在地区" },
];

const collator = new Intl.Collator("zh-CN");

// A school's place among the tiers, highest first; schools with none come last.
function rank(school: Pick<School, "tier">) {
  const at = TIERS.findIndex((tier) => tier.value === school.tier);
  return at === -1 ? TIERS.length : at;
}

// Where a school's colleges are, in pinyin order: a campus or institute can be elsewhere.
export function regionsOf(school: Pick<School, "colleges">) {
  return choices(school.colleges.map((college) => college.region));
}

export function collegeView<S extends School>(schools: S[], params: URLSearchParams) {
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const tiers = params.getAll("tier");
  const regions = params.getAll("region");
  const directions = params.getAll("direction");
  const sort = SORTS.find((item) => item.value === params.get("sort"))?.value ?? "";
  const perPage = PER_PAGE.find((n) => String(n) === params.get("per_page")) ?? PER_PAGE[0];
  // The schools, each with its colleges, that every filter but `skip` lets through. The short
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
      (sort === "region" ? collator.compare(regionsOf(a)[0], regionsOf(b)[0]) : 0) ||
      collator.compare(a.name, b.name),
  );
  const pages = Math.max(1, Math.ceil(matched.length / perPage));
  const asked = Number(params.get("page"));
  const page = Math.min(Number.isInteger(asked) && asked > 0 ? asked : 1, pages);
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
