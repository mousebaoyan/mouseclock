import { expect, test } from "vitest";
import { countdown, currentCohort, parseTime, statusOf, timeText } from "./time.ts";

test("editors type a time as precise as the notice, which reads back as they typed it", () => {
  for (const [text, value] of [
    ["2026-06-30 17:00", { date: "2026-06-30", time: "17:00" }],
    ["2026-06-30", { date: "2026-06-30" }],
    ["2026-06-30 前", { date: "2026-06-30", mark: "before" }],
    ["2026-06-30 前后", { date: "2026-06-30", mark: "about" }],
    ["2026-06 下旬", { month: "2026-06", part: "late" }],
    ["2026-06", { month: "2026-06" }],
  ] as const) {
    expect(parseTime(text)).toEqual(value);
    expect(timeText(value)).toBe(text);
  }
  expect(parseTime(" 2026-06-30前 ")).toEqual({ date: "2026-06-30", mark: "before" });
  expect(parseTime("2026-06-30 9:00")).toEqual({ date: "2026-06-30", time: "09:00" });
  for (const text of ["6月30日", "2026-6-30", "2026-06 前", "2026-06-30 下旬", "2026-06-30 17"]) {
    expect(parseTime(text)).toBeNull();
  }
});

test("status follows the application's start and when applying is over", () => {
  const program = { apply_start: 100, apply_deadline: 200, closes_at: 200 };
  expect(statusOf(program, 99)).toBe("upcoming");
  expect(statusOf(program, 100)).toBe("open");
  expect(statusOf(program, 200)).toBe("closed");
  expect(statusOf({ apply_start: null, apply_deadline: 200, closes_at: 200 }, 150)).toBe("open");
  // Without a deadline, open until the event or the cohort's recommendation is over.
  const undated = { apply_start: 100, apply_deadline: null, closes_at: 300 };
  expect(statusOf(undated, 150)).toBe("open");
  expect(statusOf(undated, 300)).toBe("closed");
  expect(statusOf({ apply_start: null, apply_deadline: null, closes_at: 300 }, 150)).toBeNull();
  expect(statusOf({ apply_start: null, apply_deadline: null, closes_at: 300 }, 300)).toBe("closed");
});

test("countdowns round down, to the minute at the end", () => {
  const deadline = 10 * 86_400;
  const program = { apply_start: null, apply_deadline: deadline };
  expect(countdown(program, deadline - 2 * 86_400 - 1)).toBe("还剩 2 天");
  expect(countdown(program, deadline - 86_399)).toBe("还剩 23 小时");
  expect(countdown(program, deadline - 60)).toBe("还剩 1 分钟");
  expect(countdown(program, deadline - 59)).toBe("还剩不到 1 分钟");
  expect(countdown(program, deadline)).toBeNull();
  expect(countdown({ apply_start: 3600, apply_deadline: deadline }, 0)).toBe("1 小时后开始");
  expect(countdown({ apply_start: 0, apply_deadline: null }, 60)).toBeNull();
});

test("the cohort moves on as November begins in Beijing", () => {
  expect(currentCohort(new Date("2026-10-31T15:59:59Z"))).toBe(2027);
  expect(currentCohort(new Date("2026-10-31T16:00:00Z"))).toBe(2028);
  expect(currentCohort(new Date("2026-12-31T16:00:00Z"))).toBe(2028);
});
