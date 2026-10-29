import { beforeAll, expect, test } from "vitest";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { fakeUsers } from "../../../test/fake-mousehole.ts";
import { login } from "../accounts/service.ts";
import { createCollege, createSchool, createSource } from "./service.ts";

let member = { headers: { cookie: "", origin: env.PUBLIC_URL } };
let collegeId = 0;

beforeAll(async () => {
  const token = await login(fakeUsers[0], "public-colleges", { ip: null, userAgent: "test" });
  member = { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
  const actor = { user_id: fakeUsers[0].id, via: "web" as const };
  const school = await createSchool(actor, {
    name: "公开测试大学",
    short_name: "公开大",
    tiers: ["985"],
  });
  collegeId = await createCollege(actor, {
    school_id: school.id,
    name: "计算机学院",
    kind: "college",
    region: "北京",
    directions: ["计算机", "人工智能"],
  });
  const sourceId = await createSource(actor, {
    college_id: collegeId,
    url: "https://college.example/notices",
    section: "通知公告",
    browser: false,
    config: null,
    unavailable_reason: null,
  });

  const now = Date.now();
  const notice = await db
    .insertInto("notices")
    .values({
      source_id: sourceId,
      url: "https://college.example/notices/1",
      title: "夏令营通知",
      published_on: "2026-05-01",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const snapshot = await db
    .insertInto("snapshots")
    .values({
      notice_id: notice.id,
      fetched_at: new Date(now),
      html: "<p>报名时间</p>",
      text: "报名时间",
      extracted_at: new Date(now),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const program = await db
    .insertInto("programs")
    .values({
      college_id: collegeId,
      cohort: 2027,
      kind: "summer_camp",
      name: "2026 年优秀大学生夏令营",
      apply_start: new Date(now - 2 * 86400_000),
      apply_deadline: new Date(now + 2 * 86400_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const version = await db
    .insertInto("program_versions")
    .values({
      program_id: program.id,
      snapshot_id: snapshot.id,
      number: 1,
      role: "call",
      fields: {},
      changes: ["apply:start", "apply:end"],
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("program_fields")
    .values([
      {
        program_id: program.id,
        key: "apply:start",
        value: { date: "2026-05-10" },
        evidence: [{ quote: "报名时间：2026 年 5 月 10 日至 5 月 20 日" }],
        confidence: 0.9,
        version_id: version.id,
        edit_id: null,
      },
      {
        program_id: program.id,
        key: "apply:end",
        value: { date: "2026-05-20" },
        evidence: [{ quote: "报名时间：2026 年 5 月 10 日至 5 月 20 日" }],
        confidence: 0.9,
        version_id: version.id,
        edit_id: null,
      },
    ])
    .execute();
});

test("college pages require read access", async () => {
  const res = await app.request("/api/v1/colleges");
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: "login_required" } });
});

test("college list groups colleges by school", async () => {
  const res = await app.request("/api/v1/colleges", member);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    schools: [
      {
        name: "公开测试大学",
        short_name: "公开大",
        tiers: ["985"],
        colleges: [
          {
            id: collegeId,
            name: "计算机学院",
            region: "北京",
            directions: ["计算机", "人工智能"],
          },
        ],
      },
    ],
  });
});

test("college detail includes sources and grouped programs", async () => {
  const res = await app.request(`/api/v1/colleges/${collegeId}`, member);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    id: collegeId,
    school: { name: "公开测试大学", tiers: ["985"] },
    sources: [{ section: "通知公告", unavailable_reason: null }],
    programs: [
      {
        cohort: 2027,
        programs: [
          {
            kind: "summer_camp",
            name: "2026 年优秀大学生夏令营",
            apply: { start: { date: "2026-05-10" }, end: { date: "2026-05-20" } },
            status: "open",
          },
        ],
      },
    ],
  });
});

test("missing college returns not found", async () => {
  const res = await app.request("/api/v1/colleges/2147483647", member);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
});
