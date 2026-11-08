import { testClient } from "hono/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { login } from "../accounts/service.ts";
import type { ApplyValue, Role } from "./schemas.ts";
import { applyStored, createProgram, toStoredFields } from "./service.ts";

const api = testClient(app).api.v1;
const now = new Date("2026-05-15T04:00:00Z");
let member = { headers: { cookie: "" } };
let frozen = { headers: { cookie: "" } };

async function session(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}` } };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  [member, frozen] = await Promise.all([session(fakeUsers[0]), session(fakeUsers[5])]);
});

afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  vi.setSystemTime(now);
  await sql`truncate schools cascade`.execute(db);
});

async function college() {
  const school = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_name: "测试大", tiers: ["985"] })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id } = await db
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
    .values({ college_id: id, url: "https://college.example/notices" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { collegeId: id, sourceId: source.id };
}

// A program with a version per notice, in order; the first version sets the apply field.
async function program(
  { collegeId, sourceId }: Awaited<ReturnType<typeof college>>,
  {
    cohort = 2027,
    apply,
    notices = [{ role: "call" }],
  }: {
    cohort?: number;
    apply?: ApplyValue;
    notices?: { role: Role; published_on?: string }[];
  },
) {
  return db.transaction().execute(async (trx) => {
    const id = await createProgram(trx, {
      college_id: collegeId,
      cohort,
      kind: "summer_camp",
      name: "夏令营",
    });
    for (const [i, { role, published_on = "2026-05-01" }] of notices.entries()) {
      const notice = await trx
        .insertInto("notices")
        .values({
          source_id: sourceId,
          url: `https://college.example/notices/${id}-${i}`,
          title: "通知",
          published_on,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const snapshot = await trx
        .insertInto("snapshots")
        .values({ notice_id: notice.id, fetched_at: now, html: "", text: "报名时间" })
        .returning("id")
        .executeTakeFirstOrThrow();
      const version = await trx
        .insertInto("program_versions")
        .values({
          program_id: id,
          snapshot_id: snapshot.id,
          number: i + 1,
          role,
          fields: {},
          changes: [],
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (i === 0 && apply) {
        const fields = {
          apply: { value: apply, evidence: [{ quote: "报名时间" }], confidence: 1 },
        };
        await applyStored(trx, id, version.id, toStoredFields(fields));
      }
    }
    return id;
  });
}

const until = (date: string) => ({ end: { date } });

test("members get the whole cohort with the table's fields, by deadline", async () => {
  const seeded = await college();
  const open = await program(seeded, {
    apply: { start: { date: "2026-05-10" }, end: { date: "2026-06-01", time: "17:00" } },
  });
  const closed = await program(seeded, { apply: until("2026-05-01") });
  const rolling = await program(seeded, { apply: { rolling: true } });
  await program(seeded, { cohort: 2028, apply: until("2026-06-01") });
  const removed = await program(seeded, { apply: until("2026-06-01") });
  await db.updateTable("programs").set({ deleted_at: now }).where("id", "=", removed).execute();

  const res = await api.programs.$get({ query: { cohort: "2027" } }, member);
  expect(res.status).toBe(200);
  if (res.status !== 200) throw new Error("Table failed");
  const { preview, programs } = await res.json();
  expect(preview).toBe(false);
  expect(programs.map((item) => item.id)).toEqual([closed, open, rolling]);
  expect(programs[1]).toEqual({
    id: open,
    school: { name: "测试大学", short_name: "测试大", tiers: ["985"] },
    college: { id: seeded.collegeId, name: "计算机学院", region: "北京", directions: ["计算机"] },
    kind: "summer_camp",
    name: "夏令营",
    apply: { start: { date: "2026-05-10" }, end: { date: "2026-06-01", time: "17:00" } },
    apply_start: Date.parse("2026-05-09T16:00:00Z") / 1000,
    apply_deadline: Date.parse("2026-06-01T09:00:00Z") / 1000,
    notice: { url: `https://college.example/notices/${open}-0`, published_on: "2026-05-01" },
  });
  expect(programs[2]).toMatchObject({ apply: { rolling: true }, apply_deadline: null });
});

