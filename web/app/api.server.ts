import { hc } from "hono/client";
import { createContext } from "react-router";
import { app, type ApiType } from "../server/app.ts";
import { asVisitor, type Visitor } from "../server/modules/accounts/routes.ts";

const FORWARDED = ["cookie", "user-agent", "x-real-ip", "origin", "authorization"];

// Loaders and actions call /api/v1 in-process as the visitor, so pages follow the same rules as
// the API and go through the same services (AGENTS.md, 分层).
export function createApi(request: Request, visitor: Visitor) {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return hc<ApiType>("http://localhost/api/v1", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(asVisitor(new Request(input, init), visitor)),
    headers,
  });
}

export const apiContext = createContext<ReturnType<typeof createApi>>();

// Logout's response carries the session cookie, which has to reach the browser.
export function cookiesFrom(res: Response) {
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}
