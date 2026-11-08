import { expect, test } from "vitest";
import { readFilters, tableView } from "./program-table.ts";

const NOW = 1000;

function program(
  id: number,
  values: {
    deadline?: number | null;
    start?: number | null;
    kind?: "summer_camp" | "pre_recommendation";
    tier?: string;
    region?: string;
    directions?: string[];
    school?: string;
    short?: string[];
    published?: string | null;
  } = {},
) {
  return {
    id,
    school: {
      name: values.school ?? "北辰大学",
      short_names: values.short ?? ["北辰"],
      tier: values.tier ?? null,
    },
    college: {
      name: "计算机学院",
      region: values.region ?? "北京",
      directions: values.directions ?? [],
    },
    kind: values.kind ?? "summer_camp",
    name: `项目${id}`,
    apply_start: values.start ?? null,
    apply_deadline: values.deadline === undefined ? 2000 : values.deadline,
    notice: { published_on: values.published ?? null },
  };
}

function ids(params: string, programs: ReturnType<typeof program>[]) {
  return tableView(programs, readFilters(new URLSearchParams(params)), NOW).programs.map(
    (p) => p.id,
  );
}

test("by default the table leaves out what has closed, and keeps what gave no times", () => {
  const programs = [
    program(1, { deadline: 500 }),
    program(2, { start: 1500 }),
    program(3),
    program(4, { deadline: null }),
  ];
  expect(ids("", programs)).toEqual([2, 3, 4]);
  expect(ids("status=closed", programs)).toEqual([1]);
  expect(ids("status=upcoming", programs)).toEqual([2]);
  expect(ids("status=open", programs)).toEqual([3]);
  expect(ids("status=all", programs)).toEqual([1, 2, 3, 4]);
  expect(ids("status=nonsense", programs)).toEqual([2, 3, 4]);
});

test("filters narrow down together; tiers and kinds take any of those ticked", () => {
  const programs = [
    program(1, { tier: "985", region: "上海", directions: ["计算机", "软件"] }),
    program(2, { tier: "211", kind: "pre_recommendation" }),
    program(3, { tier: "c9", region: "上海" }),
  ];
  expect(ids("tier=c9&tier=211", programs)).toEqual([2, 3]);
  expect(ids("tier=985&region=上海&direction=软件", programs)).toEqual([1]);
  expect(ids("kind=pre_recommendation", programs)).toEqual([2]);
  expect(ids("kind=summer_camp&kind=pre_recommendation&region=北京", programs)).toEqual([2]);
  expect(ids("region=北京&region=上海&direction=计算机&direction=人工智能", programs)).toEqual([1]);
});

test("the tier 其他 picks the schools with no tier, alongside any others ticked", () => {
  const programs = [program(1, { tier: "985" }), program(2), program(3, { tier: "211" })];
  expect(ids("tier=other", programs)).toEqual([2]);
  expect(ids("tier=other&tier=985", programs)).toEqual([1, 2]);
});

test("each status choice counts what it would show under the other filters", () => {
  const programs = [
    program(1, { deadline: 500 }),
    program(2, { start: 1500 }),
    program(3),
    program(4, { deadline: null }),
    program(5, { kind: "pre_recommendation" }),
  ];
  const view = (params: string) =>
    tableView(programs, readFilters(new URLSearchParams(params)), NOW).counts.status;
  expect(view("status=closed")).toEqual({ "": 4, open: 2, upcoming: 1, closed: 1, all: 5 });
  expect(view("kind=summer_camp")).toEqual({ "": 3, open: 1, upcoming: 1, closed: 1, all: 4 });
});

test("each choice of the other filters counts what it would show under the rest", () => {
  const programs = [
    program(1, { region: "上海", directions: ["计算机", "软件"], tier: "985" }),
    program(2, { region: "上海", directions: ["计算机"], kind: "pre_recommendation" }),
    program(3, { directions: ["软件"], tier: "985" }),
    program(4, { deadline: 500, tier: "985" }),
  ];
  const { counts } = tableView(
    programs,
    readFilters(new URLSearchParams("region=上海&tier=985")),
    NOW,
  );
  // A filter's own choices leave it out, so picking one more region shows what it would add.
  expect(counts.region).toEqual({ 上海: 1, 北京: 1 });
  expect(counts.tier).toEqual({ 985: 1, other: 1 });
  // A program counts once for each of its directions; what has closed is left out by default.
  expect(counts.direction).toEqual({ 计算机: 1, 软件: 1 });
  expect(counts.kind).toEqual({ summer_camp: 1 });
});

test("search looks through the school, any of its short names, the college and the program", () => {
  const programs = [
    program(1, { school: "北京邮电大学", short: ["北邮", "BUPT"] }),
    program(2),
    program(3),
  ];
  expect(ids("q=北邮", programs)).toEqual([1]);
  expect(ids("q=bupt", programs)).toEqual([1]);
  expect(ids("q=北辰", programs)).toEqual([2, 3]);
  expect(ids("q=计算机学院", programs)).toEqual([1, 2, 3]);
  expect(ids("q=+项目2+", programs)).toEqual([2]);
});

test("sorting by publication puts the newest first and undated ones last", () => {
  const programs = [
    program(1, { published: "2026-05-01" }),
    program(2, { published: null }),
    program(3, { published: "2026-06-01" }),
  ];
  expect(ids("sort=published", programs)).toEqual([3, 1, 2]);
  expect(ids("", programs)).toEqual([1, 2, 3]);
});

test("pages hold the chosen number of rows, and a page past the end shows the last", () => {
  const programs = Array.from({ length: 45 }, (_, i) => program(i + 1));
  const view = (params: string) =>
    tableView(programs, readFilters(new URLSearchParams(params)), NOW);
  expect(view("").programs).toHaveLength(20);
  expect(view("page=3")).toMatchObject({ total: 45, page: 3 });
  expect(view("page=3").programs.map((p) => p.id)).toEqual([41, 42, 43, 44, 45]);
  expect(view("page=9").page).toBe(3);
  expect(view("per_page=50").programs).toHaveLength(45);
  expect(view("per_page=7").programs).toHaveLength(20);
});

test("the region and direction choices come from the whole cohort, not just what matched", () => {
  const programs = [
    program(1, { region: "上海", directions: ["软件"] }),
    program(2, { region: "北京", directions: ["计算机", "软件"], deadline: 500 }),
  ];
  const view = tableView(programs, readFilters(new URLSearchParams()), NOW);
  expect(view.programs.map((p) => p.id)).toEqual([1]);
  expect(view.regions).toEqual(["北京", "上海"]);
  expect(view.directions).toEqual(["计算机", "软件"]);
});
