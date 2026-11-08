import { expect, test } from "vitest";
import {
  beijingYear,
  countdown,
  currentCohort,
  formatApply,
  formatTime,
  formatWindow,
  statusOf,
} from "./time.ts";

test("times read as the notice wrote them, with the year only when it isn't this one", () => {
  expect(formatTime({ date: "2026-06-30", time: "23:59" }, 2026)).toBe("6月30日 23:59");
  expect(formatTime({ date: "2026-09-19", time: "24:00" }, 2026)).toBe("9月19日 24:00");
  expect(formatTime({ date: "2026-06-22", mark: "before" }, 2026)).toBe("6月22日前");
  expect(formatTime({ date: "2026-07-03", mark: "about" }, 2026)).toBe("7月3日前后");
  expect(formatTime({ month: "2026-07", part: "early" }, 2026)).toBe("7月上旬");
  expect(formatTime({ month: "2027-07" }, 2026)).toBe("2027年7月");
  expect(formatTime({ date: "2027-01-10" }, 2026)).toBe("2027年1月10日");
});

test("a window says what it has of its two ends", () => {
  const start = { date: "2026-06-01", time: "08:00" };
  const end = { date: "2026-06-14" };
  expect(formatWindow({ start, end }, 2026)).toBe("6月1日 08:00 至 6月14日");
  expect(formatWindow({ start }, 2026)).toBe("6月1日 08:00 起");
  expect(formatWindow({ end }, 2026)).toBe("至 6月14日");
});

test("status follows the application's start and deadline", () => {
  const program = { apply_start: 100, apply_deadline: 200 };
  expect(statusOf(program, 99)).toBe("upcoming");
  expect(statusOf(program, 100)).toBe("open");
  expect(statusOf(program, 200)).toBe("closed");
  expect(statusOf({ apply_start: null, apply_deadline: 200 }, 150)).toBe("open");
  expect(statusOf({ apply_start: 100, apply_deadline: null }, 150)).toBe("open");
  expect(statusOf({ apply_start: null, apply_deadline: null }, 150)).toBeNull();
});

test("the year turns at midnight in Beijing", () => {
  expect(beijingYear(new Date("2026-12-31T15:59:59Z"))).toBe(2026);
  expect(beijingYear(new Date("2026-12-31T16:00:00Z"))).toBe(2027);
});

test("the application says when it rolls, and when it says nothing", () => {
  const end = { date: "2026-06-14" };
  expect(formatApply({ end, rolling: true }, 2026)).toBe("至 6月14日（额满即止）");
  expect(formatApply({ rolling: true }, 2026)).toBe("额满即止");
  expect(formatApply(null, 2026)).toBe("未说明");
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
