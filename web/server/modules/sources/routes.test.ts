import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { createApi } from "../../../app/api.server.ts";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login, resolveSession } from "../accounts/service.ts";
import { createCrawlerToken, recordRun, takeWork } from "../ingest/service.ts";
import { createCollege, createSchool, createSource, updateSchool, type Actor } from "./service.ts";

const api = testClient(app).api.v1;
let admin = { headers: { cookie: "", origin: env.PUBLIC_URL } };
let adminId = 0;

beforeAll(async () => {
  const token = await login(fakeUsers[2], "fake-3", { ip: null, userAgent: "test" });
  admin = { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
  const session = await resolveSession(token);
  if (!session) throw new Error("Login did not create a session");
  adminId = session.viewer.id;
});

const endpoints = [
  ["GET", "schools"],
  ["POST", "schools"],
  ["GET", "schools/1"],
  ["PATCH", "schools/1"],
  ["GET", "colleges"],
  ["POST", "colleges"],
  ["GET", "colleges/1"],
  ["PATCH", "colleges/1"],
  ["GET", "sources"],
  ["POST", "sources"],
  ["GET", "sources/1"],
  ["PATCH", "sources/1"],
];

test("every management endpoint refuses guests, non-admins, restricted admins and bearer requests", async () => {
  const profiles: { profile: FakeUser; status: number; code: string }[] = [
    { profile: fakeUsers[0], status: 403, code: "forbidden" },
    { profile: fakeUsers[1], status: 403, code: "forbidden" },
    { profile: { ...fakeUsers[0], id: 21, role: "moderator" }, status: 403, code: "forbidden" },
    {
      profile: { ...fakeUsers[2], id: 22, member_status: "frozen" },
      status: 403,
      code: "member_frozen",
    },
    {
      profile: { ...fakeUsers[2], id: 23, restriction: { type: "mute", until: null } },
      status: 403,
      code: "muted",
    },
  ];
  const people = [
    { cookie: "", status: 401, code: "login_required" },
    ...(await Promise.all(
      profiles.map(async ({ profile, status, code }) => ({
        cookie: `mouseclock_session=${await login(profile, "fake", { ip: null, userAgent: "test" })}`,
        status,
        code,
      })),
    )),
  ];
  for (const person of people) {
    for (const [method, path] of endpoints) {
      const res = await app.request(`/api/v1/admin/${path}`, {
        method,
        headers: {
          cookie: person.cookie,
          origin: env.PUBLIC_URL,
          "content-type": "application/json",
        },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(res.status, `${method} ${path}`).toBe(person.status);
      expect(await res.json()).toMatchObject({ error: { code: person.code } });
    }
  }
  for (const [method, path] of endpoints) {
    const res = await app.request(`/api/v1/admin/${path}`, {
      method,
      headers: {
        ...admin.headers,
        authorization: "Bearer personal-or-crawler",
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect(res.status).toBe(403);
  }
  expect(await db.selectFrom("audit_log").select("id").execute()).toEqual([]);
});

test("in-process page calls keep bearer headers so management writes cannot bypass API permissions", async () => {
  const session = await resolveSession(admin.headers.cookie.slice("mouseclock_session=".length));
  if (!session) throw new Error("Admin session missing");
  const pageApi = createApi(
    new Request(`${env.PUBLIC_URL}/admin/colleges`, {
      method: "POST",
      headers: {
        ...admin.headers,
        authorization: "Bearer personal",
      },
    }),
    { viewer: session.viewer, sessionId: session.id },
  );
  const response = await pageApi.admin.schools.$post({
    json: { name: "不应写入的大学", short_name: "", tiers: [] },
  });
  expect(response.status).toBe(403);
  expect(
    await db.selectFrom("schools").select("id").where("name", "=", "不应写入的大学").execute(),
  ).toEqual([]);
  expect(await db.selectFrom("audit_log").select("id").execute()).toEqual([]);
});

test("admins maintain schools, colleges and sources with before/after audit records; pause and resume change work", async () => {
  const schoolRes = await api.admin.schools.$post(
    { json: { name: "测试大学", short_name: "测大", tiers: ["985", "211"] } },
    admin,
  );
  expect(schoolRes.status).toBe(201);
  if (schoolRes.status !== 201) throw new Error("School failed");
  const school = await schoolRes.json();
  expect(
    (
      await api.admin.schools[":id"].$patch(
        { param: { id: String(school.id) }, json: { short_name: "测试" } },
        admin,
      )
    ).status,
  ).toBe(200);

  const collegeRes = await api.admin.colleges.$post(
    {
      json: {
        school_id: school.id,
        name: "计算机学院",
        kind: "college",
        region: "深圳",
        directions: ["计算机"],
      },
    },
    admin,
  );
  expect(collegeRes.status).toBe(201);
  if (collegeRes.status !== 201) throw new Error("College failed");
  const college = await collegeRes.json();
  expect(
    (
      await api.admin.colleges[":id"].$patch(
        {
          param: { id: String(college.id) },
          json: { kind: "institute", region: "北京", directions: ["人工智能"] },
        },
        admin,
      )
    ).status,
  ).toBe(200);

  const sourceRes = await api.admin.sources.$post(
    {
      json: {
        college_id: college.id,
        url: "https://test.example/list",
        section: "通知公告",
        browser: false,
        config: null,
        unavailable_reason: null,
      },
    },
    admin,
  );
  expect(sourceRes.status).toBe(201);
  if (sourceRes.status !== 201) throw new Error("Source failed");
  const source = await sourceRes.json();
  const param = { id: String(source.id) };
  const initial = await api.admin.sources.$get(
    { query: { college_id: String(college.id) } },
    admin,
  );
  expect(await initial.json()).toMatchObject({ items: [{ id: source.id, last_run: null }] });
  const config = { list: "#list", pagination: { next: ".next" }, years: 2 };
  const updated = await api.admin.sources[":id"].$patch(
    { param, json: { config, browser: true, unavailable_reason: "需要登录" } },
    admin,
  );
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    config,
    browser: true,
    unavailable_reason: "需要登录",
    section: "通知公告",
  });
  const paused = await api.admin.sources.$get(
    { query: { college_id: String(college.id), availability: "unavailable" } },
    admin,
  );
  expect(await paused.json()).toMatchObject({
    items: [{ id: source.id, unavailable_reason: "需要登录" }],
  });
  const available = await api.admin.sources.$get(
    { query: { college_id: String(college.id), availability: "available" } },
    admin,
  );
  expect(await available.json()).toMatchObject({ items: [] });

  await createCrawlerToken("sources-test");
  const crawler = await db
    .selectFrom("crawler_tokens")
    .select("id")
    .where("name", "=", "sources-test")
    .executeTakeFirstOrThrow();
  const now = new Date("2026-10-28T04:00:00Z");
  expect((await takeWork(crawler.id, now)).sources.find((s) => s.id === source.id)).toBeUndefined();
  expect(
    (await api.admin.sources[":id"].$patch({ param, json: { unavailable_reason: null } }, admin))
      .status,
  ).toBe(200);
  expect((await takeWork(crawler.id, now)).sources).toContainEqual(
    expect.objectContaining({ id: source.id, config, browser: true, backfill: true }),
  );

  const logs = await db.selectFrom("audit_log").selectAll().orderBy("id").execute();
  expect(logs).toHaveLength(7);
  expect(logs.every((l) => l.user_id === adminId)).toBe(true);
  expect(logs[0]).toMatchObject({
    action: "create",
    target_type: "school",
    target_id: school.id,
    detail: { via: "web", before: null, after: { name: "测试大学" } },
  });
  expect(logs[1]).toMatchObject({
    action: "update",
    target_type: "school",
    detail: { before: { short_name: "测大" }, after: { short_name: "测试" } },
  });
  expect(logs[3]).toMatchObject({
    target_type: "college",
    detail: { before: { region: "深圳" }, after: { region: "北京" } },
  });
  expect(logs[5]).toMatchObject({
    target_type: "source",
    detail: { before: { config: null }, after: { config, unavailable_reason: "需要登录" } },
  });
  expect(logs[6]).toMatchObject({
    detail: { before: { unavailable_reason: "需要登录" }, after: { unavailable_reason: null } },
  });

  await recordRun({
    source_id: source.id,
    started_at: now,
    finished_at: new Date(now.getTime() + 1000),
    failure: "http_status",
    detail: "HTTP 403",
    listed: 0,
    new_count: 0,
    useful_count: 0,
    notice_failures: [],
  });
  // Inserted later but finished earlier: latest means finished_at, not row ID.
  await recordRun({
    source_id: source.id,
    started_at: new Date(now.getTime() - 10_000),
    finished_at: new Date(now.getTime() - 5000),
    listed: 3,
    new_count: 2,
    useful_count: 1,
    notice_failures: [],
  });
  const listRes = await api.admin.sources.$get({ query: { q: "测试大学" } }, admin);
  expect(listRes.status).toBe(200);
  const listed = await listRes.json();
  expect(listed).toMatchObject({
    items: [{ id: source.id, last_run: { failure: "http_status", detail: "HTTP 403" } }],
  });
  if ("items" in listed) {
    expect(listed.items[0]).not.toHaveProperty("config");
    expect(listed.items[0].last_run).not.toHaveProperty("notice_failures");
  }
});

test("a source paused after leasing still accepts listing and run results without resuming", async () => {
  const actor: Actor = { user_id: adminId, via: "web" };
  const school = await createSchool(actor, { name: "领取后暂停大学", short_name: "", tiers: [] });
  const collegeId = await createCollege(actor, {
    school_id: school.id,
    name: "计算机学院",
    kind: "college",
    region: "北京",
    directions: [],
  });
  const sourceId = await createSource(actor, {
    college_id: collegeId,
    url: "https://leased.example/list",
    section: "通知公告",
    browser: false,
    config: null,
    unavailable_reason: null,
  });
  const crawler = {
    headers: { authorization: `Bearer ${await createCrawlerToken("pause-after-leasing")}` },
  };
  const work = await api.crawler.work.$get({}, crawler);
  expect(work.status).toBe(200);
  if (work.status !== 200) throw new Error("Work failed");
  expect((await work.json()).sources).toContainEqual(expect.objectContaining({ id: sourceId }));
  const leased = await db
    .selectFrom("sources")
    .select("leased_until")
    .where("id", "=", sourceId)
    .executeTakeFirstOrThrow();
  expect(leased.leased_until).toBeInstanceOf(Date);

  const param = { id: String(sourceId) };
  expect(
    (
      await api.admin.sources[":id"].$patch(
        { param, json: { unavailable_reason: "需要登录" } },
        admin,
      )
    ).status,
  ).toBe(200);
  const url = "https://leased.example/notice";
  const listing = await api.crawler.sources[":id"].listing.$post(
    { param, json: { items: [{ url, title: "夏令营通知", published_on: "2026-05-01" }] } },
    crawler,
  );
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({ new_count: 1, pending: [{ url }] });
  const finishedAt = Date.parse("2026-10-28T05:01:00Z") / 1000;
  expect(
    (
      await api.crawler.runs.$post(
        {
          json: {
            source_id: sourceId,
            started_at: finishedAt - 60,
            finished_at: finishedAt,
            listed: 1,
            new_count: 1,
            useful_count: 0,
            notice_failures: [],
          },
        },
        crawler,
      )
    ).status,
  ).toBe(204);
  expect(
    await db
      .selectFrom("sources")
      .select(["unavailable_reason", "leased_until", "crawled_at"])
      .where("id", "=", sourceId)
      .executeTakeFirstOrThrow(),
  ).toEqual({
    unavailable_reason: "需要登录",
    leased_until: null,
    crawled_at: new Date(finishedAt * 1000),
  });
});

test("source constraints and explicit nulls preserve unrelated settings and audit only successful writes", async () => {
  const school = await createSchool(
    { user_id: adminId, via: "web" },
    { name: "来源约束大学", short_name: "", tiers: [] },
  );
  const collegeRes = await api.admin.colleges.$post(
    {
      json: {
        school_id: school.id,
        name: "研究生院",
        kind: "graduate_school",
        region: "上海",
        directions: [],
      },
    },
    admin,
  );
  if (collegeRes.status !== 201) throw new Error("College failed");
  const college = await collegeRes.json();
  const json = {
    college_id: college.id,
    url: "http://source.example/list",
    section: "招生",
    browser: true,
    config: { list: ".list" },
    unavailable_reason: "验证码",
  };
  const created = await api.admin.sources.$post({ json }, admin);
  if (created.status !== 201) throw new Error("Source failed");
  const source = await created.json();
  const before = await db.selectFrom("audit_log").select("id").execute();
  expect((await api.admin.sources.$post({ json }, admin)).status).toBe(409);
  expect(
    (
      await api.admin.sources.$post(
        { json: { ...json, url: "https://source.example/other", college_id: 2147483647 } },
        admin,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await api.admin.colleges.$post(
        {
          json: {
            school_id: school.id,
            name: "研究生院",
            kind: "graduate_school",
            region: "上海",
            directions: [],
          },
        },
        admin,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await api.admin.sources[":id"].$patch(
        { param: { id: String(source.id) }, json: { unavailable_reason: "   " } },
        admin,
      )
    ).status,
  ).toBe(400);
  const forbiddenFields = await app.request(`/api/v1/admin/sources/${source.id}`, {
    method: "PATCH",
    headers: { ...admin.headers, "content-type": "application/json" },
    body: JSON.stringify({ crawled_at: 123, leased_until: null }),
  });
  expect(forbiddenFields.status).toBe(400);
  expect(await db.selectFrom("audit_log").select("id").execute()).toEqual(before);
  const cleared = await api.admin.sources[":id"].$patch(
    { param: { id: String(source.id) }, json: { config: null, unavailable_reason: null } },
    admin,
  );
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({
    config: null,
    unavailable_reason: null,
    browser: true,
    section: "招生",
    url: json.url,
  });
});

test("conflicts, missing parents and invalid configuration do not change data or write audit records", async () => {
  const schoolRes = await api.admin.schools.$post(
    { json: { name: "约束大学", short_name: "", tiers: [] } },
    admin,
  );
  if (schoolRes.status !== 201) throw new Error("School failed");
  const school = await schoolRes.json();
  const before = await db.selectFrom("audit_log").select("id").execute();
  expect(
    (
      await api.admin.schools.$post(
        { json: { name: "约束大学", short_name: "", tiers: [] } },
        admin,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await api.admin.colleges.$post(
        {
          json: {
            school_id: 2147483647,
            name: "不存在",
            kind: "college",
            region: "北京",
            directions: [],
          },
        },
        admin,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await api.admin.schools[":id"].$patch(
        { param: { id: "2147483647" }, json: { name: "不存在" } },
        admin,
      )
    ).status,
  ).toBe(404);
  expect(
    (await api.admin.schools[":id"].$patch({ param: { id: String(school.id) }, json: {} }, admin))
      .status,
  ).toBe(400);
  for (const config of ["not-json-object", [1, 2]]) {
    const res = await app.request("/api/v1/admin/sources", {
      method: "POST",
      headers: { ...admin.headers, "content-type": "application/json" },
      body: JSON.stringify({
        college_id: 1,
        url: "https://x.example/list",
        section: "",
        browser: false,
        config,
        unavailable_reason: null,
      }),
    });
    expect(res.status).toBe(400);
  }
  expect(await db.selectFrom("audit_log").select("id").execute()).toEqual(before);
});

test("an audit failure rolls back both creation and update", async () => {
  const actor: Actor = { user_id: 2147483647, via: "web" };
  await expect(
    createSchool(actor, { name: "应当回滚", short_name: "", tiers: [] }),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    await db.selectFrom("schools").select("id").where("name", "=", "应当回滚").execute(),
  ).toEqual([]);
  const row = await createSchool(
    { user_id: adminId, via: "web" },
    { name: "回滚前", short_name: "", tiers: [] },
  );
  await expect(updateSchool(actor, row.id, { name: "回滚后" })).rejects.toMatchObject({
    status: 404,
  });
  expect(
    await db
      .selectFrom("schools")
      .select("name")
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ name: "回滚前" });
});

test("school lists are searchable and paginated; owners may manage too", async () => {
  const owner = await login(fakeUsers[3], "fake-4", { ip: null, userAgent: "test" });
  const options = { headers: { cookie: `mouseclock_session=${owner}`, origin: env.PUBLIC_URL } };
  for (let i = 0; i < 21; i++) {
    expect(
      (
        await api.admin.schools.$post(
          { json: { name: `分页大学${i}`, short_name: "分页", tiers: [] } },
          options,
        )
      ).status,
    ).toBe(201);
  }
  const first = await api.admin.schools.$get({ query: { q: "分页", page: "1" } }, options);
  if (first.status !== 200) throw new Error("List failed");
  const page = await first.json();
  expect(page.items).toHaveLength(20);
  expect(page.next_page).toBe(2);
  const second = await api.admin.schools.$get({ query: { q: "分页", page: "2" } }, options);
  expect(await second.json()).toMatchObject({ items: [{ name: "分页大学20" }], next_page: null });
});
