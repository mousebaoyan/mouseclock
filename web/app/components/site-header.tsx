import { useEffect, useSyncExternalStore } from "react";
import { isRouteErrorResponse, Link, NavLink, useLocation, useRouteError } from "react-router";
import { cn } from "~/cn";
import { Drawer, Dropdown, menuItem } from "~/components/disclosure";
import { Bell, ChevronDown, LogOut, Menu as MenuIcon, User } from "~/components/icons";
import { LogoMark } from "~/components/logo";
import { buttonVariants } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { SITE_NAME } from "../../server/platform/site.ts";

type Me = {
  id: number;
  display_name: string;
  avatar_url: string | null;
  frozen: boolean;
  unseen_messages: number;
  can: { edit: boolean; admin: boolean; owner: boolean };
};

// The pages a member can open, in the order the nav shows them.
function pagesFor(me: Me | null) {
  const main = [
    { to: "/", label: "项目总表" },
    { to: "/colleges", label: "院校清单" },
    ...(me && !me.frozen
      ? [
          { to: "/crawl", label: "抓取看板" },
          { to: "/edits", label: "修改记录" },
        ]
      : []),
    ...(me?.can.edit ? [{ to: "/review", label: "审核" }] : []),
  ];
  const admin = [
    ...(me?.can.admin
      ? [
          { to: "/admin/colleges", label: "院校管理" },
          { to: "/admin/sources", label: "来源管理" },
          { to: "/admin/users", label: "修改权限" },
        ]
      : []),
    ...(me?.can.owner ? [{ to: "/admin/settings", label: "系统设置" }] : []),
  ];
  // Reached from the account menu; on phones the drawer has it too (design §10.2).
  const mine = me && !me.frozen ? [{ to: "/me", label: "我的" }] : [];
  return { main, admin, mine };
}

// What opens an editor, a question or a notice on a page, rather than where its list is.
const OPENED = ["edit", "edit_school", "edit_college", "saved", "probe", "adopt", "revoke"];

function unchanging() {
  return () => {};
}

// Where each page was last left in this tab: a list's filters, sort and page live in its address
// (filters.tsx), so the nav goes back to it as it was. An address the page failed on is no place
// to go back to, so the page starts over. The tab's storage is the browser's, so the page as the
// server renders it, and as it hydrates, links to the other lists as they start.
function useLeftAt(failed: boolean) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  for (const name of OPENED) params.delete(name);
  const here = failed || params.size === 0 ? "" : `?${params}`;
  const hydrated = useSyncExternalStore(
    unchanging,
    () => true,
    () => false,
  );
  useEffect(() => sessionStorage.setItem(`left:${pathname}`, here), [pathname, here]);
  return (to: string) =>
    to + (to === pathname ? here : hydrated ? (sessionStorage.getItem(`left:${to}`) ?? "") : "");
}

// Wide screens: the site's name on the left, the pages in the middle and the account on the
// right. Phones keep the name and the account, and open the pages from a menu button. The
// dropdowns are keyed by where the page is, so following a link closes them; the drawer closes
// itself.
export function SiteHeader({ me }: { me: Me | null }) {
  const { pathname, search } = useLocation();
  const error = useRouteError();
  const loginNext = isRouteErrorResponse(error) && error.status === 404 ? "/" : pathname + search;
  const pages = pagesFor(me);
  const leftAt = useLeftAt(error != null);
  const inAdmin = pages.admin.some((page) => pathname.startsWith(page.to));
  return (
    <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 md:grid md:grid-cols-[1fr_auto_1fr]">
        <Link
          to={leftAt("/")}
          className="touch-target flex items-center gap-2 justify-self-start text-lg leading-none font-semibold tracking-tight"
        >
          <LogoMark className="size-6" />
          {SITE_NAME}
        </Link>
        <nav aria-label="主导航" className="flex h-full items-stretch max-md:hidden">
          {pages.main.map((page) => (
            <NavLink key={page.to} to={leftAt(page.to)} end={page.to === "/"} className={navLink}>
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
                    to={leftAt(page.to)}
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
          {me && !me.frozen && <Messages unseen={me.unseen_messages} />}
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
          <MobileNav pages={pages} leftAt={leftAt} />
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

// The bell with how many messages are unseen (design §11.1).
function Messages({ unseen }: { unseen: number }) {
  return (
    <NavLink
      to="/messages"
      aria-label={unseen > 0 ? `消息，${unseen} 条未读` : "消息"}
      className={({ isActive }) =>
        buttonVariants({
          variant: "ghost",
          size: "icon",
          className: cn("relative", isActive && "text-primary"),
        })
      }
    >
      <Bell className="size-5" />
      {unseen > 0 && (
        <span className="absolute top-1 right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 font-medium text-white tabular-nums">
          {unseen > 99 ? "99+" : unseen}
        </span>
      )}
    </NavLink>
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
      {!me.frozen && (
        <Link to="/me" className={menuItem}>
          <User className="text-muted-foreground" />
          我的
        </Link>
      )}
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

function MobileNav({
  pages,
  leftAt,
}: {
  pages: ReturnType<typeof pagesFor>;
  leftAt: (to: string) => string;
}) {
  return (
    <Drawer
      label="导航"
      triggerClassName={buttonVariants({ variant: "ghost", size: "icon", className: "md:hidden" })}
      trigger={<MenuIcon className="size-5" />}
    >
      <nav aria-label="主导航" className="flex-1 space-y-1 overflow-y-auto overscroll-contain p-3">
        {pages.main.map((page) => (
          <NavLink key={page.to} to={leftAt(page.to)} end={page.to === "/"} className={mobileLink}>
            {page.label}
          </NavLink>
        ))}
        {pages.mine.map((page) => (
          <NavLink key={page.to} to={page.to} className={mobileLink}>
            {page.label}
          </NavLink>
        ))}
        {pages.admin.length > 0 && (
          <>
            <p className="px-3 pt-4 pb-1 text-xs text-muted-foreground">管理</p>
            {pages.admin.map((page) => (
              <NavLink key={page.to} to={leftAt(page.to)} className={mobileLink}>
                {page.label}
              </NavLink>
            ))}
          </>
        )}
      </nav>
    </Drawer>
  );
}
