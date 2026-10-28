import { Form, Link, NavLink, useLocation } from "react-router";
import { cn } from "~/cn";
import { AlarmClock, LogOut } from "~/components/icons";
import { buttonVariants } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { SITE_NAME } from "../../server/platform/site.ts";

type Me = {
  id: number;
  display_name: string;
  avatar_url: string | null;
  frozen: boolean;
  can: { admin: boolean };
};

function navLink({ isActive }: { isActive: boolean }) {
  return cn(
    "rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap text-foreground/70 hover:bg-accent hover:text-foreground",
    isActive && "font-medium text-foreground",
  );
}

// Pages join the nav as they are built.
export function SiteHeader({ me }: { me: Me | null }) {
  const { pathname, search } = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:px-5">
        <Link to="/" className="flex shrink-0 items-center gap-1.5 text-lg font-semibold">
          <AlarmClock className="size-5 text-brand-strong" />
          {SITE_NAME}
        </Link>
        <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          <NavLink to="/" end className={navLink}>
            总表
          </NavLink>
          {me && !me.frozen && (
            <NavLink to="/crawl-runs" className={navLink}>
              抓取记录
            </NavLink>
          )}
          {me?.can.admin && (
            <NavLink to="/admin/colleges" className={navLink}>
              院校清单
            </NavLink>
          )}
          {me?.can.admin && (
            <NavLink to="/admin/sources" className={navLink}>
              来源管理
            </NavLink>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {me ? (
            <>
              <UserAvatar user={me} className="size-8" />
              <span className="hidden text-sm sm:inline">{me.display_name}</span>
              {me.frozen && <span className="text-meta text-muted-foreground">已冻结</span>}
              <Form method="post" action="/logout">
                <button
                  type="submit"
                  aria-label="退出"
                  title="退出"
                  className={buttonVariants({ variant: "ghost", size: "icon" })}
                >
                  <LogOut />
                </button>
              </Form>
            </>
          ) : (
            // A page of the server, not of the router: it goes on to mousehole.
            <a
              href={`/login?next=${encodeURIComponent(pathname + search)}`}
              className={buttonVariants()}
            >
              登录
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
