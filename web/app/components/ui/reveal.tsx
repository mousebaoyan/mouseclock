import { Collapsible } from "@base-ui/react/collapsible";
import type { ReactNode } from "react";
import { cn } from "~/cn";
import { ChevronDown } from "~/components/icons";

// A small control that shows more beneath it, such as a field's sentences from the notice. The
// closed panel stays in the page, so the browser's find-in-page still reaches it.
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
    <Collapsible.Root className={className}>
      <Collapsible.Trigger className="group inline-flex h-6 items-center gap-1 rounded-md px-1.5 -mx-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/25 data-panel-open:text-foreground">
        {icon}
        {label}
        <ChevronDown className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Panel
        hiddenUntilFound
        className={cn(
          "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0",
          "[&[hidden]:not([hidden='until-found'])]:hidden",
        )}
      >
        <div className="pt-2">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
