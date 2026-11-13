import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { cn } from "~/cn";
import { Filter, Search } from "~/components/icons";
import { Chip, type TagColor } from "~/components/tags";
import { buttonVariants } from "~/components/ui/button";

// Lists' filters live in the address, so a link shares them and the back button undoes them;
// changing one goes back to the first page.
export function useFilters() {
  const navigate = useNavigate();
  const { search } = useLocation();
  function hrefWith(name: string, values: string[]) {
    const params = new URLSearchParams(search);
    params.delete("page");
    params.delete(name);
    for (const value of values) params.append(name, value);
    return params.size > 0 ? `?${params}` : "?";
  }
  // A list of values for a filter that takes any number; the empty value drops a filter.
  function set(name: string, value: string | string[], typed = false) {
    const values = typeof value === "string" ? [value].filter(Boolean) : value;
    void navigate(hrefWith(name, values), {
      replace: true,
      preventScrollReset: true,
      state: typed ? { typed } : undefined,
    });
  }
  return { hrefWith, set };
}

// Filters as it types. It keeps what is being typed while its own changes come back through
// the address; any other change, such as 清除筛选, starts it again from the address.
export function SearchBox({ value, placeholder }: { value: string; placeholder: string }) {
  const { set } = useFilters();
  const location = useLocation();
  const state: unknown = location.state;
  const typed = typeof state === "object" && state !== null && "typed" in state;
  const [key, setKey] = useState(location.key);
  if (!typed && key !== location.key) setKey(location.key);
  return (
    <label className="relative min-w-0 flex-[1_1_10rem]">
      <span className="sr-only">搜索</span>
      <Search className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle-foreground" />
      <input
        key={key}
        type="search"
        defaultValue={value}
        onChange={(e) => set("q", e.currentTarget.value.trim(), true)}
        placeholder={placeholder}
        className="field pl-9"
      />
    </label>
  );
}

// Choices any number of which can be picked; none picked means all. `counts` says how many each
// would show.
export function ChipGroup({
  name,
  label,
  choices,
  picked,
  counts,
}: {
  name: string;
  label: string;
  choices: readonly { value: string; label: string; color: TagColor }[];
  picked: string[];
  counts?: Partial<Record<string, number>>;
}) {
  const { hrefWith } = useFilters();
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-2">
      <legend className="sr-only">{label}</legend>
      {choices.map((choice) => (
        <Chip
          key={choice.value}
          to={hrefWith(
            name,
            picked.includes(choice.value)
              ? picked.filter((value) => value !== choice.value)
              : [...picked, choice.value],
          )}
          on={picked.includes(choice.value)}
          color={choice.color}
          count={counts && (counts[choice.value] ?? 0)}
        >
          {choice.label}
        </Chip>
      ))}
    </fieldset>
  );
}

// The box above a list: a search and dropdowns on top, then labelled rows of choices. On phones
// all but the search fold under 筛选, so the list starts on the first screen; they start open
// when one of them is set (`active`), so a shared link shows why the list is shorter. `clear` is the
// address without filters, shown once any is set.
export function FilterBar({
  search,
  selects,
  rows,
  active,
  clear,
}: {
  search: ReactNode;
  selects: ReactNode;
  rows: { label: string; content: ReactNode }[];
  active: boolean;
  clear: string | null;
}) {
  const [open, setOpen] = useState(active);
  return (
    <section aria-label="筛选" className="rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap gap-2 p-3 sm:p-4">
        {search}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={buttonVariants({
            variant: "outline",
            className: cn("sm:hidden", open && "border-primary/40 bg-primary-soft text-primary"),
          })}
        >
          <Filter />
          筛选
          {active && <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />}
        </button>
        <div
          className={cn(
            "grid flex-[1_1_100%] grid-cols-2 gap-2 sm:flex sm:flex-none",
            open ? "max-sm:drop-in" : "max-sm:hidden",
          )}
        >
          {selects}
        </div>
      </div>
      {rows.length > 0 && (
        <div
          className={cn(
            "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-t p-3 sm:p-4",
            open ? "max-sm:drop-in" : "max-sm:hidden",
          )}
        >
          {rows.map((row, i) => (
            <div key={row.label} className="contents">
              <span aria-hidden="true" className="text-[13px] text-muted-foreground">
                {row.label}
              </span>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                {row.content}
                {i === rows.length - 1 && clear !== null && (
                  <Link
                    to={clear}
                    replace
                    preventScrollReset
                    viewTransition
                    className={buttonVariants({ variant: "ghost", size: "xs" })}
                  >
                    清除筛选
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// The address with only `keep` of the current one, such as the cohort and the page size.
export function keepOnly(search: string, keep: string[]) {
  const from = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const name of keep) {
    const value = from.get(name);
    if (value) params.set(name, value);
  }
  return params.size > 0 ? `?${params}` : "?";
}
