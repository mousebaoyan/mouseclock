import { createRoute, z } from "@hono/zod-openapi";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { can } from "../../platform/access.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import {
  clientIp,
  createRouter,
  errorResponse,
  Int,
  unix,
  UnixSeconds,
  type AppEnv,
} from "../../platform/http.ts";
import { log } from "../../platform/log.ts";
import { newToken } from "../../platform/tokens.ts";
import { authorizeUrl, exchangeCode, fetchProfile } from "./mousehole.ts";
import { endSession, login, profileOf, resolveSession, SESSION_TTL_MS } from "./service.ts";

// Prefixed: in development mousehole's `session` sits on the same localhost (api.md §2).
const SESSION_COOKIE = "mouseclock_session";
// What a login started here needs back when mousehole returns.
const LOGIN_COOKIE = "mouseclock_login";
// Set when a login starts and kept until the browser closes: the automatic login is tried once.
const TRIED_COOKIE = "mouseclock_login_tried";
const LOGIN_TTL_S = 600;
const secure = new URL(env.PUBLIC_URL).protocol === "https:";

function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

function markTried(c: Context) {
  setCookie(c, TRIED_COOKIE, "1", { httpOnly: true, secure, sameSite: "Lax", path: "/" });
}

// Only paths on this site, so a link to /login can't send people elsewhere afterwards.
function localPath(next: string | undefined) {
  const url = new URL(next ?? "/", env.PUBLIC_URL);
  return url.origin === env.PUBLIC_URL ? url.pathname + url.search : "/";
}

function startLogin(c: Context, next: string, silent: boolean) {
  const state = newToken();
  const verifier = newToken();
  setCookie(c, LOGIN_COOKIE, new URLSearchParams({ state, verifier, next }).toString(), {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/login",
    maxAge: LOGIN_TTL_S,
  });
  markTried(c);
  return c.redirect(authorizeUrl(state, verifier, silent));
}

const LoginCookie = z.object({ state: z.string(), verifier: z.string(), next: z.string() });

export type Visitor = AppEnv["Variables"];

// A page's loaders call the API in-process (app/api.server.ts) as the visitor the page request
// was already found to be, which spares each call looking the session up again. Kept out of the
// headers, which anyone could send.
const visitors = new WeakMap<Request, Visitor>();

export function asVisitor(request: Request, visitor: Visitor) {
  visitors.set(request, visitor);
  return request;
}

// Runs for every request, pages included.
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const known = visitors.get(c.req.raw);
  if (known) {
    c.set("viewer", known.viewer);
    c.set("sessionId", known.sessionId);
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  const found = token ? await resolveSession(token) : null;
  c.set("viewer", found?.viewer ?? null);
  c.set("sessionId", found?.id ?? null);
  await next();

  // Written after next(): React Router returns its own Response, which drops headers set before.
  // Login and logout write this cookie themselves, and they win.
  if (!token || c.res.headers.getSetCookie().some((v) => v.startsWith(`${SESSION_COOKIE}=`)))
    return;
  if (!found) deleteCookie(c, SESSION_COOKIE, { path: "/" });
  else if (found.renewed) setSessionCookie(c, token);
});

// Design §6.1: a browser opening a page without a session goes by mousehole once, and comes
// back logged in if it is logged in there. Only page loads a browser makes say they are one
// (Fetch Metadata), so search engines and scripts aren't sent round.
export const autoLogin = createMiddleware<AppEnv>(async (c, next) => {
  if (
    c.var.viewer ||
    getCookie(c, TRIED_COOKIE) ||
    c.req.method !== "GET" ||
    c.req.header("sec-fetch-mode") !== "navigate" ||
    c.req.header("sec-fetch-dest") !== "document" ||
    c.req.path.startsWith("/api/") ||
    c.req.path.startsWith("/login")
  ) {
    return next();
  }
  return startLogin(c, c.req.path + new URL(c.req.url).search, true);
});

// The OAuth round trip of api.md §2; pages, not API.
export const loginRoutes = new Hono<AppEnv>()
  .get("/login", (c) => startLogin(c, localPath(c.req.query("next")), false))
  .get("/login/callback", async (c) => {
    const saved = LoginCookie.safeParse(
      Object.fromEntries(new URLSearchParams(getCookie(c, LOGIN_COOKIE))),
    );
    deleteCookie(c, LOGIN_COOKIE, { path: "/login" });
    // A stale or forged answer, or one from another server (RFC 9207): the visitor stays a guest.
    if (
      !saved.success ||
      c.req.query("state") !== saved.data.state ||
      c.req.query("iss") !== env.MOUSEHOLE_URL
    ) {
      return c.redirect("/");
    }
    const next = localPath(saved.data.next);
    const code = c.req.query("code");
    if (code === undefined) {
      const error = c.req.query("error");
      // login_required is someone not logged in to mousehole; anything else is worth a look.
      if (error !== "login_required") log("warn", "Mousehole turned a login down", { error });
      return c.redirect(next);
    }
    const token = await exchangeCode(code, saved.data.verifier);
    const profile = await fetchProfile(token);
    if (!profile) throw new Error("Mousehole refused the token it had just issued");
    const session = await login(profile, token, {
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? "",
    });
    setSessionCookie(c, session);
    return c.redirect(next);
  });

const Me = z
  .object({
    id: Int,
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    level: Int,
    role: z.string(),
    frozen: z.boolean(),
    muted: z.boolean(),
    muted_until: UnixSeconds.nullable().openapi({ description: "没禁言或永久禁言为 null" }),
    can: z
      .object({ edit: z.boolean(), admin: z.boolean(), owner: z.boolean() })
      .openapi({ description: "按总体设计 §6.2 算好的权限，页面据此显示按钮" }),
  })
  .openapi("Me");

export const accountsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/me",
      summary: "自己的资料",
      responses: {
        200: { description: "自己的资料", content: { "application/json": { schema: Me } } },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => {
      const viewer = c.var.viewer;
      if (!viewer) throw new AppError(401, "login_required", "请先登录");
      const { muted_until, ...profile } = await profileOf(viewer.id);
      return c.json(
        {
          id: viewer.id,
          ...profile,
          muted: viewer.muted,
          muted_until: viewer.muted && muted_until ? unix(muted_until) : null,
          can: {
            edit: can(viewer, "edit"),
            admin: can(viewer, "admin"),
            owner: can(viewer, "owner"),
          },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/auth/logout",
      summary: "退出鼠钟；鼠洞的登录不受影响",
      responses: { 204: { description: "已退出" } },
    }),
    async (c) => {
      if (c.var.sessionId !== null) await endSession(c.var.sessionId);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      // Otherwise the next page would log them straight back in through mousehole.
      markTried(c);
      return c.body(null, 204);
    },
  );
