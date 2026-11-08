import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/cn";
import { ChevronRight } from "~/components/icons";

// Every page has the same width, the header's.
export const WIDTH = "mx-auto w-full max-w-7xl px-4 sm:px-6";

// The frame every page shares: the ink band under the header with where the page sits, its title
// and what it is for, any actions on the right and, on some pages, more beneath; the content's
// first card overlaps the band's lower edge.
export function Page({
  title,
  description,
  crumbs,
  actions,
  hero,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: { to: string; label: string }[];
  actions?: ReactNode;
  hero?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main>
      <div className="ink bg-band">
        <div className={cn(WIDTH, "space-y-6 pt-7 pb-16 sm:pt-9 sm:pb-20")}>
          <div className="space-y-2.5">
            {crumbs && (
              <nav aria-label="位置" className="flex flex-wrap items-center gap-1 text-[13px]">
                {crumbs.map((crumb) => (
                  <span key={crumb.to} className="flex items-center gap-1">
                    <Link to={crumb.to} className="text-muted-foreground hover:text-foreground">
                      {crumb.label}
                    </Link>
                    <ChevronRight className="size-3.5 text-subtle-foreground" />
                  </span>
                ))}
              </nav>
            )}
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <div className="min-w-0 max-w-3xl">
                <h1 className="text-2xl font-bold tracking-tight text-pretty sm:text-[2rem] sm:leading-tight">
                  {title}
                </h1>
                {description && (
                  <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {description}
                  </div>
                )}
              </div>
              {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
          </div>
          {hero}
        </div>
      </div>
      <div className={cn(WIDTH, "relative -mt-10 space-y-5 pb-14 sm:-mt-12")}>{children}</div>
    </main>
  );
}

// A white block of a page with an optional title bar; `flush` leaves out the padding for lists
// and tables that run to its edges.
export function Panel({
  title,
  description,
  actions,
  flush,
  id,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-20 overflow-hidden rounded-xl border bg-card shadow-card",
        className,
      )}
    >
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description && (
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : "p-4 sm:p-5"}>{children}</div>
    </section>
  );
}

// Labelled facts side by side, which wrap onto more rows on narrow screens.
export function Facts({
  items,
  className,
}: {
  items: { label: string; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="bg-card px-4 py-3.5 sm:px-5">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1.5 text-[15px] font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// What a list says when it has nothing to show.
export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed bg-card px-6 py-14 text-center text-sm text-muted-foreground shadow-card",
        className,
      )}
    >
      {children}
    </div>
  );
}
