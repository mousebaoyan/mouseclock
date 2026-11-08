import { testClient } from "hono/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { login } from "../accounts/service.ts";
import type { ApplyValue, ExtractedFields, Role } from "./schemas.ts";
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
    notices?: { role: Role; published_on?: string; fields?: ExtractedFields }[];
  },
) {
  return db.transaction().execute(async (trx) => {
    const id = await createProgram(trx, {
      college_id: collegeId,
      cohort,
      kind: "summer_camp",
      name: "夏令营",
    });
    for (const [i, { role, published_on = "2026-05-01", fields }] of notices.entries()) {
      const notice = await trx
        .insertInto("notices")
        .values({
          source_id: sourceId,
          url: `https://college.example/notices/${id}-${i}`,
          title: `通知 ${i + 1}`,
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
        const first = { apply: { value: apply, evidence: [{ quote: "报名时间" }], confidence: 1 } };
        await applyStored(trx, id, version.id, toStoredFields(first));
      }
      if (fields) await applyStored(trx, id, version.id, toStoredFields(fields));
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

const said = (quote: string, attachment?: number) => ({
  evidence: [attachment === undefined ? { quote } : { quote, attachment }],
  confidence: 0.9,
});

test("a program's page puts each field back together, every part with its evidence", async () => {
  const seeded = await college();
  const id = await program(seeded, {
    notices: [
      {
        role: "call",
        fields: {
          apply: {
            value: { start: { date: "2026-05-10" }, end: { date: "2026-06-01" } },
            ...said("5 月 10 日至 6 月 1 日报名"),
          },
          event: { value: { start: { month: "2026-07" }, mode: "offline" }, ...said("7 月线下") },
          dates: {
            value: [
              { label: "公布名单", end: { month: "2026-06", part: "late" } },
              { label: "材料截止", end: { date: "2026-06-03" } },
            ],
            ...said("材料 6 月 3 日前寄到，名单 6 月下旬公布"),
          },
          majors: { value: ["计算机科学与技术"], ...said("招收计算机科学与技术", 0) },
        },
      },
      {
        role: "update",
        fields: { apply: { value: { end: { date: "2026-06-05" } }, ...said("延长至 6 月 5 日") } },
      },
    ],
  });
  const { id: user } = await db
    .selectFrom("users")
    .select("id")
    .where("display_name", "=", "鼠鼠")
    .executeTakeFirstOrThrow();
  const edit = await db
    .insertInto("edits")
    .values({
      program_id: id,
      field: "quota",
      new_value: JSON.stringify("20 人"),
      reason: "原文写了名额",
      basis: "https://college.example/notices/1",
      user_id: user,
      via: "web",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("program_fields")
    .values({
      program_id: id,
      key: "quota",
      value: JSON.stringify("20 人"),
      evidence: JSON.stringify([]),
      edit_id: edit.id,
    })
    .execute();
  await db
    .updateTable("programs")
    .set({ verified_by: user, verified_at: now })
    .where("id", "=", id)
    .execute();

  const res = await api.programs[":id"].$get({ param: { id: String(id) } }, member);
  if (res.status !== 200) throw new Error("Detail failed");
  const snapshots = await db
    .selectFrom("program_versions")
    .select("snapshot_id")
    .where("program_id", "=", id)
    .orderBy("number")
    .execute();
  const [first, second] = snapshots.map(({ snapshot_id }, i) => ({
    number: i + 1,
    snapshot_id,
    notice: { title: `通知 ${i + 1}`, url: `https://college.example/notices/${id}-${i}` },
  }));
  expect(await res.json()).toEqual({
    id,
    school: { name: "测试大学", short_name: "测试大", tiers: ["985"] },
    college: { id: seeded.collegeId, name: "计算机学院", region: "北京" },
    cohort: 2027,
    kind: "summer_camp",
    name: "夏令营",
    apply_start: Date.parse("2026-05-09T16:00:00Z") / 1000,
    apply_deadline: Date.parse("2026-06-05T16:00:00Z") / 1000,
    verified: { by: "鼠鼠", at: now.getTime() / 1000 },
    notice: { ...first.notice, published_on: "2026-05-01", removed: false },
    fields: {
      apply: {
        start: {
          value: { date: "2026-05-10" },
          ...said("5 月 10 日至 6 月 1 日报名"),
          version: first,
        },
        end: { value: { date: "2026-06-05" }, ...said("延长至 6 月 5 日"), version: second },
      },
      event: {
        start: { value: { month: "2026-07" }, ...said("7 月线下"), version: first },
        mode: { value: "offline", ...said("7 月线下"), version: first },
      },
      dates: [
        {
          label: "材料截止",
          value: { end: { date: "2026-06-03" } },
          ...said("材料 6 月 3 日前寄到，名单 6 月下旬公布"),
          version: first,
        },
        {
          label: "公布名单",
          value: { end: { month: "2026-06", part: "late" } },
          ...said("材料 6 月 3 日前寄到，名单 6 月下旬公布"),
          version: first,
        },
      ],
      majors: { value: ["计算机科学与技术"], ...said("招收计算机科学与技术", 0), version: first },
      quota: { value: "20 人", evidence: [], confidence: null, version: null },
    },
  });
});

test("versions list their notices, what each changed and the attachments", async () => {
  const seeded = await college();
  const id = await program(seeded, {
    apply: until("2026-06-01"),
    notices: [{ role: "call" }, { role: "update" }],
  });
  const versions = await db
    .selectFrom("program_versions")
    .select(["number", "snapshot_id"])
    .where("program_id", "=", id)
    .orderBy("number")
    .execute();
  await db
    .updateTable("program_versions")
    .set({ changes: ["apply:end"] })
    .where("program_id", "=", id)
    .where("number", "=", 2)
    .execute();
  const snapshot = versions[1].snapshot_id;
  await db
    .insertInto("attachments")
    .values(
      [0, 1].map((position) => ({
        snapshot_id: snapshot,
        position,
        name: `附件${position}.pdf`,
        url: `https://college.example/files/${position}.pdf`,
        content_type: "application/pdf",
        text: "",
        data: position === 0 ? Buffer.from("%PDF") : null,
      })),
    )
    .execute();

  const res = await api.programs[":id"].versions.$get({ param: { id: String(id) } }, member);
  if (res.status !== 200) throw new Error("Versions failed");
  const { versions: listed } = await res.json();
  expect(listed).toEqual([
    {
      number: 2,
      role: "update",
      changes: ["apply:end"],
      notice: {
        title: "通知 2",
        url: `https://college.example/notices/${id}-1`,
        published_on: "2026-05-01",
        removed: false,
      },
      snapshot: { id: snapshot, fetched_at: now.getTime() / 1000 },
      attachments: [
        { position: 0, name: "附件0.pdf", content_type: "application/pdf", size: 4 },
        { position: 1, name: "附件1.pdf", content_type: "application/pdf", size: null },
      ],
    },
    expect.objectContaining({ number: 1, role: "call", attachments: [] }),
  ]);

  const file = await api.snapshots[":id"].attachments[":position"].$get(
    { param: { id: String(snapshot), position: "0" } },
    member,
  );
  expect(file.status).toBe(200);
  expect(file.headers.get("content-disposition")).toBe(
    `attachment; filename*=UTF-8''${encodeURIComponent("附件0.pdf")}`,
  );
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await file.text()).toBe("%PDF");
  const missing = await api.snapshots[":id"].attachments[":position"].$get(
    { param: { id: String(snapshot), position: "1" } },
    member,
  );
  expect(missing.status).toBe(404);
});

test("a snapshot shows the notice's words and links, nothing that runs or loads", async () => {
  const seeded = await college();
  const id = await program(seeded, {});
  const { snapshot_id } = await db
    .selectFrom("program_versions")
    .select("snapshot_id")
    .where("program_id", "=", id)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("snapshots")
    .set({
      html: [
        "<html><head><title>标题</title><style>p{}</style></head><body>",
        '<p class="hidden" style="color:red" onclick="steal()">报名<b>截止</b></p>',
        "<script>steal()</script><img src=x onerror=steal()>",
        '<a href="files/a.pdf?x=1&amp;y=2">申请表</a>',
        '<a href="javascript:steal()">点我</a>',
        `<a href='mailto:yz@college.example"onclick="steal()'>邮箱</a>`,
        '<table><tr><td colspan="2">名额</td></tr></table>',
        "</body></html>",
      ].join(""),
    })
    .where("id", "=", snapshot_id)
    .execute();

  const res = await api.snapshots[":id"].$get({ param: { id: String(snapshot_id) } }, member);
  if (res.status !== 200) throw new Error("Snapshot failed");
  expect((await res.json()).html).toBe(
    [
      "<p>报名<b>截止</b></p>",
      `<a href="https://college.example/notices/files/a.pdf?x=1&amp;y=2" target="_blank" rel="nofollow noopener noreferrer">申请表</a>`,
      "<a>点我</a>",
      `<a href="mailto:yz@college.example&quot;onclick=&quot;steal()" target="_blank" rel="nofollow noopener noreferrer">邮箱</a>`,
      '<table><tr><td colspan="2">名额</td></tr></table>',
    ].join(""),
  );
});

test("guests and frozen accounts see no program's page, versions or snapshots", async () => {
  const seeded = await college();
  const id = await program(seeded, {});
  const { snapshot_id } = await db
    .selectFrom("program_versions")
    .select("snapshot_id")
    .where("program_id", "=", id)
    .executeTakeFirstOrThrow();
  for (const url of [
    `/programs/${id}`,
    `/programs/${id}/versions`,
    `/snapshots/${snapshot_id}`,
    `/snapshots/${snapshot_id}/attachments/0`,
  ]) {
    expect((await app.request(`/api/v1${url}`)).status).toBe(401);
    expect((await app.request(`/api/v1${url}`, frozen)).status).toBe(403);
  }
  await db.updateTable("programs").set({ deleted_at: now }).where("id", "=", id).execute();
  for (const url of [`/programs/${id}`, `/programs/${id}/versions`]) {
    expect((await app.request(`/api/v1${url}`, member)).status).toBe(404);
  }
});
