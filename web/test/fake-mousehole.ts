import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";

// Mousehole's OAuth and /me as its api.md §8.3 describes them, so logging in needs neither the
// real site nor a real account. Tests send fetch here (test/setup.ts); the dev server answers
// with it when MOUSEHOLE_URL points into itself (vite.config.ts).

export type FakeUser = {
  id: number;
  display_name: string;
  avatar_url: string | null;
  level: number;
  role: "user" | "moderator" | "admin" | "owner";
  member_status: "member" | "frozen";
  restriction: { type: "mute" | "ban"; until: number | null } | null;
  qq: number | null;
};

const person = {
  avatar_url: null,
  role: "user",
  member_status: "member",
  restriction: null,
} satisfies Partial<FakeUser>;

// One of each that design §6.2 tells apart. Tests may add their own.
export const fakeUsers: FakeUser[] = [
  { ...person, id: 1, display_name: "鼠鼠", level: 1, qq: 10001 },
  { ...person, id: 2, display_name: "仓鼠", level: 3, qq: 10002 },
  { ...person, id: 3, display_name: "管理鼠", level: 4, role: "admin", qq: 10003 },
  { ...person, id: 4, display_name: "站长", level: 5, role: "owner", qq: null },
  {
    ...person,
    id: 5,
    display_name: "禁言鼠",
    level: 3,
    restriction: { type: "mute", until: null },
    qq: 10005,
  },
  { ...person, id: 6, display_name: "冻结鼠", level: 2, member_status: "frozen", qq: 10006 },
];

// Their tokens answer 401, as for someone banned or who took the access back.
export const revoked = new Set<number>();

// Who is logged in to this mousehole.
const COOKIE = "fake_mousehole_user";

export function fakeMousehole(config: {
  url: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const grants = new Map<string, { userId: number; challenge: string }>();

  return new Hono()
    .basePath(new URL(config.url).pathname)
    .get("/oauth/authorize", (c) => {
      const query = c.req.query();
      if (query.client_id !== config.clientId || query.redirect_uri !== config.redirectUri) {
        return c.text("client_id 或 redirect_uri 不对", 400);
      }
      const back = (params: Record<string, string>) =>
        c.redirect(
          `${config.redirectUri}?${new URLSearchParams({ ...params, state: query.state, iss: config.url })}`,
        );
      const grant = (userId: number) => {
        const code = randomBytes(16).toString("base64url");
        grants.set(code, { userId, challenge: query.code_challenge });
        return back({ code });
      };

      if (query.as) {
        setCookie(c, COOKIE, query.as, { httpOnly: true, path: "/" });
        return grant(Number(query.as));
      }
      if (query.prompt === "none") {
        const current = getCookie(c, COOKIE);
        return current ? grant(Number(current)) : back({ error: "login_required" });
      }
      // Unlike the real one, logging in always asks who to be, so switching is one click.
      const as = (id: number) => `?${new URLSearchParams({ ...query, as: String(id) })}`;
      return c.html(
        html`<!doctype html>
          <meta charset="utf-8" />
          <title>假的鼠洞</title>
          <h1>假的鼠洞：以谁的身份登录</h1>
          <ul>
            ${fakeUsers.map(
              (u) =>
                html`<li>
                  <a href="${as(u.id)}">${u.display_name}</a>
                  L${u.level} ${u.role} ${u.member_status} ${u.restriction?.type ?? ""}
                </li>`,
            )}
          </ul>`,
      );
    })
    .post("/oauth/token", async (c) => {
      const form = Object.fromEntries(new URLSearchParams(await c.req.text()));
      if (form.client_id !== config.clientId || form.client_secret !== config.clientSecret) {
        return c.json({ error: "invalid_client" }, 401);
      }
      const found = grants.get(form.code);
      grants.delete(form.code);
      const challenge = createHash("sha256").update(form.code_verifier).digest("base64url");
      if (!found || form.redirect_uri !== config.redirectUri || challenge !== found.challenge) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      return c.json({
        access_token: `fake-${found.userId}`,
        token_type: "Bearer",
        scope: "profile",
      });
    })
    .get("/api/v1/me", (c) => {
      const id = Number(c.req.header("authorization")?.match(/^Bearer fake-(\d+)$/)?.[1]);
      const user = fakeUsers.find((u) => u.id === id);
      if (!user || revoked.has(id)) {
        return c.json({ error: { code: "invalid_token", message: "令牌无效" } }, 401);
      }
      return c.json(user);
    });
}
