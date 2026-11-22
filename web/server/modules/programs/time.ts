import type { ApplyValue, TimeValue } from "./schemas.ts";

// Beijing has kept UTC+8 all year since 1991.
function beijing(year: number, month: number, day: number, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

function numbers(text: string, separator: string) {
  return text.split(separator).map(Number);
}

const PART_FIRST_DAY = { early: 1, mid: 11, late: 21 };

// The earliest moment a time value can mean (design §8.2): when an application opens, say.
export function startOf(value: TimeValue) {
  if ("month" in value) {
    const [year, month] = numbers(value.month, "-");
    return beijing(year, month, value.part ? PART_FIRST_DAY[value.part] : 1);
  }
  const [year, month, day] = numbers(value.date, "-");
  if ("time" in value) {
    const [hour, minute] = numbers(value.time, ":");
    return beijing(year, month, day, hour, minute);
  }
  return beijing(year, month, day);
}

// When a deadline has passed, erring early (design §8.2): a bare date runs to the end of the
// day, a date marked 「前」 or 「前后」 to the end of the day before, a third of a month or a
// month only to its start. Pages show what the notice said, never this instant.
export function deadlineOf(value: TimeValue) {
  if ("month" in value || "time" in value) return startOf(value);
  const [year, month, day] = numbers(value.date, "-");
  return beijing(year, month, value.mark ? day : day + 1);
}

// The day a deadline falls on, which reminders count back from (design §11.3), erring early as
// deadlineOf does: the day itself for a bare date or a time, 24:00 too; the day before for 「前」
// and 「前后」; the first day of a third of a month or a month.
export function deadlineDay(value: TimeValue) {
  if ("month" in value) {
    return `${value.month}-${String(value.part ? PART_FIRST_DAY[value.part] : 1).padStart(2, "0")}`;
  }
  if ("time" in value || !value.mark) return value.date;
  const [year, month, day] = numbers(value.date, "-");
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

// Times as the notice wrote them (design §8.2), on pages and in messages: neither shows the
// instants worked out for sorting and reminders. The year is left out when it is `thisYear`, as
// people write dates.

export const PARTS = { early: "上旬", mid: "中旬", late: "下旬" };
export const MARKS = { before: "前", about: "前后" };

// The calendar day in Beijing, as YYYY-MM-DD.
export function beijingDay(now: Date) {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

// The year in Beijing, for formatTime.
export function beijingYear(now: Date) {
  return Number(beijingDay(now).slice(0, 4));
}

function yearMonth(year: number, month: number, thisYear: number) {
  return year === thisYear ? `${month}月` : `${year}年${month}月`;
}

export function formatTime(value: TimeValue, thisYear: number) {
  if ("month" in value) {
    const [year, month] = value.month.split("-").map(Number);
    return yearMonth(year, month, thisYear) + (value.part ? PARTS[value.part] : "");
  }
  const [year, month, day] = value.date.split("-").map(Number);
  const date = `${yearMonth(year, month, thisYear)}${day}日`;
  if ("time" in value) return `${date} ${value.time}`;
  return value.mark ? date + MARKS[value.mark] : date;
}

export function formatWindow(window: { start?: TimeValue; end?: TimeValue }, thisYear: number) {
  const start = window.start && formatTime(window.start, thisYear);
  const end = window.end && formatTime(window.end, thisYear);
  if (start && end) return `${start} 至 ${end}`;
  return start ? `${start} 起` : end ? `至 ${end}` : "";
}

export function formatApply(apply: ApplyValue | null, thisYear: number) {
  const window = apply ? formatWindow(apply, thisYear) : "";
  if (!apply?.rolling) return window || "未说明";
  return window ? `${window}（额满即止）` : "额满即止";
}

// When applying is over, for the status (design §9.1): at the deadline; without one, when the
// event ends; without either, when the cohort's recommendation ends, in October the year before.
export function closesAt(deadline: Date | null, event: TimeValue | null, cohort: number) {
  return deadline ?? (event ? deadlineOf(event) : beijing(cohort - 1, 11, 1));
}

// Design §9.1, from the table's instants in Unix seconds: closed once applying is over, at the
// deadline or, without one, when the event or the cohort's recommendation ends. With no start or
// deadline the notice gave no times, and until then pages say so rather than guess.
export type Status = "upcoming" | "open" | "closed";

export function statusOf(
  program: { apply_start: number | null; apply_deadline: number | null; closes_at: number },
  now: number,
): Status | null {
  if (program.closes_at <= now) return "closed";
  if (program.apply_start !== null && program.apply_start > now) return "upcoming";
  return program.apply_start === null && program.apply_deadline === null ? null : "open";
}