test("guests and frozen accounts see the five open programs closing soonest", async () => {
  const seeded = await college();
  await program(seeded, { apply: until("2026-05-14") });
  await program(seeded, { apply: { rolling: true } });
  const open = [];
  for (const day of [21, 16, 19, 17, 20, 18]) {
    open.push(await program(seeded, { apply: until(`2026-05-${day}`) }));
  }
  const [, d16, d19, d17, d20, d18] = open;
  for (const options of [{}, frozen]) {
    const res = await api.programs.$get({ query: { cohort: "2027" } }, options);
    if (res.status !== 200) throw new Error("Preview failed");
    const { preview, programs } = await res.json();
    expect(preview).toBe(true);
    expect(programs.map((item) => item.id)).toEqual([d16, d17, d18, d19, d20]);
  }
});

test("the link goes to the latest call, or else the latest version", async () => {
  const seeded = await college();
  const called = await program(seeded, {
    notices: [
      { role: "call", published_on: "2026-04-01" },
      { role: "call", published_on: "2026-04-10" },
      { role: "update", published_on: "2026-04-20" },
    ],
  });
  const uncalled = await program(seeded, {
    notices: [
      { role: "update", published_on: "2026-04-01" },
      { role: "result", published_on: "2026-05-01" },
    ],
  });
  const res = await api.programs.$get({ query: { cohort: "2027" } }, member);
  if (res.status !== 200) throw new Error("Table failed");
  const notices = new Map((await res.json()).programs.map((item) => [item.id, item.notice]));
  expect(notices).toEqual(
    new Map([
      [called, { url: `https://college.example/notices/${called}-1`, published_on: "2026-04-10" }],
      [
        uncalled,
        { url: `https://college.example/notices/${uncalled}-1`, published_on: "2026-05-01" },
      ],
    ]),
  );
});

test("a cohort is required", async () => {
  for (const query of ["", "?cohort=next", "?cohort=1999"]) {
    const res = await app.request(`/api/v1/programs${query}`, member);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
  }
});

test("a member's browser keeps the table until a version or an admin changes something", async () => {
  const seeded = await college();
  await program(seeded, { apply: until("2026-06-01") });
  const url = "/api/v1/programs?cohort=2027";
  const ask = (etag: string) =>
    app.request(url, { headers: { ...member.headers, "if-none-match": etag } });
  const first = await app.request(url, member);
  const etag = first.headers.get("etag") ?? "";
  expect(etag).toMatch(/^".+"$/);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  const unchanged = await ask(etag);
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");

  await program(seeded, { apply: until("2026-06-02") });
  const versioned = await ask(etag);
  expect(versioned.status).toBe(200);
  const next = versioned.headers.get("etag") ?? "";
  expect(next).not.toBe(etag);

  const { id } = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
  await db
    .insertInto("audit_log")
    .values({ user_id: id, action: "update_school", target_type: "school", target_id: 1 })
    .execute();
  expect((await ask(next)).status).toBe(200);

  const other = await app.request("/api/v1/programs?cohort=2028", {
    headers: { ...member.headers, "if-none-match": next },
  });
  expect(other.status).toBe(200);

  const preview = await app.request(url, { headers: { "if-none-match": etag } });
  expect(preview.status).toBe(200);
  expect(preview.headers.get("etag")).toBeNull();
});

test("a change committed after a later one still changes the tag", async () => {
  const seeded = await college();
  await program(seeded, { apply: until("2026-06-01") });
  const url = "/api/v1/programs?cohort=2027";
  const { id: userId } = await db.selectFrom("users").select("id").executeTakeFirstOrThrow();
  const entry = { user_id: userId, action: "update_school", target_type: "school", target_id: 1 };
  // The first transaction takes the lower id, then waits while a second one commits.
  const held = Promise.withResolvers<void>();
  const taken = Promise.withResolvers<void>();
  const slow = db.transaction().execute(async (trx) => {
    await trx.insertInto("audit_log").values(entry).execute();
    taken.resolve();
    await held.promise;
  });
  await taken.promise;
  await db.insertInto("audit_log").values(entry).execute();
  const etag = (await app.request(url, member)).headers.get("etag") ?? "";
  held.resolve();
  await slow;
  const after = await app.request(url, { headers: { ...member.headers, "if-none-match": etag } });
  expect(after.status).toBe(200);
});
