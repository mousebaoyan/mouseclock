import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/cn";

// The site's tables on wide screens, one thing to a cell.
// They are laid out as a grid rather than as a table: each column is as wide as what it holds
// and the room left over is shared out evenly, so the gaps between columns are even, where a
// table would hand it all to its widest columns. The rows only group their cells, so lines and
// highlights are drawn on the cells. Phones get the same rows as a list (list.tsx).

// `head` is what each column is headed with; `actions` adds a last column for the rows' buttons,
// with a heading only screen readers read. `bare` leaves out the frame for a table that fills a
// panel, and the children are its rows.
export function Table({
  head,
  actions,
  bare,
  className,
  children,
}: {
  head: string[];
  actions?: string;
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      // Should a table be too wide, it scrolls rather than hide its last columns.
      className={cn("overflow-x-auto", !bare && "rounded-xl border bg-card shadow-card", className)}
    >
      <table
        className="grid text-sm [&_tbody,&_thead,&_tr]:contents"
        style={{ gridTemplateColumns: `repeat(${head.length + (actions ? 1 : 0)}, auto)` }}
      >
        <thead>
          <tr>
            {head.map((label) => (
              <th key={label} scope="col" className={HEADER}>
                {label}
              </th>
            ))}
            {actions && (
              <th scope="col" className={HEADER}>
                <span className="sr-only">{actions}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const HEADER =
  "h-10 content-center bg-muted/60 px-3 text-center text-xs font-medium whitespace-nowrap text-muted-foreground xl:px-4";

// `selected` marks the row a panel beside the table is showing.
export function Tr({ selected, children }: { selected?: boolean; children: ReactNode }) {
  return (
    <tr data-selected={selected || undefined} className="group/row">
      {children}
    </tr>
  );
}

// Every cell centered, so the even gaps show; `nowrap` keeps dates, counts and tags on one line
// with their figures lined up. A cell spanning rows, such as a school beside its colleges,
// keeps still while the row under the pointer lights up.
export function Td({
  nowrap,
  rowSpan,
  colSpan,
  className,
  ...props
}: ComponentProps<"td"> & { nowrap?: boolean }) {
  return (
    <td
      rowSpan={rowSpan}
      colSpan={colSpan}
      style={{
        gridRow: rowSpan ? `span ${rowSpan}` : undefined,
        gridColumn: colSpan ? `span ${colSpan}` : undefined,
      }}
      className={cn(
        "content-center border-t px-3 py-3 text-center xl:px-4",
        nowrap && "whitespace-nowrap tabular-nums",
        rowSpan
          ? "group-data-selected/row:bg-primary-soft"
          : "transition-colors group-hover/row:bg-muted/40 group-data-selected/row:bg-primary-soft",
        className,
      )}
      {...props}
    />
  );
}
