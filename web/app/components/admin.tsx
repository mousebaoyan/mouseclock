import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { Link, NavLink, useSearchParams } from "react-router";
import { buttonVariants } from "~/components/ui/button";

export const inputClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25";
export const panelClass = "rounded-xl border border-border bg-card p-4 sm:p-5";
export const linkClass = "text-link underline-offset-4 hover:underline";
export const TIERS = [
  { value: "c9", label: "C9" },
  { value: "985", label: "985" },
  { value: "211", label: "211" },
  { value: "double_first_class", label: "双一流" },
];
export const KINDS = [
  { value: "college", label: "学院" },
  { value: "institute", label: "研究所" },
  { value: "graduate_school", label: "研究生院" },
];

export function AdminPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-3 py-6 sm:px-5">
      <title>{`${title} · 鼠钟`}</title>
      <header>
        <p className="mb-2 text-sm font-medium text-brand-strong">管理</p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </header>
      <nav aria-label="管理页面" className="flex gap-2 border-b border-border pb-4">
        <NavLink
          to="/admin/colleges"
          className={({ isActive }) =>
            buttonVariants({ variant: isActive ? "secondary" : "ghost" })
          }
        >
          院校清单
        </NavLink>
        <NavLink
          to="/admin/sources"
          className={({ isActive }) =>
            buttonVariants({ variant: isActive ? "secondary" : "ghost" })
          }
        >
          来源管理
        </NavLink>
      </nav>
      {children}
    </main>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": hint ? hintId : undefined })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function FormMessage({ error, saved }: { error?: string; saved: boolean }) {
  if (error)
    return (
      <p
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        {error}
      </p>
    );
  if (saved)
    return (
      <output className="block rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success">
        已保存，操作记录已写入。
      </output>
    );
  return null;
}

export function Pagination({
  page,
  nextPage,
  name = "page",
}: {
  page: number;
  nextPage: number | null;
  name?: string;
}) {
  const [search] = useSearchParams();
  function href(value: number) {
    const params = new URLSearchParams(search);
    params.set(name, String(value));
    params.delete("saved");
    return `?${params}`;
  }
  if (page === 1 && nextPage === null) return null;
  return (
    <nav aria-label="分页" className="mt-4 flex items-center justify-end gap-3 text-sm">
      {page > 1 && (
        <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={href(page - 1)}>
          上一页
        </Link>
      )}
      <span className="text-muted-foreground">第 {page} 页</span>
      {nextPage !== null && (
        <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={href(nextPage)}>
          下一页
        </Link>
      )}
    </nav>
  );
}

export function CrawlTime({ value }: { value: number }) {
  return (
    <time dateTime={new Date(value * 1000).toISOString()}>
      {new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value * 1000))}
    </time>
  );
}
