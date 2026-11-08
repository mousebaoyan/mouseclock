import { STATUS_COLORS, Tag } from "./tags.tsx";
import type { ApplyValue } from "../../server/modules/programs/schemas.ts";
import { countdown, formatTime, STATUS_LABELS, statusOf } from "../time.ts";

// A program's application dates and status, the same wherever programs are listed.

type Instants = { apply_start: number | null; apply_deadline: number | null };

// Within this long of the deadline the status turns red: reminders go out three days before
// (design §11).
const SOON_SECONDS = 3 * 86_400;

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

// A program's state in one tag: how long is left while it takes applications, or until it does,
// red within three days of the deadline; otherwise what the state is.
export function ProgramStatus({ program, now }: { program: Instants; now: number }) {
  const status = statusOf(program, now);
  if (!status) return <Tag color="gray">时间未注明</Tag>;
  const soon =
    status === "open" &&
    program.apply_deadline !== null &&
    program.apply_deadline - now < SOON_SECONDS;
  return (
    <Tag color={soon ? "red" : STATUS_COLORS[status]}>
      {countdown(program, now) ?? STATUS_LABELS[status]}
    </Tag>
  );
}
