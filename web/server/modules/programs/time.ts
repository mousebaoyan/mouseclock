import type { TimeValue } from "./schemas.ts";

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
