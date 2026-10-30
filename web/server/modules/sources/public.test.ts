import { testClient } from "hono/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { login } from "../accounts/service.ts";
import type { ApplyValue, Kind } from "../programs/schemas.ts";
import { applyStored, createProgram, toStoredFields } from "../programs/service.ts";

const api = testClient(app).api.v1;
const now = new Date("2026-05-15T04:00:00Z");
let member = { headers: { cookie: "" } };
let muted = { headers: { cookie: "" } };
let frozen = { headers: { cookie: "" } };

async function session(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}` } };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  [member, muted, frozen] = await Promise.all([
    session(fakeUsers[0]),
    session(fakeUsers[4]),
    session(fakeUsers[5]),
  ]);
});

afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  vi.setSystemTime(now);
  await sql`truncate schools cascade`.execute(db);
});

async function fixture() {
  const school = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_name: "测试大", tiers: ["985", "double_first_class"] })
    .returning("id")
    .executeTakeFirstOrThrow();
  const college = await db
    .insertInto("colleges")
    .values({
      school_id: school.id,
      name: "计算机学院",
      kind: "college",
      region: "北京",
      directions: ["计算机"],
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const source = await db
    .insertInto("sources")
    .values({
      college_id: college.id,
      url: "https://college.example/notices",
      section: "通知公告",
      config: { adapter: "private-config" },
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const notice = await db
    .insertInto("notices")
    .values({
      source_id: source.id,
      url: "https://college.example/notices/1",
      title: "报名通知",
      published_on: "2026-05-01",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const snapshot = await db
    .insertInto("snapshots")
    .values({ notice_id: notice.id, fetched_at: now, html: "<p>报名时间</p>", text: "报名时间" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return {
    schoolId: school.id,
    collegeId: college.id,
    sourceId: source.id,
    snapshotId: snapshot.id,
  };
}

async function program(
  { collegeId, snapshotId }: Awaited<ReturnType<typeof fixture>>,
  { apply, ...values }: { cohort: number; name: string; kind: Kind; apply?: ApplyValue },
) {
  return db.transaction().execute(async (trx) => {
    const id = await createProgram(trx, { college_id: collegeId, ...values });
    const version = await trx
      .insertInto("program_versions")
      .values({
        program_id: id,
        snapshot_id: snapshotId,
        number: 1,
        role: "call",
        fields: {},
        changes: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await applyStored(
      trx,
      id,
      version.id,
      toStoredFields(
        apply
          ? {
              apply: { value: apply, evidence: [{ quote: "报名时间" }], confidence: 0.9 },
            }
          : {},
      ),
    );
    return id;
  });
}

test("both college endpoints reject guests and frozen members before reading data", async () => {
  const { collegeId } = await fixture();
  for (const endpoint of ["/api/v1/colleges", `/api/v1/colleges/${collegeId}`]) {
    for (const [options, status, code] of [
      [{}, 401, "login_required"],
      [frozen, 403, "member_frozen"],
    ] as const) {
      const res = await app.request(endpoint, options);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: { code } });
    }
  }
});

test("L1 and muted members can read the list and detail", async () => {
  const { collegeId } = await fixture();
  for (const options of [member, muted]) {
    expect((await api.colleges.$get({}, options)).status).toBe(200);
    expect(
      (await api.colleges[":id"].$get({ param: { id: String(collegeId) } }, options)).status,
    ).toBe(200);
  }
});

test("an empty college list is successful", async () => {
  const res = await api.colleges.$get({}, member);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ schools: [] });
});

test("the list groups all colleges, including those without sources, beyond the admin page size", async () => {
  const { schoolId, collegeId } = await fixture();
  const extraSchool = await db
    .insertInto("schools")
    .values({ name: "另一大学", short_name: "", tiers: [] })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("colleges")
    .values([
      ...Array.from({ length: 25 }, (_, i) => ({
        school_id: schoolId,
        name: `学院${i}`,
        kind: "college",
        region: "北京",
        directions: [],
      })),
      {
        school_id: extraSchool.id,
        name: "研究生院",
        kind: "graduate_school",
        region: "上海",
        directions: [],
      },
    ])
    .execute();
  const res = await api.colleges.$get({}, member);
  expect(res.status).toBe(200);
  if (res.status !== 200) throw new Error("College list failed");
  const body = await res.json();
  expect(body.schools).toHaveLength(2);
  const school = body.schools.find((item) => item.id === schoolId);
  expect(school).toMatchObject({
    name: "测试大学",
    short_name: "测试大",
    tiers: ["985", "double_first_class"],
  });
  expect(school?.colleges).toHaveLength(26);
  expect(school?.colleges).toContainEqual({
    id: collegeId,
    name: "计算机学院",
    kind: "college",
    region: "北京",
    directions: ["计算机"],
    next_program: null,
  });
  expect(body.schools.find((item) => item.id === extraSchool.id)?.colleges).toHaveLength(1);
});

test("detail exposes source summaries and failure reasons without crawler configuration", async () => {
  const seeded = await fixture();
  const unavailable = await db
    .insertInto("sources")
    .values({
      college_id: seeded.collegeId,
      url: "https://college.example/graduate",
      section: "",
      unavailable_reason: "需要登录",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const res = await api.colleges[":id"].$get({ param: { id: String(seeded.collegeId) } }, member);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    id: seeded.collegeId,
    school: {
      id: seeded.schoolId,
      name: "测试大学",
      short_name: "测试大",
      tiers: ["985", "double_first_class"],
    },
    name: "计算机学院",
    kind: "college",
    region: "北京",
    directions: ["计算机"],
    sources: [
      {
        id: seeded.sourceId,
        url: "https://college.example/notices",
        section: "通知公告",
        unavailable_reason: null,
      },
      {
        id: unavailable.id,
        url: "https://college.example/graduate",
        section: "",
        unavailable_reason: "需要登录",
      },
    ],
    programs: [],
  });
});

test("detail supports a college with no sources or projects", async () => {
  const seeded = await fixture();
  await sql`truncate sources cascade`.execute(db);
  const res = await api.colleges[":id"].$get({ param: { id: String(seeded.collegeId) } }, member);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ id: seeded.collegeId, sources: [], programs: [] });
});

test("history preserves original times and groups by cohort with stable deadline ordering", async () => {
  const seeded = await fixture();
  const later = await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "晚截止",
    apply: { start: { date: "2026-05-10" }, end: { month: "2026-06", part: "mid" }, rolling: true },
  });
  const deadline = await program(seeded, {
    cohort: 2027,
    kind: "pre_recommendation",
    name: "刚截止",
    apply: { end: { date: "2026-05-15", time: "12:00" } },
  });
  const tie = await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "同一截止",
    apply: { end: { date: "2026-05-15", time: "12:00" } },
  });
  const opening = await program(seeded, {
    cohort: 2027,
    kind: "september_round",
    name: "刚开始",
    apply: { start: { date: "2026-05-15", time: "12:00" } },
  });
  const future = await program(seeded, {
    cohort: 2028,
    kind: "winter_camp",
    name: "未开始",
    apply: { start: { date: "2026-05-16" } },
  });
  const rolling = await program(seeded, {
    cohort: 2026,
    kind: "summer_camp",
    name: "额满即止",
    apply: { rolling: true },
  });
  const unknown = await program(seeded, { cohort: 2026, kind: "summer_camp", name: "未说明" });
  const removed = await program(seeded, { cohort: 2029, kind: "summer_camp", name: "已删除" });
  await db.updateTable("programs").set({ deleted_at: now }).where("id", "=", removed).execute();
  const other = await db
    .insertInto("colleges")
    .values({
      school_id: seeded.schoolId,
      name: "其他学院",
      kind: "college",
      region: "北京",
      directions: [],
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await program(
    { ...seeded, collegeId: other.id },
    { cohort: 2030, kind: "summer_camp", name: "其他学院项目" },
  );

  const res = await api.colleges[":id"].$get({ param: { id: String(seeded.collegeId) } }, member);
  expect(res.status).toBe(200);
  if (res.status !== 200) throw new Error("College detail failed");
  const body = await res.json();
  expect(body.programs.map((group) => group.cohort)).toEqual([2028, 2027, 2026]);
  expect(body.programs.flatMap((group) => group.programs.map((item) => item.id))).toEqual([
    future,
    deadline,
    tie,
    later,
    opening,
    rolling,
    unknown,
  ]);
  expect(body.programs.flatMap((group) => group.programs)).toEqual([
    expect.objectContaining({ id: future, status: "upcoming" }),
    expect.objectContaining({
      id: deadline,
      status: "closed",
      apply_deadline: now.getTime() / 1000,
    }),
    expect.objectContaining({ id: tie, status: "closed" }),
    expect.objectContaining({
      id: later,
      status: "open",
      apply: {
        start: { date: "2026-05-10" },
        end: { month: "2026-06", part: "mid" },
        rolling: true,
      },
    }),
    expect.objectContaining({
      id: opening,
      status: "open",
      apply_start: now.getTime() / 1000,
      apply_deadline: null,
    }),
    expect.objectContaining({
      id: rolling,
      status: null,
      apply: { rolling: true },
      apply_start: null,
      apply_deadline: null,
    }),
    expect.objectContaining({
      id: unknown,
      status: null,
      apply: null,
      apply_start: null,
      apply_deadline: null,
    }),
  ]);
});

test("missing college returns not found", async () => {
  const res = await api.colleges[":id"].$get({ param: { id: "2147483647" } }, member);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
});

test.each(["invalid", "1.5", "2147483648"])("invalid college ID %s is rejected", async (id) => {
  const res = await api.colleges[":id"].$get({ param: { id } }, member);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
});

test("college activity chooses the nearest future application per college and advances when it opens", async () => {
  const seeded = await fixture();
  await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "较晚的夏令营",
    apply: { start: { date: "2026-05-18", time: "09:00" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "winter_camp",
    name: "最近的冬令营",
    apply: { start: { date: "2026-05-16", time: "09:00" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "pre_recommendation",
    name: "相同时间后录入",
    apply: { start: { date: "2026-05-16", time: "09:00" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "september_round",
    name: "更近的九推",
    apply: { start: { date: "2026-05-15", time: "13:00" } },
  });
  const removed = await program(seeded, {
    cohort: 2027,
    kind: "winter_camp",
    name: "已删除",
    apply: { start: { date: "2026-05-15", time: "13:00" } },
  });
  await db.updateTable("programs").set({ deleted_at: now }).where("id", "=", removed).execute();
  await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "已经开始",
    apply: { start: { date: "2026-05-15", time: "12:00" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "只写截止",
    apply: { end: { date: "2026-05-20" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "已经截止",
    apply: {
      start: { date: "2026-05-15", time: "13:00" },
      end: { date: "2026-05-15", time: "12:00" },
    },
  });
  const other = await db
    .insertInto("colleges")
    .values({
      school_id: seeded.schoolId,
      name: "其他学院",
      kind: "college",
      region: "北京",
      directions: [],
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await program(
    { ...seeded, collegeId: other.id },
    {
      cohort: 2027,
      kind: "pre_recommendation",
      name: "其他学院更近",
      apply: { start: { date: "2026-05-15", time: "13:00" } },
    },
  );

  const res = await api.colleges.$get({}, member);
  expect(res.status).toBe(200);
  if (res.status !== 200) throw new Error("College list failed");
  const colleges = (await res.json()).schools.flatMap((school) => school.colleges);
  expect(colleges.find((college) => college.id === seeded.collegeId)?.next_program).toEqual({
    kind: "september_round",
    start: { date: "2026-05-15", time: "13:00" },
  });
  expect(colleges.find((college) => college.id === other.id)?.next_program).toEqual({
    kind: "pre_recommendation",
    start: { date: "2026-05-15", time: "13:00" },
  });

  vi.setSystemTime(new Date("2026-05-15T05:00:00Z"));
  const tied = await api.colleges.$get({}, member);
  expect(tied.status).toBe(200);
  if (tied.status !== 200) throw new Error("College list failed");
  const tiedColleges = (await tied.json()).schools.flatMap((school) => school.colleges);
  expect(tiedColleges.find((college) => college.id === seeded.collegeId)?.next_program).toEqual({
    kind: "winter_camp",
    start: { date: "2026-05-16", time: "09:00" },
  });

  vi.setSystemTime(new Date("2026-05-16T01:00:00Z"));
  const refreshed = await api.colleges.$get({}, member);
  expect(refreshed.status).toBe(200);
  if (refreshed.status !== 200) throw new Error("College list failed");
  const refreshedColleges = (await refreshed.json()).schools.flatMap((school) => school.colleges);
  expect(
    refreshedColleges.find((college) => college.id === seeded.collegeId)?.next_program,
  ).toEqual({
    kind: "summer_camp",
    start: { date: "2026-05-18", time: "09:00" },
  });
  expect(refreshedColleges.find((college) => college.id === other.id)?.next_program).toBeNull();
});

test.each([
  { kind: "winter_camp", start: { date: "2026-05-17", time: "10:00" } },
  { kind: "summer_camp", start: { date: "2026-05-18", mark: "about" } },
  { kind: "pre_recommendation", start: { month: "2026-06", part: "early" } },
  { kind: "september_round", start: { date: "2026-10-08", time: "09:30" } },
] satisfies { kind: Kind; start: NonNullable<ApplyValue["start"]> }[])(
  "college activity preserves the original start precision for $kind",
  async ({ kind, start }) => {
    const seeded = await fixture();
    await program(seeded, { cohort: 2027, name: "即将开始", kind, apply: { start } });
    const res = await api.colleges.$get({}, member);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      schools: [{ colleges: [{ id: seeded.collegeId, next_program: { kind, start } }] }],
    });
  },
);

test("college activity is absent when no eligible future application remains", async () => {
  const seeded = await fixture();
  await program(seeded, {
    cohort: 2027,
    kind: "winter_camp",
    name: "已开始",
    apply: { start: { date: "2026-05-14" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "刚开始",
    apply: { start: { date: "2026-05-15", time: "12:00" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "pre_recommendation",
    name: "已截止",
    apply: { start: { date: "2026-05-14" }, end: { date: "2026-05-15", time: "12:00" } },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "summer_camp",
    name: "额满即止",
    apply: { rolling: true },
  });
  await program(seeded, {
    cohort: 2027,
    kind: "pre_recommendation",
    name: "开始时间未知",
    apply: { end: { date: "2026-05-20" } },
  });
  const removed = await program(seeded, {
    cohort: 2027,
    kind: "winter_camp",
    name: "已删除",
    apply: { start: { date: "2026-05-20" } },
  });
  await db.updateTable("programs").set({ deleted_at: now }).where("id", "=", removed).execute();
  const res = await api.colleges.$get({}, member);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    schools: [{ colleges: [{ id: seeded.collegeId, next_program: null }] }],
  });
});
