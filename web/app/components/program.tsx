import { cn } from "~/cn";
import type { ApplyValue } from "../../server/modules/programs/schemas.ts";
import { countdown, formatTime, statusOf } from "../time.ts";

// A program's application dates and countdown, the same in every list of programs.

type Instants = { apply_start: number | null; apply_deadline: number | null };

// Within this long of the deadline the countdown turns red: reminders go out three days before
// (design §11).
export const SOON_SECONDS = 3 * 86_400;

export function ApplyStart({ apply, thisYear }: { apply: ApplyValue | null; thisYear: number }) {
  const start = apply?.start;
  return start ? formatTime(start, thisYear) : <Missing />;
}

// The deadline as the notice wrote it; some take applications until the places are filled.
export function ApplyDeadline({ apply, thisYear }: { apply: ApplyValue | null; thisYear: number }) {
  const end = apply?.end;
  const rolling = apply?.rolling;
  if (!end) return rolling ? "额满即止" : <Missing />;
  return (
    <>
      {formatTime(end, thisYear)}
      {rolling && <span className="block text-xs text-muted-foreground">或额满即止</span>}
    </>
  );
}

export function Missing() {
  return <span className="text-subtle-foreground">未注明</span>;
}

export function Countdown({ program, now }: { program: Instants; now: number }) {
  const left = countdown(program, now);
  if (!left) return null;
  const soon =
    statusOf(program, now) === "open" &&
    program.apply_deadline !== null &&
    program.apply_deadline - now < SOON_SECONDS;
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        soon ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      {left}
    </span>
  );
}

// How much of the application window has passed, for a program open now with both ends known.
// The countdown beside it says the same in words.
export function WindowBar({ program, now }: { program: Instants; now: number }) {
  const { apply_start: start, apply_deadline: end } = program;
  if (start === null || end === null || now < start || now >= end) return null;
  const passed = Math.round(((now - start) / (end - start)) * 100);
  return (
    <span aria-hidden="true" className="block h-1 w-16 overflow-hidden rounded-full bg-muted">
      <span
        className={cn(
          "block h-full rounded-full",
          end - now < SOON_SECONDS ? "bg-destructive" : "bg-primary",
        )}
        style={{ width: `${Math.max(passed, 6)}%` }}
      />
    </span>
  );
}
