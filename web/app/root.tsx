import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigation,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/root.ts";
import { apiContext } from "./api.server.ts";
import { SiteHeader } from "~/components/site-header";
import { buttonVariants } from "~/components/ui/button";
import "./app.css";

// Runs before first paint so the page never flashes the wrong theme. Same key as mousehole and
// the main site.
const themeScript = `try{document.documentElement.dataset.theme=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch{}`;

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).client.me.$get();
  return { me: res.status === 200 ? await res.json() : null };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Missing when the page failed before the root loader ran.
  const me = useRouteLoaderData<typeof loader>("root")?.me ?? null;
  return (
    // themeScript sets data-theme before hydration; this only silences that one attribute.
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#fefdfb" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#161b1a" media="(prefers-color-scheme: dark)" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        <SiteHeader me={me} />
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const loading = useNavigation().state === "loading";
  return (
    <>
      {loading && <div aria-hidden="true" className="nav-progress" />}
      <Outlet />
    </>
  );
}

const TITLES: Partial<Record<number, string>> = {
  401: "登录后查看",
  403: "没有权限",
  404: "页面不存在",
};

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const response = isRouteErrorResponse(error) ? error : null;
  const title = (response && TITLES[response.status]) ?? "页面出错";
  // A 404's data is the router's own English; others carry what a loader threw for people.
  const detail =
    response?.status === 404
      ? "链接有误，或内容已被删除。"
      : typeof response?.data === "string"
        ? response.data
        : "请稍后重试。";
  return (
    <main className="mx-auto max-w-6xl px-3 py-6 sm:px-5">
      <title>{title}</title>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted-foreground">{detail}</p>
      {response?.status === 401 && (
        <a href="/login" className={buttonVariants({ className: "mt-4" })}>
          登录
        </a>
      )}
      {response?.status === 404 && (
        <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-4" })}>
          返回总表
        </Link>
      )}
    </main>
  );
}
