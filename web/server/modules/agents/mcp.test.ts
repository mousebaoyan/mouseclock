import { testClient } from "hono/testing";
import { beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { fakeUsers } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import { createProgram } from "../programs/service.ts";

const api = testClient(app).api.v1;
let member: { cookie: string; origin: string };

beforeAll(async () => {
  const session = await login(fakeUsers[0], "fake", { ip: null, userAgent: "test" });
  member = { cookie: `mouseclock_session=${session}`, origin: env.PUBLIC_URL };
});

async function make(scope: "read" | "personal") {
  const res = await api.me.tokens.$post({ json: { name: "MCP", scope } }, { headers: member });
  if (res.status !== 201) throw new Error(`Make failed: ${res.status}`);
  return { authorization: `Bearer ${(await res.json()).token}` };
}

function rpc(headers: Record<string, string>, method: string, params: object = {}) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

// The JSON-RPC answer, plain or as the one event of a stream.
async function answer(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  const text = await res.text();
  return JSON.parse(text.startsWith("event:") ? text.split("\ndata: ")[1] : text);
}

const Listed = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.object({
          properties: z.record(z.string(), z.unknown()),
          required: z.array(z.string()),
        }),
        annotations: z.record(z.string(), z.boolean()),
      }),
    ),
  }),
});

const Called = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })), isError: z.boolean() }),
});

async function call(headers: Record<string, string>, name: string, args: object) {
  const { result } = Called.parse(
    await answer(await rpc(headers, "tools/call", { name, arguments: args })),
  );
  return { text: result.content[0].text, isError: result.isError };
}

test("the tools are api.md §4's, described and with parameters as the API documents them", async () => {
  const { tools } = Listed.parse(await answer(await rpc(await make("read"), "tools/list"))).result;
  expect(tools.map((t) => t.name)).toEqual([
    "search_programs",
    "get_program",
    "get_program_versions",
    "search_colleges",
    "get_college",
    "crawl_status",
    "list_subscriptions",
    "list_follows",
    "list_applications",
    "list_feedback",
    "list_messages",
    "subscribe",
    "unsubscribe",
    "follow",
    "unfollow",
    "set_application",
    "clear_application",
    "submit_feedback",
    "withdraw_feedback",
  ]);
  const tool = (name: string) => tools.find((t) => t.name === name);
  expect(tool("search_programs")?.description).toMatch(/^总表。一届的项目/);
  expect(tool("search_programs")).toMatchObject({
    inputSchema: {
      properties: { cohort: { type: "integer", description: "届" }, closed: { type: "boolean" } },
      required: ["cohort"],
    },
    annotations: { readOnlyHint: true },
  });
  // The body as `body`, standing alone.
  expect(tool("set_application")?.inputSchema).toMatchObject({
    properties: { id: { type: "integer" }, body: { properties: { stage: { type: "string" } } } },
    required: ["id", "body"],
  });
  expect(JSON.stringify(tools)).not.toContain("$ref");
  expect(tool("subscribe")?.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  expect(tool("withdraw_feedback")?.annotations).toMatchObject({ destructiveHint: true });
  // A list that never changes, so none to watch.
  const init = await answer(
    await rpc(await make("read"), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );
  expect(init).toMatchObject({ result: { capabilities: { tools: { listChanged: false } } } });
});

test("a tool calls the API as the token's owner, as far as its scope goes", async () => {
  const reader = await make("read");
  expect(JSON.parse((await call(reader, "list_subscriptions", {})).text)).toEqual({
    programs: [],
    limit: 10,
  });
  const scoped = await call(reader, "subscribe", { id: 999999 });
  expect(scoped.isError).toBe(true);
  expect(scoped.text).toContain('"code":"token_scope"');

  const personal = await make("personal");
  const missing = await call(personal, "subscribe", { id: 999999 });
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain('"code":"not_found"');
  const { id: school } = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_names: [] })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id: college } = await db
    .insertInto("colleges")
    .values({ school_id: school, name: "计算机学院", kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow();
  expect(await call(personal, "follow", { id: college })).toEqual({ text: "完成", isError: false });
  const follows = await db.selectFrom("follows").select("college_id").execute();
  expect(follows).toEqual([{ college_id: college }]);

  // A body, and a query.
  const program = await db.transaction().execute((trx) =>
    createProgram(trx, {
      college_id: college,
      cohort: 2027,
      kind: "summer_camp",
      name: "夏令营",
    }),
  );
  // A boolean in the address, as the API reads it.
  const found = await call(personal, "search_programs", { cohort: 2027, closed: true });
  expect(found.isError).toBe(false);
  const given = await call(personal, "submit_feedback", {
    id: program,
    body: { kind: "problem", field: null, reason: "名称不对" },
  });
  expect(given.isError).toBe(false);
  const mine = await call(personal, "list_feedback", { per_page: 50 });
  expect(JSON.parse(mine.text)).toMatchObject({
    items: [{ reason: "名称不对" }],
    per_page: 50,
  });
  expect(await db.selectFrom("feedback").select("via").execute()).toEqual([{ via: "agent" }]);
  // What isn't a parameter isn't sent anywhere.
  const stray = await call(personal, "get_program", { id: program, body: {} });
  expect(stray.isError).toBe(true);
  expect(stray.text).toContain("没有这些参数：body");
});

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error: { code } });
}

test("only a member's personal token connects", async () => {
  await expectError(await rpc({}, "tools/list"), 401, "token_required");
  await expectError(await rpc(member, "tools/list"), 401, "token_required");
  await expectError(
    await rpc({ authorization: "Bearer nope" }, "tools/list"),
    401,
    "invalid_token",
  );

  // A browser opening it isn't sent to log in.
  const opened = await app.request("/mcp", {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  await expectError(opened, 401, "token_required");

  const token = await make("read");
  await db.updateTable("users").set({ frozen: true }).where("display_name", "=", "鼠鼠").execute();
  await expectError(await rpc(token, "tools/list"), 403, "member_frozen");
  await db.updateTable("users").set({ frozen: false }).where("display_name", "=", "鼠鼠").execute();
});

test("a tool call is one request of the token's minute, not two", async () => {
  const token = await make("read");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date());
    for (let i = 0; i < 60; i++) {
      expect((await call(token, "list_messages", {})).isError).toBe(false);
    }
    expect((await rpc(token, "tools/call", { name: "list_messages", arguments: {} })).status).toBe(
      429,
    );
  } finally {
    vi.useRealTimers();
  }
});
