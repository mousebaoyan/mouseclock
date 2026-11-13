import type { ReactNode } from "react";
import { Check } from "~/components/icons";

// A box to tick with its label beside it: a native checkbox drawn by the site rather than the
// system, so forms send it as they would any other.
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
    <label className="inline-flex items-center gap-2 text-sm select-none">
      <span className="relative flex size-4 shrink-0">
        <input
          type="checkbox"
          name={name}
          value={value}
          defaultChecked={defaultChecked}
          className="peer size-4 appearance-none rounded-[4px] border border-input bg-card transition-colors outline-none checked:border-primary checked:bg-primary focus-visible:ring-3 focus-visible:ring-ring/25"
        />
        <Check className="pointer-events-none absolute inset-0.5 size-3 stroke-3 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100" />
      </span>
      {children}
    </label>
  );
}
