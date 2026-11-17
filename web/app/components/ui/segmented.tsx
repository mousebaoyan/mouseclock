import { Link } from "react-router";
import { cn } from "~/cn";

// A filter that takes exactly one of a few choices, side by side in one track, each a link to
// the address with it picked; a count beside a choice says how many it would show. On phones
// the track fills the width and counts go under their choices, so all of them fit.
export function Segmented({
  label,
  items,
}: {
  label: string;
  items: { to: string; label: string; count?: number; on: boolean }[];
}) {
  return (
    <fieldset className="flex w-full min-w-0 rounded-md bg-muted p-0.5 sm:inline-flex sm:w-auto">
      <legend className="sr-only">{label}</legend>
      {items.map((item) => (
        <Link
          key={item.label}
          to={item.to}
          replace
          preventScrollReset
          aria-current={item.on ? "true" : undefined}
          className={cn(
            "flex flex-1 flex-col items-center justify-center rounded-[5px] border px-1 py-1 text-[13px] leading-tight whitespace-nowrap sm:h-7 sm:flex-none sm:flex-row sm:gap-1.5 sm:px-3 sm:py-0",
            item.on
              ? "border-input bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(24_33_47/0.06)]"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
          {item.count !== undefined && (
            <span
              className={cn(
                "text-xs tabular-nums",
                item.on ? "text-primary" : "text-subtle-foreground",
              )}
            >
              {item.count}
            </span>
          )}
        </Link>
      ))}
    </fieldset>
  );
}
