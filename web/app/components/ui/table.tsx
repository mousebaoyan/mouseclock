import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/cn";

// The site's tables on wide screens: headers centered over their columns, names and text from
// the left, dates, counts and tags centered, one thing to a cell, and the same padding on every
// cell so the gaps between columns are even. Phones get the same rows as a list (list.tsx).

// `bare` leaves out the frame for a table that fills a panel.
export function Table({
  bare,
  className,
  children,
}: {
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(!bare && "overflow-hidden rounded-xl border bg-card shadow-card", className)}
    >
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "h-10 border-b bg-muted/60 px-3 text-center text-xs font-medium whitespace-nowrap text-muted-foreground xl:px-4",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ center, className, ...props }: ComponentProps<"td"> & { center?: boolean }) {
  return (
    <td
      className={cn(
        "px-3 py-3 align-middle xl:px-4",
        center ? "text-center whitespace-nowrap tabular-nums" : "text-left",
        className,
      )}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("border-b transition-colors last:border-b-0 hover:bg-muted/40", className)}
      {...props}
    />
  );
}
