import { useEffect, useState } from "react";
import type { TimeValue } from "../server/modules/programs/schemas.ts";
import { beijingDay, MARKS, PARTS, type Status } from "../server/modules/programs/time.ts";

// A time as editors type it, as precise as the notice and no more: 2026-06-30 17:00,
// 2026-06-30, 2026-06-30 前, 2026-06-30 前后, 2026-06 上旬 (中旬, 下旬) or 2026-06.
export const TIME_HINT =
  "格式：2026-06-30 17:00、2026-06-30、2026-06-30 前、2026-06 下旬或 2026-06";

export function timeText(value: TimeValue) {
  if ("month" in value) return value.part ? `${value.month} ${PARTS[value.part]}` : value.month;
  if ("time" in value) return `${value.date} ${value.time}`;
  return value.mark ? `${value.date} ${MARKS[value.mark]}` : value.date;
}

// Null when the text is none of those forms; the API checks the date is on the calendar.
export function parseTime(text: string): TimeValue | null {
  const match = /^(\d{4}-\d{2})(-\d{2})?\s*(.*)$/.exec(text.trim());
  if (!match) return null;
  const [, month, day, rest] = match;
  if (!day) {
    if (rest === "") return { month };
    const part = (["early", "mid", "late"] as const).find((key) => PARTS[key] === rest);
    return part ? { month, part } : null;
  }
  const date = month + day;
  if (rest === "") return { date };
  if (/^\d{1,2}:\d{2}$/.test(rest)) return { date, time: rest.padStart(5, "0") };
  const mark = (["before", "about"] as const).find((key) => MARKS[key] === rest);
  return mark ? { date, mark } : null;
}

export const STATUS_LABELS: Record<Status, string> = {
  upcoming: "未开始",
  open: "报名中",
  closed: "已截止",
};

// The day an instant falls on in Beijing, as the crawl dashboard counts days.
export function beijingDate(seconds: number) {
  return beijingDay(new Date(seconds * 1000));
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
  const [year, month] = beijingDay(now).split("-").map(Number);
  return year + (month >= 11 ? 2 : 1);
}

export function cohortChoices(current: number) {
  return [current + 1, current, current - 1, current - 2];
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
