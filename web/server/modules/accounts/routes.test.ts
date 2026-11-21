import { testClient } from "hono/testing";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { fakeUsers, revoked, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { fetchProfile } from "./mousehole.ts";
import { refreshUsers } from "./service.ts";

const api = testClient(app).api.v1;

// What a browser sends when it opens a page (Fetch Metadata).
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

// One browser's cookies for this site.
type Jar = Map<string, string>;

function cookieHeader(jar: Jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function visit(
  jar: Jar,
  path: string,
  { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {},
) {
  const res = await app.request(path, {
    method,
    headers: { ...headers, cookie: cookieHeader(jar) },
  });
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return res;
}

function location(res: Response) {
  const to = res.headers.get("location");
  if (to === null) throw new Error(`no redirect but status ${res.status}`);
  return to;
}

// Takes a login that `start` began through the fake mousehole and back, and returns where it
// lands. `loggedIn`: who the browser is logged in to mousehole as; `pick`: who to log in as on
// mousehole's login page.
async function roundTrip(jar: Jar, start: Response, loggedIn: number | null, pick?: number) {
  const authorize = new URL(location(start));
  if (pick !== undefined) authorize.searchParams.set("as", String(pick));
  const atMousehole = await fetch(authorize, {
    headers: loggedIn === null ? {} : { cookie: `fake_mousehole_user=${loggedIn}` },
    redirect: "manual",
  });
  const callback = new URL(location(atMousehole));
  expect(callback.origin).toBe(env.PUBLIC_URL);
  return location(await visit(jar, callback.pathname + callback.search));
}

async function me(jar: Jar) {
  const res = await api.me.$get({}, { headers: { cookie: cookieHeader(jar) } });
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res.json();
}

test("a page opened without a session logs in through mousehole, back where it was", async () => {
  const jar: Jar = new Map();
  const start = await visit(jar, "/programs?kind=summer_camp", { headers: NAVIGATE });
  const authorize = new URL(location(start));
  expect(authorize.origin + authorize.pathname).toBe(`${env.MOUSEHOLE_URL}/oauth/authorize`);
  expect(authorize.searchParams.get("prompt")).toBe("none");
  expect(await roundTrip(jar, start, 2)).toBe("/programs?kind=summer_camp");

  expect(await me(jar)).toMatchObject({
    display_name: "仓鼠",
    level: 3,
    frozen: false,
    muted: false,
    can: { edit: true, admin: false, owner: false },
  });
  const user = await db
    .selectFrom("users")
    .select(["qq", "mousehole_token"])
    .where("mousehole_id", "=", 2)
    .executeTakeFirstOrThrow();
  expect(user).toEqual({ qq: 10002, mousehole_token: "fake-2" });
  expect((await visit(jar, "/", { headers: NAVIGATE })).headers.get("location")).toBeNull();
});

test("someone not logged in to mousehole stays a guest, until they click to log in", async () => {
  const jar: Jar = new Map();
  expect(await roundTrip(jar, await visit(jar, "/colleges/1", { headers: NAVIGATE }), null)).toBe(
    "/colleges/1",
  );
  expect((await api.me.$get({}, { headers: { cookie: cookieHeader(jar) } })).status).toBe(401);
  expect(
    (await visit(jar, "/colleges/1", { headers: NAVIGATE })).headers.get("location"),
  ).toBeNull();

  const login = await visit(jar, "/login?next=/colleges/1");
  expect(new URL(location(login)).searchParams.has("prompt")).toBe(false);
  expect(await roundTrip(jar, login, null, 6)).toBe("/colleges/1");
  expect(await me(jar)).toMatchObject({
    display_name: "冻结鼠",
    frozen: true,
    can: { edit: false, admin: false, owner: false },
  });
});

test("scripts and search engines aren't sent round to mousehole", async () => {
  expect((await app.request("/")).headers.get("location")).toBeNull();
  const fetched = { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };
  expect((await app.request("/", { headers: fetched })).headers.get("location")).toBeNull();
});

test("an answer that doesn't belong to a login this browser started leaves a guest", async () => {
  const jar: Jar = new Map();
  const start = await visit(jar, "/login?next=/x");
  const authorize = new URL(location(start));
  authorize.searchParams.set("as", "2");
  const callback = new URL(location(await fetch(authorize, { redirect: "manual" })));

  const forged = [
    { param: "state", value: "forged", cookie: cookieHeader(jar) },
    { param: "iss", value: "https://elsewhere.example", cookie: cookieHeader(jar) },
    { param: "state", value: callback.searchParams.get("state") ?? "", cookie: "" },
  ];
  for (const { param, value, cookie } of forged) {
    const url = new URL(callback);
    url.searchParams.set(param, value);
    const res = await app.request(url.pathname + url.search, { headers: { cookie } });
    expect(location(res)).toBe("/");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("mouseclock_session="))).toBe(false);
  }
});

test("after logging in, nobody is sent off the site", async () => {
  for (const next of [
    "https://elsewhere.example/",
    "//elsewhere.example/",
    "/\\elsewhere.example/",
  ]) {
    const jar: Jar = new Map();
    const start = await visit(jar, `/login?next=${encodeURIComponent(next)}`);
    expect(await roundTrip(jar, start, null, 1)).toBe("/");
  }
});

test("what changes on mousehole shows within the hour, and a dead token logs them out", async () => {
  const newcomer: FakeUser = {
    id: 100,
    display_name: "新鼠",
    avatar_url: "/avatars/100.webp?v=1",
    level: 1,
    role: "user",
    member_status: "member",
    restriction: null,
    qq: 10100,
  };
  fakeUsers.push(newcomer);
  const jar: Jar = new Map();
  await roundTrip(jar, await visit(jar, "/login"), null, newcomer.id);
  const lastHour = () =>
    db
      .updateTable("users")
      .set({ synced_at: new Date(Date.now() - 3600_000 - 1000) })
      .where("mousehole_id", "=", newcomer.id)
      .execute();

  const muteEnds = Math.floor(Date.now() / 1000) + 86400;
  newcomer.level = 3;
  newcomer.restriction = { type: "mute", until: muteEnds };
  await refreshUsers();
  expect(await me(jar)).toMatchObject({ level: 1, muted: false });
  await lastHour();
  await refreshUsers();
  expect(await me(jar)).toMatchObject({
    level: 3,
    avatar_url: `${new URL(env.MOUSEHOLE_URL).origin}/avatars/100.webp?v=1`,
    muted: true,
    muted_until: muteEnds,
    can: { edit: false },
  });

  // A ban logs them out and revokes their Agent's token too.
  const made = await api.me.tokens.$post(
    { json: { name: "我的 Codex", scope: "read" } },
    { headers: { cookie: cookieHeader(jar), origin: env.PUBLIC_URL } },
  );
  if (made.status !== 201) throw new Error(`status ${made.status}`);
  const agent = { headers: { authorization: `Bearer ${(await made.json()).token}` } };
  expect((await api.me.$get({}, agent)).status).toBe(200);
  revoked.add(newcomer.id);
  await lastHour();
  await refreshUsers();
  const res = await visit(jar, "/api/v1/me");
  expect(res.status).toBe(401);
  expect(jar.has("mouseclock_session")).toBe(false);
  expect((await api.me.$get({}, agent)).status).toBe(401);
});

test("one whose profile mousehole can't give doesn't hold up the others' refresh", async () => {
  const first: FakeUser = { ...fakeUsers[0], id: 101, display_name: "坏鼠", qq: 10101 };
  const second: FakeUser = { ...fakeUsers[0], id: 102, display_name: "好鼠", qq: 10102 };
  fakeUsers.push(first, second);
  for (const [user, ago] of [
    [first, 2],
    [second, 1.5],
  ] as const) {
    const jar: Jar = new Map();
    await roundTrip(jar, await visit(jar, "/login"), null, user.id);
    await db
      .updateTable("users")
      .set({ synced_at: new Date(Date.now() - ago * 3600_000) })
      .where("mousehole_id", "=", user.id)
      .execute();
  }
  // Out of mousehole's range, so its profile doesn't parse; the first in line, being the oldest.
  first.level = 9;
  second.level = 4;
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});
  await refreshUsers();
  // Only the kind of failure: mousehole's answer stays out of the log.
  const entries = logged.mock.calls.map(([line]) =>
    z.record(z.string(), z.unknown()).parse(JSON.parse(String(line))),
  );
  logged.mockRestore();
  expect(entries.map((entry) => Object.keys(entry).sort())).toEqual([
    ["failure", "level", "msg", "time", "user_id"],
  ]);
  expect(entries[0].failure).toBe("invalid_response");
  const levels = await db
    .selectFrom("users")
    .select(["mousehole_id", "level"])
    .where("mousehole_id", "in", [first.id, second.id])
    .orderBy("mousehole_id")
    .execute();
  expect(levels).toEqual([
    { mousehole_id: 101, level: 1 },
    { mousehole_id: 102, level: 4 },
  ]);
});

