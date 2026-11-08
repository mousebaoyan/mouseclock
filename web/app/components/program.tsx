import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink } from "./icons.tsx";
import { KindTag, STATUS_COLORS, Tag } from "./tags.tsx";
import type { ApplyValue, Kind } from "../../server/modules/programs/schemas.ts";
import { countdown, formatApply, formatTime, STATUS_LABELS, statusOf } from "../time.ts";

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

// Lists of programs are cards, one to a program: one column on phones, up to three side by side.
export function ProgramCards({ children }: { children: ReactNode }) {
  return <ul className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</ul>;
}

// Who runs the program on top, beside how long is left and what kind it is, which is what a list
// is read for; then its name, and at the foot when it takes applications. The whole card opens
// the program; the other links on it sit above that.
export function ProgramCard({
  program,
  now,
  thisYear,
  place,
  notice,
}: {
  program: Instants & { id: number; kind: Kind; name: string; apply: ApplyValue | null };
  now: number;
  thisYear: number;
  place: ReactNode;
  notice?: string;
}) {
  return (
    <li className="group relative flex flex-col rounded-xl border bg-card px-4 py-3.5 shadow-card transition-colors hover:border-primary/40 has-[h3_a:focus-visible]:ring-3 has-[h3_a:focus-visible]:ring-ring/30 sm:px-5 sm:py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">{place}</div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ProgramStatus program={program} now={now} />
          <KindTag kind={program.kind} />
        </div>
      </div>
      <h3 className="mt-3 mb-4 line-clamp-2 text-[15px] leading-snug font-semibold text-pretty group-hover:text-primary">
        <Link
          to={`/programs/${program.id}`}
          className="outline-none after:absolute after:inset-0 after:rounded-xl"
        >
          {program.name}
        </Link>
      </h3>
      <div className="mt-auto flex items-center gap-2 border-t pt-3">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground tabular-nums">
          {program.apply && (
            <>
              <span className="mr-1.5 text-subtle-foreground">报名</span>
              {formatApply(program.apply, thisYear)}
            </>
          )}
        </p>
        {notice && (
          <a
            href={notice}
            target="_blank"
            rel="nofollow noopener"
            aria-label={`${program.name}的通知原文`}
            title="通知原文"
            className="touch-target z-1 -my-1 -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-primary"
          >
            <ExternalLink />
          </a>
        )}
      </div>
    </li>
  );
}
