import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Search } from "~/components/icons";
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
  function set(name: string, value: string, typed = false) {
    void navigate(hrefWith(name, value ? [value] : []), {
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
    <label className="relative min-w-0 flex-[1_1_16rem]">
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

// Choices any number of which can be picked; none picked means all.
export function ChipGroup({
  name,
  label,
  choices,
  picked,
}: {
  name: string;
  label: string;
  choices: readonly { value: string; label: string; color: TagColor }[];
  picked: string[];
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
        >
          {choice.label}
        </Chip>
      ))}
    </fieldset>
  );
}

// The box above a list: a search and dropdowns on top, then labelled rows of choices. `clear`
// is the address without filters, shown once any is set.
export function FilterBar({
  top,
  rows,
  clear,
}: {
  top: ReactNode;
  rows: { label: string; content: ReactNode }[];
  clear: string | null;
}) {
  return (
    <section aria-label="筛选" className="rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap gap-2 p-3 sm:p-4">{top}</div>
      {rows.length > 0 && (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-t p-3 sm:p-4">
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
