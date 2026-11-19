import type { z } from "@hono/zod-openapi";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeEach, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import type { InclusionRequestInput, InclusionRequestPatch, RequestStatus } from "./schemas.ts";

const api = testClient(app).api.v1;
type As = { headers: Record<string, string> };

async function writer(profile: FakeUser): Promise<As> {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

let schoolId = 0;
let collegeId = 0;

beforeEach(async () => {
  await sql`truncate schools, inclusion_requests, messages, audit_log restart identity cascade`.execute(
    db,
  );
  ({ id: schoolId } = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_names: [], tier: "985" })
    .returning("id")
    .executeTakeFirstOrThrow());
  collegeId = await college("计算机学院");
});

async function college(name: string) {
  const { id } = await db
    .insertInto("colleges")
    .values({ school_id: schoolId, name, kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

async function ask(as: As, json: z.input<typeof InclusionRequestInput>) {
  const res = await api["inclusion-requests"].$post({ json }, as);
  return { status: res.status, id: res.ok ? (await res.json()).id : null };
}

const noHint = { url_hint: null, note: "" };

async function list(as: As, status: RequestStatus = "queued") {
  const res = await api["inclusion-requests"].$get({ query: { status } }, as);
  if (res.status !== 200) throw new Error("List failed");
  const { items, counts } = await res.json();
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
    items: items.map((r) => [`${r.school.name} ${r.college.name}`, r.votes, r.mine]),
  };
}

function patch(as: As, id: number, json: z.input<typeof InclusionRequestPatch>) {
  return api.admin["inclusion-requests"][":id"].$patch({ param: { id: String(id) }, json }, as);
}

async function messages() {
  const rows = await db
    .selectFrom("messages")
    .innerJoin("users", "users.id", "messages.user_id")
    .select(["users.display_name", "messages.kind", "messages.title", "messages.link"])
    .orderBy("messages.title")
    .orderBy("users.display_name")
    .execute();
  return rows.map((m) => [m.display_name, m.kind, m.title, m.link]);
}

test("asking for a college asked for already is a vote; the queue goes by votes", async () => {
  const [one, two, three] = await Promise.all(fakeUsers.slice(0, 3).map(writer));
  // The link and the note can be left out.
  const listed = await ask(one, { college_id: collegeId });
  expect(listed.status).toBe(201);
  expect(await ask(two, { college_id: collegeId, ...noHint })).toEqual({
    status: 200,
    id: listed.id,
  });
  expect((await ask(one, { college_id: collegeId, ...noHint })).status).toBe(200);

  const named = { school_id: schoolId, college_name: "软件学院", url_hint: null, note: "" };
  const software = await ask(three, { ...named, note: "通知在研究生院网站" });
  expect(software.status).toBe(201);
  expect(await ask(one, { ...named, college_name: " 软件学院 " })).toEqual({
    status: 200,
    id: software.id,
  });
  expect(
    (await ask(two, { school_name: "新大学", college_name: "计算机学院", ...noHint })).status,
  ).toBe(201);

  expect(await list(two)).toEqual({
    counts: { queued: 3, onboarding: 0, included: 0, unavailable: 0 },
    items: [
      ["测试大学 计算机学院", 2, true],
      ["测试大学 软件学院", 2, false],
      ["新大学 计算机学院", 1, true],
    ],
  });

  // Included: it has a source that is crawled.
  const math = await college("数学学院");
  await db
    .insertInto("sources")
    .values({ college_id: math, url: "https://math.example/" })
    .execute();
  expect((await ask(one, { college_id: math, ...noHint })).status).toBe(409);
  expect((await ask(one, { college_id: math + 100, ...noHint })).status).toBe(404);
  expect((await ask(one, { school_id: schoolId, college_name: "", ...noHint })).status).toBe(400);
});

test("one vote each; a queued ask no one votes for leaves; muted and frozen can't ask", async () => {
  const [one, two, admin, , muted, frozen] = await Promise.all(fakeUsers.map(writer));
  const { id } = await ask(one, { college_id: collegeId, ...noHint });
  const param = { id: String(id) };
  const vote = api["inclusion-requests"][":id"].vote;
  expect((await vote.$put({ param }, two)).status).toBe(204);
  expect((await vote.$put({ param }, two)).status).toBe(204);
  expect((await list(one)).items).toEqual([["测试大学 计算机学院", 2, true]]);

  expect((await vote.$put({ param }, muted)).status).toBe(403);
  expect((await ask(muted, { college_id: collegeId, ...noHint })).status).toBe(403);
  expect((await ask(frozen, { college_id: collegeId, ...noHint })).status).toBe(403);
  expect((await vote.$put({ param: { id: String(Number(id) + 100) } }, two)).status).toBe(404);

  expect((await vote.$delete({ param }, one)).status).toBe(204);
  expect((await list(one)).items).toEqual([["测试大学 计算机学院", 1, false]]);
  expect((await vote.$delete({ param }, two)).status).toBe(204);
  expect(await list(one)).toMatchObject({ counts: { queued: 0 }, items: [] });

  // One being onboarded stays without votes, until it is back in the queue.
  const again = await ask(one, { college_id: collegeId, ...noHint });
  if (again.id === null) throw new Error("Ask failed");
  await patch(admin, again.id, { status: "onboarding" });
  await vote.$delete({ param: { id: String(again.id) } }, one);
  expect((await list(one, "onboarding")).items).toEqual([["测试大学 计算机学院", 0, false]]);
  expect((await patch(admin, again.id, { status: "queued" })).status).toBe(204);
  expect((await list(one)).counts).toMatchObject({ queued: 0, onboarding: 0 });
});

test("admins move asks along; those who asked and voted hear how it ended", async () => {
  const [one, two, admin] = await Promise.all(fakeUsers.slice(0, 3).map(writer));
  const { id } = await ask(one, { college_id: collegeId, ...noHint });
  if (id === null) throw new Error("Ask failed");
  await api["inclusion-requests"][":id"].vote.$put({ param: { id: String(id) } }, two);

  expect((await patch(one, id, { status: "onboarding" })).status).toBe(403);
  expect((await patch(admin, id, { status: "onboarding" })).status).toBe(204);
  expect((await list(one, "onboarding")).items).toEqual([["测试大学 计算机学院", 2, true]]);
  expect(await messages()).toEqual([]);

  const reason = "要登录才能看";
  expect((await patch(admin, id, { status: "unavailable", reason: "" })).status).toBe(400);
  expect((await patch(admin, id, { status: "unavailable", reason })).status).toBe(204);
  const unavailable = [
    "inclusion_result",
    "测试大学 计算机学院暂时抓不了",
    "/requests?status=unavailable",
  ];
  expect(await messages()).toEqual([
    ["仓鼠", ...unavailable],
    ["鼠鼠", ...unavailable],
  ]);
  await patch(admin, id, { status: "onboarding" });
  const back = await db
    .selectFrom("inclusion_requests")
    .select(["reason", "resolved_at"])
    .executeTakeFirstOrThrow();
  expect(back).toEqual({ reason: null, resolved_at: null });

  // Its first source crawled includes it.
  const source = {
    college_id: collegeId,
    url: "https://cs.example/notices",
    section: "",
    browser: false,
    keep_all: false,
    config: null,
    unavailable_reason: null,
  };
  expect((await api.admin.sources.$post({ json: source }, admin)).status).toBe(201);
  expect((await list(one, "included")).items).toEqual([["测试大学 计算机学院", 2, true]]);
  const included = ["inclusion_result", "测试大学 计算机学院已收录", `/colleges/${collegeId}`];
  expect((await messages()).filter((m) => m[2] === included[1])).toEqual([
    ["仓鼠", ...included],
    ["鼠鼠", ...included],
  ]);
  const audit = await db
    .selectFrom("audit_log")
    .select("action")
    .where("target_type", "=", "inclusion_request")
    .execute();
  expect(audit).toHaveLength(3);
});

test("admins match asks to the list and merge the same college asked twice", async () => {
  const [one, two, admin] = await Promise.all(fakeUsers.slice(0, 3).map(writer));
  const named = await ask(one, { school_name: "新大学", college_name: "计算机学院", ...noHint });
  const again = await ask(two, { school_name: "新大学", college_name: "计算机系", ...noHint });
  await ask(one, { school_name: "新大学", college_name: "计算机系", ...noHint });
  if (named.id === null || again.id === null) throw new Error("Ask failed");

  const merge = (id: number, into: number) =>
    api.admin["inclusion-requests"][":id"].merge.$post(
      { param: { id: String(id) }, json: { into } },
      admin,
    );
  // Included is a college on the list being crawled.
  expect((await patch(admin, named.id, { status: "included" })).status).toBe(409);
  expect((await merge(again.id, again.id)).status).toBe(400);
  expect((await merge(again.id, named.id)).status).toBe(204);
  expect((await list(two)).items).toEqual([["新大学 计算机学院", 2, true]]);

  // Matched to the list: the names come from it.
  const { id: school } = await db
    .insertInto("schools")
    .values({ name: "新大学（北京）", short_names: [] })
    .returning("id")
    .executeTakeFirstOrThrow();
  expect((await patch(admin, named.id, { school_id: school })).status).toBe(204);
  expect((await list(two)).items).toEqual([["新大学（北京） 计算机学院", 2, true]]);
  const listed = await ask(two, { college_id: collegeId, ...noHint });
  if (listed.id === null) throw new Error("Ask failed");
  expect((await patch(admin, named.id, { college_id: collegeId })).status).toBe(409);
  expect((await patch(admin, listed.id, { school_id: school })).status).toBe(409);
  // Its followers count by the college it is matched to.
  expect((await merge(listed.id, named.id)).status).toBe(409);

  // Matched to a college crawled already: done.
  const crawled = await college("软件学院");
  await db
    .insertInto("sources")
    .values({ college_id: crawled, url: "https://se.example/" })
    .execute();
  expect((await patch(admin, named.id, { college_id: crawled })).status).toBe(204);
  expect((await list(two, "included")).items).toEqual([["测试大学 软件学院", 2, true]]);
  expect((await messages()).map((m) => m[2])).toEqual([
    "测试大学 软件学院已收录",
    "测试大学 软件学院已收录",
  ]);
});