test("mousehole timing out partway through its answer isn't taken for a wrong answer", async () => {
  const stalled = new ReadableStream({
    pull: (controller) => controller.error(new DOMException("timed out", "TimeoutError")),
  });
  const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(stalled));
  await expect(fetchProfile("token")).rejects.toMatchObject({ name: "TimeoutError" });
  fetched.mockRestore();
});

test("logging out ends the session, and the next page doesn't log straight back in", async () => {
  const jar: Jar = new Map();
  await roundTrip(jar, await visit(jar, "/login"), null, 2);
  // A new browser session, which would try the automatic login again.
  jar.delete("mouseclock_login_tried");

  const forged = await visit(jar, "/api/v1/auth/logout", {
    method: "POST",
    headers: { origin: "https://elsewhere.example" },
  });
  expect(forged.status).toBe(403);
  expect(await me(jar)).toMatchObject({ display_name: "仓鼠" });
  // A bearer token skips that check, so the cookie mustn't speak for its request.
  await app.request("/api/v1/auth/logout", {
    method: "POST",
    headers: {
      cookie: cookieHeader(jar),
      origin: "https://elsewhere.example",
      authorization: "Bearer forged",
    },
  });
  expect(await me(jar)).toMatchObject({ display_name: "仓鼠" });

  const res = await visit(jar, "/api/v1/auth/logout", {
    method: "POST",
    headers: { origin: env.PUBLIC_URL },
  });
  expect(res.status).toBe(204);
  expect((await visit(jar, "/", { headers: NAVIGATE })).headers.get("location")).toBeNull();
  expect((await api.me.$get({}, { headers: { cookie: cookieHeader(jar) } })).status).toBe(401);
});
