import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root.ts";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="mx-auto max-w-3xl p-6">
      <title>{notFound ? "页面不存在" : "页面出错"}</title>
      <h1 className="text-2xl font-semibold">{notFound ? "页面不存在" : "页面出错"}</h1>
      <p className="mt-2 text-neutral-500">
        {notFound ? "链接有误，或内容已被删除。" : "请稍后重试。"}
      </p>
    </main>
  );
}
