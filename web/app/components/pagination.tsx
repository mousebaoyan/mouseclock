import type { ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { cn } from "~/cn";
import { ChevronLeft, ChevronRight } from "~/components/icons";
import { Select } from "~/components/ui/select";
import { PER_PAGE } from "../../server/platform/paging.ts";

// Pages of any list, as links that keep the rest of the address, so a page can be shared.
// `prefix` tells apart two lists on one page, such as "school_".
export function Pagination({
  total,
  page,
  perPage,
  prefix = "",
}: {
  total: number;
  page: number;
  perPage: number;
  prefix?: string;
}) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  // A short list needs no pages, unless the address asks for one past its end.
  if (total <= PER_PAGE[0] && page === 1) return null;
  const pages = Math.ceil(total / perPage);
  function href(to: { page: number; perPage?: number }) {
    const params = new URLSearchParams(search);
    // The note that a form was saved belongs to the page it was saved on.
    params.delete("saved");
    params.set(`${prefix}page`, String(to.page));
    if (to.perPage) params.set(`${prefix}per_page`, String(to.perPage));
    return `?${params}`;
  }
  const step =
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-[13px] tabular-nums pointer-coarse:h-10 pointer-coarse:min-w-10";
  return (
    <nav
      aria-label="分页"
      className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 text-[13px] text-muted-foreground"
    >
      <span>共 {total} 条</span>
      <div className="flex items-center gap-1 max-sm:order-last max-sm:w-full max-sm:justify-center">
        <PageStep to={page > 1 ? href({ page: page - 1 }) : null} label="上一页">
          <ChevronLeft />
        </PageStep>
        {numbers(page, pages).map((n, i) =>
          n === null ? (
            <span key={`gap${i}`} className="px-1">
              …
            </span>
          ) : n === page ? (
            <span
              key={n}
              aria-current="page"
              className={cn(step, "border border-primary bg-primary-soft font-medium text-primary")}
            >
              {n}
            </span>
          ) : (
            <Link
              key={n}
              to={href({ page: n })}
              viewTransition
              className={cn(step, "text-foreground hover:bg-accent")}
            >
              {n}
            </Link>
          ),
        )}
        <PageStep to={page < pages ? href({ page: page + 1 }) : null} label="下一页">
          <ChevronRight />
        </PageStep>
      </div>
      <Select
        aria-label="每页条数"
        value={String(perPage)}
        onValueChange={(value) => void navigate(href({ page: 1, perPage: Number(value) }))}
        options={PER_PAGE.map((n) => ({ value: String(n), label: `每页 ${n} 条` }))}
        className="h-8 w-auto text-[13px] pointer-coarse:h-10"
      />
    </nav>
  );
}

function PageStep({
  to,
  label,
  children,
}: {
  to: string | null;
  label: string;
  children: ReactNode;
}) {
  const className =
    "inline-flex size-8 items-center justify-center rounded-md text-foreground hover:bg-accent pointer-coarse:size-10";
  return to ? (
    <Link to={to} aria-label={label} viewTransition className={className}>
      {children}
    </Link>
  ) : (
    <span aria-hidden="true" className={cn(className, "opacity-35 hover:bg-transparent")}>
      {children}
    </span>
  );
}

// The first and last pages, and those next to this one; null where pages are skipped.
function numbers(page: number, pages: number) {
  const shown = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  return shown.flatMap((n, i) => (i > 0 && n - shown[i - 1] > 1 ? [null, n] : [n]));
}
