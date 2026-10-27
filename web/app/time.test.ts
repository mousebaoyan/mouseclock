import { expect, test } from "vitest";
import { beijingYear, formatTime, formatWindow, statusOf } from "./time.ts";

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
