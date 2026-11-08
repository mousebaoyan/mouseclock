import type { ComponentProps } from "react";
import { cn } from "~/cn";

// Every list of the site reads the same way: headers centered over their columns, names and
// text from the left, dates, counts and tags centered, and the same padding on every cell so
// the gaps between columns are even.

// `bare` leaves out the frame for a table that fills a panel.
export function Table({ bare, className, ...props }: ComponentProps<"table"> & { bare?: boolean }) {
  return (
    <div className={cn("overflow-x-auto", !bare && "rounded-xl border bg-card shadow-card")}>
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "h-11 border-b bg-muted/50 px-4 text-center text-xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ center, className, ...props }: ComponentProps<"td"> & { center?: boolean }) {
  return (
    <td
      className={cn("px-4 py-3.5 align-middle", center ? "text-center" : "text-left", className)}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b last:border-b-0 hover:bg-muted/40", className)} {...props} />;
}
