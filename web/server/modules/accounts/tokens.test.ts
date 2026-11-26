import { testClient } from "hono/testing";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "./service.ts";

const api = testClient(app).api.v1;
type As = { headers: Record<string, string> };
let member: As, editor: As, other: As;

async function session(profile: FakeUser): Promise<As> {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

beforeAll(async () => {
  [member, editor, other] = await Promise.all(fakeUsers.slice(0, 3).map(session));
});

beforeEach(async () => {
  await db.deleteFrom("api_tokens").execute();
});

async function make(as: As, scope: "read" | "personal", name = "我的 Codex"): Promise<As> {
  const res = await api.me.tokens.$post({ json: { name, scope } }, as);
  if (res.status !== 201) throw new Error(`Make failed: ${res.status}`);
  return { headers: { authorization: `Bearer ${(await res.json()).token}` } };
}

async function tokens(as: As) {
  const res = await api.me.tokens.$get({}, as);
  if (res.status !== 200) throw new Error(`List failed: ${res.status}`);
  return (await res.json()).tokens;
}

async function expectError(
  res: { status: number; json(): Promise<unknown> },
  status: number,
  code: string,
) {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error: { code } });
}

const nowhere = { param: { id: "999999" } };

function setOther(values: { frozen?: boolean; token_refused_at?: Date | null }) {
  return db.updateTable("users").set(values).where("display_name", "=", "管理鼠").execute();
}

test("a token reads as its owner, and does personal operations only with that scope", async () => {
  const reader = await make(member, "read", "只读的");
  const me = await api.me.$get({}, reader);
  expect(me.status).toBe(200);
  expect((await api.programs.$get({ query: { cohort: "2027" } }, reader)).status).toBe(200);
  await expectError(
    await api.programs[":id"].subscription.$put(nowhere, reader),
    403,
    "token_scope",
  );

  // Past the scope, on to the program, which isn't there.
  const personal = await make(member, "personal", "能操作的");
  expect((await api.programs[":id"].subscription.$put(nowhere, personal)).status).toBe(404);

  // Tokens, editing and anything else not for an Agent take the web.
  await expectError(await api.me.tokens.$get({}, personal), 403, "web_only");
  const editing = await make(editor, "personal");
  const edit = { ...nowhere, json: { quota: "10 人", reason: "x", basis: "y" } };
  await expectError(await api.programs[":id"].$patch(edit, editing), 403, "web_only");
  await expectError(
    await api.messages.seen.$post({ json: { up_to: 0 } }, personal),
    403,
    "web_only",
  );

  // Its use shows, to the hour.
  expect((await tokens(member)).map((t) => [t.name, t.scope, t.last_used_at !== null])).toEqual([
    ["能操作的", "personal", true],
    ["只读的", "read", true],
  ]);
});

test("a request with a token is only who the token says, whatever its cookie", async () => {
  const wrong = { headers: { authorization: "Bearer nope", cookie: member.headers.cookie } };
  await expectError(await api.me.subscriptions.$get({}, wrong), 401, "invalid_token");
  // Not taken for a guest where guests may read.
  const table = await api.programs.$get({ query: { cohort: "2027" } }, wrong);
  await expectError(table, 401, "invalid_token");
  // The scheme in any case.
  const { authorization } = (await make(member, "read")).headers;
  const lower = { headers: { authorization: authorization.replace("Bearer", "bearer") } };
  expect((await api.me.subscriptions.$get({}, lower)).status).toBe(200);
});

test("a token works until revoked, unused for long, or its owner frozen or turned down", async () => {
  const token = await make(other, "read");
  const ask = () => api.me.subscriptions.$get({}, token);
  expect((await ask()).status).toBe(200);

  await setOther({ frozen: true });
  await expectError(await ask(), 403, "member_frozen");
  await setOther({ frozen: false });
  expect((await ask()).status).toBe(200);
  // Mousehole turned them down, as the refresh would find, before it revoked the token.
  await setOther({ token_refused_at: new Date() });
  await expectError(await ask(), 401, "invalid_token");
  await setOther({ token_refused_at: null });
  expect((await ask()).status).toBe(200);

  const [{ id }] = await tokens(other);
  await db
    .updateTable("api_tokens")
    .set({ created_at: new Date(Date.now() - 91 * 86400_000), last_used_at: null })
    .where("id", "=", id)
    .execute();
  await expectError(await ask(), 401, "invalid_token");
  expect(await tokens(other)).toEqual([]);

  const again = await make(other, "read");
  const [{ id: againId }] = await tokens(other);
  expect(
    (await api.me.tokens[":id"].$delete({ param: { id: String(againId) } }, member)).status,
  ).toBe(404);
  expect(
    (await api.me.tokens[":id"].$delete({ param: { id: String(againId) } }, other)).status,
  ).toBe(204);
  await expectError(await api.me.subscriptions.$get({}, again), 401, "invalid_token");
});

test("ten tokens a person, and sixty requests a minute a token", async () => {
  for (let i = 0; i < 10; i++) await make(editor, "read", `第 ${i + 1} 个`);
  const res = await api.me.tokens.$post({ json: { name: "多的", scope: "read" } }, editor);
  await expectError(res, 409, "too_many_tokens");

  const token = await make(member, "read", "忙的");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date());
    for (let i = 0; i < 60; i++) {
      expect((await api.me.subscriptions.$get({}, token)).status).toBe(200);
    }
    const over = await api.me.subscriptions.$get({}, token);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    await expectError(over, 429, "rate_limited");
    vi.setSystemTime(Date.now() + 60_000);
    expect((await api.me.subscriptions.$get({}, token)).status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test("thirty writes a minute a member on the site; reading doesn't count", async () => {
  const nothing = { param: { id: "999999" } };
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date());
    for (let i = 0; i < 30; i++) {
      expect((await api.me.tokens[":id"].$delete(nothing, other)).status).toBe(404);
      expect((await api.me.tokens.$get({}, other)).status).toBe(200);
    }
    const over = await api.me.tokens[":id"].$delete(nothing, other);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    await expectError(over, 429, "rate_limited");
    expect((await api.me.tokens.$get({}, other)).status).toBe(200);
    // Logging out still works, and does log out.
    const leaving = await session(fakeUsers[2]);
    expect((await api.auth.logout.$post({}, leaving)).status).toBe(204);
    expect((await api.me.tokens.$get({}, leaving)).status).toBe(401);
    // Each member counts apart.
    expect((await api.me.tokens[":id"].$delete(nothing, member)).status).toBe(404);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await api.me.tokens[":id"].$delete(nothing, other)).status).toBe(404);
  } finally {
    vi.useRealTimers();
  }
});
