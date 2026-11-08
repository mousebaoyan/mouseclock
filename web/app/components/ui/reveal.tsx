import type { ReactNode } from "react";
import { cn } from "~/cn";
import { ChevronDown } from "~/components/icons";

// A small control that shows more beneath it, such as a field's sentences from the notice. A
// native <details>: the closed part stays in the page, so the browser's find-in-page still
// reaches it and opens it.
export function Reveal({
  label,
  icon,
  className,
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("group/reveal", className)}>
      <summary className="touch-target -mx-1.5 inline-flex h-6 list-none items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/25 group-open/reveal:text-foreground [&::-webkit-details-marker]:hidden">
        {icon}
        {label}
        <ChevronDown className="size-3.5 transition-transform duration-200 group-open/reveal:rotate-180" />
      </summary>
      <div className="pt-2 group-open/reveal:drop-in">{children}</div>
    </details>
  );
}
