import { useEffect, useState } from "react";
import type { ApplyValue, TimeValue } from "../server/modules/programs/schemas.ts";

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

export function formatApply(apply: ApplyValue | null, thisYear: number) {
  const window = apply ? formatWindow(apply, thisYear) : "";
  if (!apply?.rolling) return window || "未说明";
  return window ? `${window}（额满即止）` : "额满即止";
}

// Design §9.1, from the instants the API gives in Unix seconds. With neither, the notice gave
// no times, and the page says so rather than guess.
export type Status = "upcoming" | "open" | "closed";
export const STATUS_LABELS: Record<Status, string> = {
  upcoming: "未开始",
  open: "报名中",
  closed: "已截止",
};

export function statusOf(
  program: { apply_start: number | null; apply_deadline: number | null },
  now: number,
): Status | null {
  if (program.apply_deadline !== null && program.apply_deadline <= now) return "closed";
  if (program.apply_start !== null && program.apply_start > now) return "upcoming";
  return program.apply_start === null && program.apply_deadline === null ? null : "open";
}

// The year in Beijing, for formatTime.
export function beijingYear(now: Date) {
  return new Date(now.getTime() + 8 * 3600_000).getUTCFullYear();
}

// How long until a program opens or closes, rounded down so it never reads as more time than
// there is. Null once closed, and while open with no deadline.
export function countdown(
  program: { apply_start: number | null; apply_deadline: number | null },
  now: number,
) {
  const { apply_start: start, apply_deadline: deadline } = program;
  if (deadline !== null && deadline <= now) return null;
  if (start !== null && start > now) {
    const left = span(start - now);
    return left ? `${left}后开始` : "马上开始";
  }
  if (deadline === null) return null;
  const left = span(deadline - now);
  return left ? `还剩 ${left}` : "还剩不到 1 分钟";
}

function span(seconds: number) {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} 天`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小时`;
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分钟` : null;
}

// The cohort applying now (design §10): from November the winter camps are for the cohort after
// the one that just had its September round.
export function currentCohort(now: Date) {
  const beijing = new Date(now.getTime() + 8 * 3600_000);
  return beijing.getUTCFullYear() + (beijing.getUTCMonth() >= 10 ? 2 : 1);
}

// Now in Unix seconds, starting from the server's so the first render matches it, then each
// minute for statuses and countdowns. A loader that runs again brings a later server time.
export function useNow(serverNow: number) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(now, serverNow);
}
