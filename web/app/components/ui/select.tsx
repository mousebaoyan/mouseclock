import { Combobox } from "@base-ui/react/combobox";
import { Select as Base } from "@base-ui/react/select";
import { useState, type ReactNode } from "react";
import { cn } from "~/cn";
import { Check, ChevronDown, Search } from "~/components/icons";

// Dropdowns in the site's own panel rather than the system's. A long list gets a search box
// above it, so the option wanted is a few keys away rather than a long scroll; Base UI's
// Combobox is the listbox with one, its Select the one without. An option's `count`, such as how
// many programs a region has, shows on its right.

export type SelectOption = { value: string; label: string; count?: number };

// From this many options on, a dropdown can be searched.
const SEARCH_FROM = 9;

function matching(options: readonly SelectOption[], query: string) {
  const q = query.trim().toLowerCase();
  return options.filter((option) => option.label.toLowerCase().includes(q));
}

// For one value. Forms get it through Base UI's hidden input when `name` is given; pages that
// act on a pick at once pass `onValueChange`. The empty value stands for "any", such as 全部地区.
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
  const [query, setQuery] = useState("");
  const shown = matching(options, query);
  const initial = defaultValue ?? (value === undefined ? options[0]?.value : undefined);
  const labelOf = (picked: string | null) =>
    options.find((option) => option.value === picked)?.label ?? "";
  if (options.length < SEARCH_FROM) {
    return (
      <Base.Root
        items={options}
        value={value}
        defaultValue={initial}
        onValueChange={(next) => onValueChange?.(next ?? "")}
        name={name}
        required={required}
        disabled={disabled}
        modal={false}
      >
        <Base.Trigger aria-label={label} className={cn(TRIGGER, className)}>
          <Base.Value className="truncate" />
          <TriggerIcon />
        </Base.Trigger>
        <Base.Portal>
          <Base.Positioner alignItemWithTrigger={false} sideOffset={4} className={POSITIONER}>
            <Base.Popup className={POPUP}>
              <Base.List className={LIST}>
                {options.map((option) => (
                  <Base.Item key={option.value} value={option.value} className={ITEM}>
                    <Base.ItemText className="flex-1">{option.label}</Base.ItemText>
                    <Count option={option} />
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
  return (
    <Combobox.Root
      items={options.map((option) => option.value)}
      filteredItems={shown.map((option) => option.value)}
      value={value}
      defaultValue={initial}
      onValueChange={(next: string | null) => onValueChange?.(next ?? "")}
      itemToStringLabel={labelOf}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      name={name}
      required={required}
      disabled={disabled}
    >
      <Combobox.Trigger aria-label={label} className={cn(TRIGGER, className)}>
        <Combobox.Value>
          {(picked: string | null) => <span className="truncate">{labelOf(picked)}</span>}
        </Combobox.Value>
        <TriggerIcon />
      </Combobox.Trigger>
      <SearchPopup label={label}>
        {shown.map((option) => (
          <OptionRow key={option.value} option={option} indicator={<Check />} />
        ))}
      </SearchPopup>
    </Combobox.Root>
  );
}

// For any number of values; none picked means all, which the trigger says as `all`, such as
// 全部地区. A long list can also pick or drop all it shows at once, or swap them over, which acts
// on the matches while searching.
export function MultiSelect({
  options,
  picked,
  onPickedChange,
  all,
  className,
  "aria-label": label,
}: {
  options: readonly SelectOption[];
  picked: string[];
  onPickedChange: (values: string[]) => void;
  all: string;
  className?: string;
  "aria-label": string;
}) {
  const [query, setQuery] = useState("");
  // In the order of the options, so the address doesn't change with the order of the clicks.
  const change = (values: string[]) =>
    onPickedChange(
      options.filter((option) => values.includes(option.value)).map((option) => option.value),
    );
  const labels = picked.map(
    (value) => options.find((option) => option.value === value)?.label ?? value,
  );
  const trigger = (
    <>
      <span className="truncate">
        {labels.length === 0
          ? all
          : labels.length <= 2
            ? labels.join("、")
            : `${labels[0]}等 ${labels.length} 个`}
      </span>
      <TriggerIcon />
    </>
  );
  const triggerClass = cn(
    TRIGGER,
    picked.length > 0 && "border-primary/50 text-primary",
    className,
  );
  const box = (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card text-primary-foreground group-data-selected:border-primary group-data-selected:bg-primary">
      <Check className="size-3 stroke-3 opacity-0 group-data-selected:opacity-100" />
    </span>
  );
  if (options.length < SEARCH_FROM) {
    return (
      <Base.Root multiple value={picked} onValueChange={change} modal={false}>
        <Base.Trigger aria-label={label} className={triggerClass}>
          {trigger}
        </Base.Trigger>
        <Base.Portal>
          <Base.Positioner alignItemWithTrigger={false} sideOffset={4} className={POSITIONER}>
            <Base.Popup className={POPUP}>
              <Base.List className={LIST}>
                {options.map((option) => (
                  <Base.Item
                    key={option.value}
                    value={option.value}
                    className={cn(ITEM, "group data-selected:font-normal")}
                  >
                    {box}
                    <Base.ItemText className="flex-1">{option.label}</Base.ItemText>
                    <Count option={option} />
                  </Base.Item>
                ))}
              </Base.List>
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
    );
  }
  const shownOptions = matching(options, query);
  const shown = shownOptions.map((option) => option.value);
  return (
    <Combobox.Root
      multiple
      items={options.map((option) => option.value)}
      filteredItems={shown}
      value={picked}
      onValueChange={change}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <Combobox.Trigger aria-label={label} className={triggerClass}>
        {trigger}
      </Combobox.Trigger>
      <SearchPopup
        label={label}
        tools={
          <div className="flex items-center gap-0.5 border-b px-1.5 py-1">
            <Tool onClick={() => change([...picked, ...shown])}>全选</Tool>
            <Tool
              onClick={() =>
                change([
                  ...picked.filter((value) => !shown.includes(value)),
                  ...shown.filter((value) => !picked.includes(value)),
                ])
              }
            >
              反选
            </Tool>
            <Tool onClick={() => change(picked.filter((value) => !shown.includes(value)))}>
              清空
            </Tool>
            <span className="ml-auto pr-1 text-xs text-subtle-foreground">
              已选 {picked.length} 项
            </span>
          </div>
        }
      >
        {shownOptions.map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            box={box}
            className="group data-selected:font-normal"
          />
        ))}
      </SearchPopup>
    </Combobox.Root>
  );
}

// The popup of a searchable dropdown: the search on top, any tools under it, then the list.
function SearchPopup({
  label,
  tools,
  children,
}: {
  label: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Combobox.Portal>
      <Combobox.Positioner align="start" sideOffset={4} className={POSITIONER}>
        <Combobox.Popup aria-label={label} className={cn(POPUP, "w-64")}>
          <div className="border-b p-1.5">
            <label className="relative block">
              <span className="sr-only">搜索{label}</span>
              <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle-foreground" />
              <Combobox.Input placeholder={`搜索${label}`} className="field h-8 pl-8" />
            </label>
          </div>
          {tools}
          <Combobox.Empty className="px-3 py-4 text-center text-[13px] text-muted-foreground empty:hidden">
            没有匹配的{label}
          </Combobox.Empty>
          <Combobox.List className={cn(LIST, "empty:hidden")}>{children}</Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  );
}

// An option of a searchable list, ticked by a box before it or a check after it.
function OptionRow({
  option,
  box,
  indicator,
  className,
}: {
  option: SelectOption;
  box?: ReactNode;
  indicator?: ReactNode;
  className?: string;
}) {
  return (
    <Combobox.Item value={option.value} className={cn(ITEM, className)}>
      {box}
      <span className="flex-1 truncate">{option.label}</span>
      <Count option={option} />
      {indicator && <Combobox.ItemIndicator className="flex">{indicator}</Combobox.ItemIndicator>}
    </Combobox.Item>
  );
}

// Options with none dim their count rather than drop out, so the list keeps its order.
function Count({ option }: { option: SelectOption }) {
  if (option.count === undefined) return null;
  return (
    <span
      className={cn(
        "pl-3 text-xs font-normal tabular-nums",
        option.count === 0 ? "text-subtle-foreground/70" : "text-muted-foreground",
      )}
    >
      {option.count}
    </span>
  );
}

function Tool({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-1 text-xs text-primary hover:bg-primary-soft"
    >
      {children}
    </button>
  );
}

function TriggerIcon() {
  return (
    <span className="flex text-subtle-foreground">
      <ChevronDown />
    </span>
  );
}

const TRIGGER =
  "field flex items-center justify-between gap-2 pr-2 text-left data-popup-open:border-primary data-popup-open:ring-3 data-popup-open:ring-ring/15";
const POSITIONER = "z-50 outline-none";
const POPUP =
  "flex max-h-[min(22rem,var(--available-height))] min-w-(--anchor-width) origin-(--transform-origin) flex-col overflow-hidden rounded-lg border bg-popover text-sm shadow-pop transition-[opacity,scale] duration-100 outline-none data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0";
const LIST = "min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 scroll-py-1";
const ITEM =
  "flex items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 whitespace-nowrap outline-none select-none data-highlighted:bg-accent data-selected:font-medium data-selected:text-primary";
