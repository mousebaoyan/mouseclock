import { expect, test } from "vitest";
import {
  beijingYear,
  closesAt,
  deadlineDay,
  deadlineOf,
  formatApply,
  formatTime,
  formatWindow,
  startOf,
  statusOf,
} from "./time.ts";

const iso = (date: Date) => date.toISOString();

test("times read as the notice wrote them, with the year only when it isn't this one", () => {
  expect(formatTime({ date: "2026-06-30", time: "23:59" }, 2026)).toBe("6月30日 23:59");
  expect(formatTime({ date: "2026-09-19", time: "24:00" }, 2026)).toBe("9月19日 24:00");
  expect(formatTime({ date: "2026-06-22", mark: "before" }, 2026)).toBe("6月22日前");
  expect(formatTime({ date: "2026-07-03", mark: "about" }, 2026)).toBe("7月3日前后");
  expect(formatTime({ month: "2026-07", part: "early" }, 2026)).toBe("7月上旬");
  expect(formatTime({ month: "2027-07" }, 2026)).toBe("2027年7月");
  expect(formatTime({ date: "2027-01-10" }, 2026)).toBe("2027年1月10日");
});

test("the year turns at midnight in Beijing", () => {
  expect(beijingYear(new Date("2026-12-31T15:59:59Z"))).toBe(2026);
  expect(beijingYear(new Date("2026-12-31T16:00:00Z"))).toBe(2027);
});

test("a deadline falls on its day, the day before when marked 前, the first day of a month or a third", () => {
  expect(deadlineDay({ date: "2026-06-30", time: "17:00" })).toBe("2026-06-30");
  expect(deadlineDay({ date: "2026-06-30", time: "24:00" })).toBe("2026-06-30");
  expect(deadlineDay({ date: "2026-06-30" })).toBe("2026-06-30");
  expect(deadlineDay({ date: "2027-01-01", mark: "before" })).toBe("2026-12-31");
  expect(deadlineDay({ date: "2026-07-03", mark: "about" })).toBe("2026-07-02");
  expect(deadlineDay({ month: "2026-07", part: "mid" })).toBe("2026-07-11");
  expect(deadlineDay({ month: "2026-07" })).toBe("2026-07-01");
});

test("a time to the minute is that minute in Beijing, and 24:00 is the end of the day", () => {
  expect(iso(deadlineOf({ date: "2026-06-30", time: "23:59" }))).toBe("2026-06-30T15:59:00.000Z");
  expect(iso(deadlineOf({ date: "2026-12-31", time: "24:00" }))).toBe("2026-12-31T16:00:00.000Z");
  expect(iso(startOf({ date: "2026-06-01", time: "08:00" }))).toBe("2026-06-01T00:00:00.000Z");
});

test("a bare date as a deadline runs to the end of the day, and starts at its beginning", () => {
  expect(iso(deadlineOf({ date: "2026-06-30" }))).toBe("2026-06-30T16:00:00.000Z");
  expect(iso(deadlineOf({ date: "2026-12-31" }))).toBe("2026-12-31T16:00:00.000Z");
  expect(iso(startOf({ date: "2026-06-30" }))).toBe("2026-06-29T16:00:00.000Z");
});

test("「X 日前」 and 「前后」 deadlines end with the day before", () => {
  expect(iso(deadlineOf({ date: "2026-06-22", mark: "before" }))).toBe("2026-06-21T16:00:00.000Z");
  expect(iso(deadlineOf({ date: "2027-01-01", mark: "about" }))).toBe("2026-12-31T16:00:00.000Z");
});

test("a third of a month or a month counts from its first day, as a deadline too", () => {
  expect(iso(deadlineOf({ month: "2026-07", part: "late" }))).toBe("2026-07-20T16:00:00.000Z");
  expect(iso(startOf({ month: "2026-07", part: "mid" }))).toBe("2026-07-10T16:00:00.000Z");
  expect(iso(deadlineOf({ month: "2026-09" }))).toBe("2026-08-31T16:00:00.000Z");
});

test("applying is over at the deadline, or else when the event or the cohort's recommendation ends", () => {
  const deadline = new Date("2026-09-14T06:00:00Z");
  expect(closesAt(deadline, { date: "2026-09-20" }, 2027)).toBe(deadline);
  expect(iso(closesAt(null, { date: "2025-09-18" }, 2026))).toBe("2025-09-18T16:00:00.000Z");
  expect(iso(closesAt(null, null, 2027))).toBe("2026-10-31T16:00:00.000Z");
});

test("a window says what it has of its two ends", () => {
  const start = { date: "2026-06-01", time: "08:00" };
  const end = { date: "2026-06-14" };
  expect(formatWindow({ start, end }, 2026)).toBe("6月1日 08:00 至 6月14日");
  expect(formatWindow({ start }, 2026)).toBe("6月1日 08:00 起");
  expect(formatWindow({ end }, 2026)).toBe("至 6月14日");
});

test("the application says when it rolls, and when it says nothing", () => {
  const end = { date: "2026-06-14" };
  expect(formatApply({ end, rolling: true }, 2026)).toBe("至 6月14日（额满即止）");
  expect(formatApply({ rolling: true }, 2026)).toBe("额满即止");
  expect(formatApply(null, 2026)).toBe("未说明");
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
