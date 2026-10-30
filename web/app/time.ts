import type { TimeValue } from "../server/modules/programs/schemas.ts";
import type { Status } from "../server/modules/programs/time.ts";
export { statusOf, type Status } from "../server/modules/programs/time.ts";

// Times as the notice wrote them (design §8.2): pages never show the instants worked out for
// sorting and reminders. The year is left out when it is `thisYear`, as people write dates.

const PARTS = { early: "上旬", mid: "中旬", late: "下旬" };
const MARKS = { before: "前", about: "前后" };

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

export const STATUS_LABELS: Record<Status, string> = {
  upcoming: "未开始",
  open: "报名中",
  closed: "已截止",
};

// The year in Beijing, for formatTime.
export function beijingYear(now: Date) {
  return new Date(now.getTime() + 8 * 3600_000).getUTCFullYear();
}
