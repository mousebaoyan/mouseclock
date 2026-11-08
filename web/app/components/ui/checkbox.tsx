import { Checkbox as Base } from "@base-ui/react/checkbox";
import type { ReactNode } from "react";
import { Check } from "~/components/icons";

// A box to tick with its label beside it. With `name`, Base UI's hidden input sends `value`
// (or "on") with the form while it is ticked, as a native checkbox would.
export function Checkbox({
  name,
  value,
  defaultChecked,
  children,
}: {
  name: string;
  value?: string;
  defaultChecked?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm select-none">
      <Base.Root
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/25 data-checked:border-primary data-checked:bg-primary"
      >
        <Base.Indicator className="flex text-primary-foreground data-unchecked:hidden">
          <Check className="size-3 stroke-3" />
        </Base.Indicator>
      </Base.Root>
      {children}
    </label>
  );
}
