import { Link, useSearchParams } from "react-router";
import { cn } from "~/cn";
import { buttonVariants } from "~/components/ui/button";
import { PER_PAGE } from "../../server/platform/paging.ts";

// Pages of any list, as links that keep the rest of the address: they work before scripts load,
// and a page can be shared. `prefix` tells apart two lists on one page, such as "school_".
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
  const step = buttonVariants({ variant: "ghost", size: "sm", className: "tabular-nums" });
  return (
    <nav
      aria-label="分页"
      className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-0.5">
        {page > 1 && (
          <Link to={href({ page: page - 1 })} className={step}>
            上一页
          </Link>
        )}
        {numbers(page, pages).map((n, i) =>
          n === null ? (
            <span key={`gap${i}`} className="px-1 text-muted-foreground">
              …
            </span>
          ) : n === page ? (
            <span
              key={n}
              aria-current="page"
              className={buttonVariants({ size: "sm", className: "tabular-nums" })}
            >
              {n}
            </span>
          ) : (
            <Link key={n} to={href({ page: n })} className={step}>
              {n}
            </Link>
          ),
        )}
        {page < pages && (
          <Link to={href({ page: page + 1 })} className={step}>
            下一页
          </Link>
        )}
      </div>
      <div className="flex items-center gap-0.5 text-muted-foreground">
        <span className="mr-1.5">共 {total} 条，每页</span>
        {PER_PAGE.map((n) => (
          <Link
            key={n}
            to={href({ page: 1, perPage: n })}
            aria-current={n === perPage ? "true" : undefined}
            className={cn(step, n === perPage && "bg-secondary font-medium text-foreground")}
          >
            {n}
          </Link>
        ))}
      </div>
    </nav>
  );
}

// The first and last pages, and those next to this one; null where pages are skipped.
function numbers(page: number, pages: number) {
  const shown = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  return shown.flatMap((n, i) => (i > 0 && n - shown[i - 1] > 1 ? [null, n] : [n]));
}
