import { expect, test } from "vitest";
import { closesAt, deadlineOf, startOf } from "./time.ts";

const iso = (date: Date) => date.toISOString();

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
