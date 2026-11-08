import { expect, test } from "vitest";
import { collegeView } from "./college-list.ts";

function college(name: string, region: string, directions: string[] = []) {
  return { name, region, directions };
}

// 北辰 lists a college elsewhere first; 安和 comes first by name but its region comes later.
const SCHOOLS = [
  {
    name: "北辰大学",
    short_names: ["北辰", "BCU"],
    tier: "985",
    colleges: [college("深圳研究院", "广东", ["软件"]), college("计算机学院", "北京", ["计算机"])],
  },
  {
    name: "安和大学",
    short_names: [],
    tier: null,
    colleges: [college("计算机学院", "福建", ["计算机", "软件"]), college("数学学院", "福建")],
  },
];

function view(params: string) {
  return collegeView(SCHOOLS, new URLSearchParams(params));
}

function names(params: string) {
  return view(params).schools.map((school) => [school.name, school.colleges.map((c) => c.name)]);
}

test("a search for a school keeps its colleges; one for a college keeps those it names", () => {
  expect(names("q=bcu")).toEqual([["北辰大学", ["深圳研究院", "计算机学院"]]]);
  expect(names("q=数学")).toEqual([["安和大学", ["数学学院"]]]);
  expect(view("q=bcu").schools[0]).not.toHaveProperty("short_names");
});

test("filters take any of their picks and narrow down together", () => {
  expect(names("region=北京&region=福建&direction=计算机")).toEqual([
    ["安和大学", ["计算机学院"]],
    ["北辰大学", ["计算机学院"]],
  ]);
  expect(names("tier=other&direction=软件")).toEqual([["安和大学", ["计算机学院"]]]);
});

test("each choice counts what it would show under the other filters", () => {
  const { counts } = view("region=福建&tier=985");
  // Tiers count schools, regions and directions colleges.
  expect(counts.tier).toEqual({ other: 1 });
  expect(counts.region).toEqual({ 广东: 1, 北京: 1 });
  expect(counts.direction).toEqual({});
});

test("by region, a school sorts by the first of its regions in pinyin order", () => {
  expect(names("sort=region").map(([name]) => name)).toEqual(["北辰大学", "安和大学"]);
});

test("a page that is not a whole number goes to the first", () => {
  expect(view("page=1.5").page).toBe(1);
  expect(view("page=9").page).toBe(1);
});
