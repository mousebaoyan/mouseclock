import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cn } from "~/cn";
import { Check, ChevronDown } from "~/components/icons";
import { matching, moveFocus, Popup, PopupSearch, useDismiss } from "~/components/disclosure";

// Dropdowns in the site's own panel rather than the system's, working like the menus of
// disclosure.tsx. A long list gets a search box above it, so the option wanted is a few keys away
// rather than a long scroll. An option's `count`, such as how many programs a region has, shows
// on its right.

export type SelectOption = { value: string; label: string; count?: number };

// From this many options on, a dropdown can be searched.
const SEARCH_FROM = 9;

// The open list's parts shared by both dropdowns: the button, the panel and the search.
function useList(optionCount: number) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const searchable = optionCount >= SEARCH_FROM;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useDismiss(
    open,
    (escaped) => {
      setOpen(false);
      if (escaped) button.current?.focus();
    },
    [button, panel],
  );
  // Without a search box, the focus goes to the option picked, or the first.
  useEffect(() => {
    if (!open || searchable) return;
    const list = panel.current;
    (
      list?.querySelector<HTMLElement>("[aria-current], [aria-pressed=true]") ??
      list?.querySelector<HTMLElement>("[data-item]")
    )?.focus();
  }, [open, searchable]);
  function show() {
    setQuery("");
    setOpen(true);
  }
  // Keys on an option. Tab closes the list and gives the focus back to its button: the list is
  // at the end of the page, so Tab would otherwise leave for its end.
  function onItemKey(e: KeyboardEvent) {
    if (moveFocus(e, panel.current, search.current)) return;
    if (e.key === "Tab") {
      e.preventDefault();
      close();
    }
  }
  // Keys in the search box: down to the options, back to the button with Shift+Tab.
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      panel.current?.querySelector<HTMLElement>("[data-item]")?.focus();
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      close();
    }
  }
  const triggerProps = {
    ref: button,
    type: "button" as const,
    "aria-expanded": open,
    onClick: () => (open ? setOpen(false) : show()),
    onKeyDown: (e: KeyboardEvent) => {
      if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        show();
      }
    },
  };
  return {
    open,
    query,
    setQuery,
    button,
    panel,
    search,
    searchable,
    close,
    onItemKey,
    onSearchKey,
    triggerProps,
  };
}

// For one value. Forms get it through a hidden input when `name` is given; pages that act on a
// pick at once pass `onValueChange`. The empty value stands for "any", such as 全部地区.
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
  // Like a native <select>, the first option unless said otherwise.
  const start = defaultValue ?? options.at(0)?.value ?? "";
  const [own, setOwn] = useState(start);
  const current = value ?? own;
  const list = useList(options.length);
  const input = useRef<HTMLInputElement>(null);
  const chosen = options.find((option) => option.value === current);
  const shown = matching(options, list.query);

  // Like a native field, it goes back to where it started when its form is reset.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return undefined;
    const reset = () => setOwn(start);
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [start]);

  function pick(next: string) {
    list.close();
    if (next === current) return;
    // The hidden input has to hold the new value before anything reads the form.
    flushSync(() => setOwn(next));
    input.current?.dispatchEvent(new Event("input", { bubbles: true }));
    onValueChange?.(next);
  }

  return (
    <div className="relative min-w-0">
      <button
        {...list.triggerProps}
        aria-label={label}
        disabled={disabled}
        className={cn(TRIGGER, className)}
      >
        <span className="truncate">{chosen?.label}</span>
        <TriggerIcon />
      </button>
      {name &&
        (required ? (
          // A text field takes part in the form's checks, which a hidden one doesn't, and the
          // browser's message then points at the button.
          <input
            ref={input}
            name={name}
            value={current}
            required
            onChange={() => {}}
            onFocus={() => list.button.current?.focus()}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0"
          />
        ) : (
          <input ref={input} type="hidden" name={name} value={current} />
        ))}
      {list.open && (
        <Popup anchor={list.button} panel={list.panel} className={cn(list.searchable && "w-64")}>
          {list.searchable && (
            <PopupSearch
              label={label}
              value={list.query}
              onChange={list.setQuery}
              input={list.search}
              onKeyDown={(e) => {
                // Not the form's submit: the first match is what was meant.
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (shown.length > 0) pick(shown[0].value);
                } else list.onSearchKey(e);
              }}
            />
          )}
          <Options label={label} empty={shown.length === 0}>
            {shown.map((option) => (
              <button
                key={option.value}
                type="button"
                data-item
                aria-current={option === chosen || undefined}
                onClick={() => pick(option.value)}
                onKeyDown={list.onItemKey}
                className={cn(ITEM, "aria-[current]:font-medium aria-[current]:text-primary")}
              >
                <span className="flex-1 truncate">{option.label}</span>
                <Count option={option} />
                {option === chosen && <Check />}
              </button>
            ))}
          </Options>
        </Popup>
      )}
    </div>
  );
}

