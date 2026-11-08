import type { ReactNode } from "react";
import { cn } from "~/cn";

// Lists of the site are grouped, as a diary is by day: the group's name stands to the left of
// its items on wide screens and above them on narrow ones, so what belongs together reads at a
// glance instead of as rows of a spreadsheet.

export function Group({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-x-6 gap-y-2.5 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-20 lg:self-start lg:pt-3">{label}</div>
      {children}
    </section>
  );
}

// The items of a group, or of a list that has none.
export function List({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <ul className={cn("divide-y overflow-hidden rounded-xl border bg-card shadow-card", className)}>
      {children}
    </ul>
  );
}

// One item: what it is on the first line and about it on the second, with its state on the
// right; anything more goes beneath.
export function Row({
  title,
  meta,
  side,
  sideMeta,
  selected,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  side?: ReactNode;
  sideMeta?: ReactNode;
  selected?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className={cn("px-4 py-3.5 sm:px-5", selected && "bg-primary-soft")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{title}</div>
          {meta && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {(side || sideMeta) && (
          <div className="flex shrink-0 flex-col items-end gap-1 text-right">
            {side}
            {sideMeta && <div className="text-[13px] text-muted-foreground">{sideMeta}</div>}
          </div>
        )}
      </div>
      {children}
    </li>
  );
}
