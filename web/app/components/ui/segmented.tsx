import { Link } from "react-router";
import { cn } from "~/cn";

// A filter that takes exactly one of a few choices, side by side in one track, each a link to
// the address with it picked; a count beside a choice says how many it would show.
export function Segmented({
  label,
  items,
}: {
  label: string;
  items: { to: string; label: string; count?: number; on: boolean }[];
}) {
  return (
    <div className="-m-0.5 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <fieldset className="inline-flex min-w-0 rounded-md bg-muted p-0.5">
        <legend className="sr-only">{label}</legend>
        {items.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            replace
            preventScrollReset
            aria-current={item.on ? "true" : undefined}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[5px] border px-3 text-[13px] whitespace-nowrap",
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
    </div>
  );
}
