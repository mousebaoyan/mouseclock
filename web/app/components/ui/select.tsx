import { Select as Base } from "@base-ui/react/select";
import { cn } from "~/cn";
import { Check, ChevronDown } from "~/components/icons";

export type SelectOption = { value: string; label: string };

// A dropdown for one value, in the site's own panel rather than the system's. Forms get the
// value through Base UI's hidden input when `name` is given; pages that act on a pick at once
// pass `onValueChange`. The empty value stands for "any", such as 全部地区.
export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  required,
  disabled,
  className,
  "aria-label": label,
}: {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label": string;
}) {
  return (
    <Base.Root
      items={options}
      value={value}
      defaultValue={defaultValue ?? (value === undefined ? options[0]?.value : undefined)}
      onValueChange={(next) => onValueChange?.(next ?? "")}
      name={name}
      required={required}
      disabled={disabled}
      modal={false}
    >
      <Base.Trigger
        aria-label={label}
        className={cn(
          "field flex items-center justify-between gap-2 pr-2 text-left data-popup-open:border-primary data-popup-open:ring-3 data-popup-open:ring-ring/15",
          className,
        )}
      >
        <Base.Value className="truncate" />
        <Base.Icon className="flex text-subtle-foreground">
          <ChevronDown />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner alignItemWithTrigger={false} sideOffset={4} className="z-50 outline-none">
          <Base.Popup className="max-h-[min(20rem,var(--available-height))] min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg border bg-popover p-1 text-sm shadow-pop transition-[opacity,scale] duration-100 outline-none data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0">
            <Base.List>
              {options.map((option) => (
                <Base.Item
                  key={option.value}
                  value={option.value}
                  className="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 whitespace-nowrap outline-none select-none data-highlighted:bg-accent data-selected:font-medium data-selected:text-primary"
                >
                  <Base.ItemText className="flex-1">{option.label}</Base.ItemText>
                  <Base.ItemIndicator className="flex">
                    <Check />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
