import { isRouteErrorResponse, Link, NavLink, useLocation, useRouteError } from "react-router";
import { cn } from "~/cn";
import { Drawer, Dropdown, menuItem } from "~/components/disclosure";
import { ChevronDown, LogOut, Menu as MenuIcon } from "~/components/icons";
import { LogoMark } from "~/components/logo";
import { buttonVariants } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { SITE_NAME } from "../../server/platform/site.ts";

type Me = {
  id: number;
  display_name: string;
  avatar_url: string | null;
  frozen: boolean;
  can: { edit: boolean; admin: boolean; owner: boolean };
};

// The pages a member can open, in the order the nav shows them.
function pagesFor(me: Me | null) {
  const main = [
    { to: "/", label: "项目总表" },
    { to: "/colleges", label: "院校清单" },
    ...(me && !me.frozen ? [{ to: "/crawl", label: "抓取看板" }] : []),
    ...(me?.can.edit ? [{ to: "/review", label: "审核" }] : []),
  ];
  const admin = [
    ...(me?.can.admin
      ? [
          { to: "/admin/colleges", label: "院校管理" },
          { to: "/admin/sources", label: "来源管理" },
        ]
      : []),
    ...(me?.can.owner ? [{ to: "/admin/settings", label: "系统设置" }] : []),
  ];
  return { main, admin };
}

// Wide screens: the site's name on the left, the pages in the middle and the account on the
// right. Phones keep the name and the account, and open the pages from a menu button. The menus
// are keyed by where the page is, so following a link closes them.
export function SiteHeader({ me }: { me: Me | null }) {
  const { pathname, search, key } = useLocation();
  const error = useRouteError();
  const loginNext = isRouteErrorResponse(error) && error.status === 404 ? "/" : pathname + search;
  const pages = pagesFor(me);
  const inAdmin = pages.admin.some((page) => pathname.startsWith(page.to));
  return (
    <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 md:grid md:grid-cols-[1fr_auto_1fr]">
        <Link
          to="/"
          className="touch-target flex items-center gap-2 justify-self-start text-lg leading-none font-semibold tracking-tight"
        >
          <LogoMark className="size-6" />
          {SITE_NAME}
        </Link>
        <nav aria-label="主导航" className="flex h-full items-stretch max-md:hidden">
          {pages.main.map((page) => (
            <NavLink key={page.to} to={page.to} end={page.to === "/"} className={navLink}>
              {page.label}
            </NavLink>
          ))}
          {pages.admin.length > 0 && (
            <div className="flex items-stretch">
              <Dropdown
                key={pathname}
                label="管理"
                align="start"
                className="min-w-40"
                triggerClassName={cn(
                  navLink({ isActive: inAdmin }),
                  "gap-1 outline-none aria-expanded:text-foreground",
                )}
                trigger={
                  <>
                    管理
                    <ChevronDown className="size-3.5" />
                  </>
                }
              >
                {pages.admin.map((page) => (
                  <Link
                    key={page.to}
                    to={page.to}
                    className={cn(menuItem, pathname.startsWith(page.to) && "text-primary")}
                  >
                    {page.label}
                  </Link>
                ))}
              </Dropdown>
            </div>
          )}
        </nav>
        <div className="flex items-center gap-1 justify-self-end">
          {me ? (
            <Account key={pathname} me={me} />
          ) : (
            // A page of the server, not of the router: it goes on to mousehole.
            <a
              href={`/login?next=${encodeURIComponent(loginNext)}`}
              className={buttonVariants({ size: "sm" })}
            >
              登录
            </a>
          )}
          <MobileNav key={key} pages={pages} />
        </div>
      </div>
    </header>
  );
}

function navLink({ isActive }: { isActive: boolean }) {
  return cn(
    "relative flex items-center px-3.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
    isActive &&
      "font-medium text-foreground after:absolute after:inset-x-3.5 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-primary",
  );
}

function Account({ me }: { me: Me }) {
  return (
    <Dropdown
      label="账号"
      align="end"
      className="w-52"
      triggerClassName={buttonVariants({ variant: "ghost", className: "gap-2 px-1.5 sm:pr-2.5" })}
      trigger={
        <>
          <UserAvatar user={me} className="size-7" />
          <span className="text-foreground max-sm:hidden">{me.display_name}</span>
          <ChevronDown className="size-3.5 max-sm:hidden" />
        </>
      }
    >
      <div className="px-2.5 pt-1.5 pb-2">
        <p className="font-medium">{me.display_name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {me.frozen ? "账号已冻结，仅可浏览部分内容" : "鼠洞账号"}
        </p>
      </div>
      <div className="mx-1 my-1 h-px bg-border" />
      {/* A full load leaves nothing of the member's in the page, such as the table the
              browser keeps for filtering. */}
      <form method="post" action="/logout">
        <button type="submit" className={menuItem}>
          <LogOut className="text-muted-foreground" />
          退出登录
        </button>
      </form>
    </Dropdown>
  );
}

function mobileLink({ isActive }: { isActive: boolean }) {
  return cn(
    "flex h-11 items-center rounded-md px-3 text-[15px]",
    isActive ? "bg-primary-soft font-medium text-primary" : "text-foreground hover:bg-accent",
  );
}

function MobileNav({ pages }: { pages: ReturnType<typeof pagesFor> }) {
  return (
    <Drawer
      label="导航"
      triggerClassName={buttonVariants({ variant: "ghost", size: "icon", className: "md:hidden" })}
      trigger={<MenuIcon className="size-5" />}
    >
      <nav aria-label="主导航" className="flex-1 space-y-1 overflow-y-auto overscroll-contain p-3">
        {pages.main.map((page) => (
          <NavLink key={page.to} to={page.to} end={page.to === "/"} className={mobileLink}>
            {page.label}
          </NavLink>
        ))}
        {pages.admin.length > 0 && (
          <>
            <p className="px-3 pt-4 pb-1 text-xs text-muted-foreground">管理</p>
            {pages.admin.map((page) => (
              <NavLink key={page.to} to={page.to} className={mobileLink}>
                {page.label}
              </NavLink>
            ))}
          </>
        )}
      </nav>
    </Drawer>
  );
}