// For any number of values; none picked means all, which the button says as `all`, such as
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
  const list = useList(options.length);
  // In the order of the options, so the address doesn't change with the order of the clicks.
  const change = (values: string[]) =>
    onPickedChange(
      options.filter((option) => values.includes(option.value)).map((option) => option.value),
    );
  const labels = picked.map(
    (value) => options.find((option) => option.value === value)?.label ?? value,
  );
  const shownOptions = matching(options, list.query);
  const shown = shownOptions.map((option) => option.value);
  return (
    <div className="relative min-w-0">
      <button
        {...list.triggerProps}
        aria-label={label}
        className={cn(TRIGGER, picked.length > 0 && "border-primary/50 text-primary", className)}
      >
        <span className="truncate">
          {labels.length === 0
            ? all
            : labels.length <= 2
              ? labels.join("、")
              : `${labels[0]}等 ${labels.length} 个`}
        </span>
        <TriggerIcon />
      </button>
      {list.open && (
        <Popup anchor={list.button} panel={list.panel} className={cn(list.searchable && "w-64")}>
          {list.searchable && (
            <>
              <PopupSearch
                label={label}
                value={list.query}
                onChange={list.setQuery}
                input={list.search}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                  else list.onSearchKey(e);
                }}
              />
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
            </>
          )}
          <Options label={label} empty={shown.length === 0}>
            {shownOptions.map((option) => {
              const on = picked.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  data-item
                  aria-pressed={on}
                  onKeyDown={list.onItemKey}
                  onClick={() =>
                    change(
                      on
                        ? picked.filter((value) => value !== option.value)
                        : [...picked, option.value],
                    )
                  }
                  className={cn(ITEM, "group")}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card text-primary-foreground transition-colors group-aria-pressed:border-primary group-aria-pressed:bg-primary">
                    <Check className="size-3 stroke-3 opacity-0 transition-opacity group-aria-pressed:opacity-100" />
                  </span>
                  <span className="flex-1 truncate">{option.label}</span>
                  <Count option={option} />
                </button>
              );
            })}
          </Options>
        </Popup>
      )}
    </div>
  );
}

function Options({
  label,
  empty,
  children,
}: {
  label: string;
  empty: boolean;
  children: ReactNode;
}) {
  return empty ? (
    <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">没有匹配的{label}</p>
  ) : (
    <div className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain p-1">
      {children}
    </div>
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
      className="rounded-md px-2 py-1 text-xs text-primary hover:bg-primary-soft pointer-coarse:px-2.5 pointer-coarse:py-2"
    >
      {children}
    </button>
  );
}

// Turns over while the list is open.
function TriggerIcon() {
  return (
    <span className="flex text-subtle-foreground transition-transform duration-200 group-aria-expanded/trigger:rotate-180">
      <ChevronDown />
    </span>
  );
}

const TRIGGER =
  "group/trigger field flex items-center justify-between gap-2 pr-2 text-left aria-expanded:border-primary aria-expanded:ring-3 aria-expanded:ring-ring/15";
const ITEM =
  "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-2.5 text-left whitespace-nowrap outline-none select-none hover:bg-accent focus-visible:bg-accent pointer-coarse:py-2.5";
