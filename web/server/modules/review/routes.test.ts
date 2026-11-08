import { testClient } from "hono/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import type { ExtractedFields } from "../programs/schemas.ts";
import { applyStored, createProgram, toStoredFields } from "../programs/service.ts";
import { editProgram } from "./service.ts";

const api = testClient(app).api.v1;
const now = new Date("2026-05-15T04:00:00Z");
type Session = { headers: { cookie: string; origin: string } };
const guest = { headers: { cookie: "", origin: env.PUBLIC_URL } };
let member: Session, editor: Session, admin: Session, muted: Session, frozen: Session;
const why = {
  reason: "通知写错了，补充通知更正了截止",
  basis: "https://college.example/notices/9",
};

async function session(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  [member, editor, admin, muted, frozen] = await Promise.all(
    [0, 1, 2, 4, 5].map((i) => session(fakeUsers[i])),
  );
});

afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  vi.setSystemTime(now);
  await sql`truncate schools cascade`.execute(db);
  await db.updateTable("users").set({ edit_revoked_at: null }).execute();
});

const evidence = [{ quote: "报名时间" }];
const field = <V>(value: V) => ({ value, evidence, confidence: 1 });

// A program from a notice that said `fields`.
async function program(fields: ExtractedFields) {
  const school = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_names: ["测试大"], tier: null })
    .returning("id")
    .executeTakeFirstOrThrow();
  const college = await db
    .insertInto("colleges")
    .values({ school_id: school.id, name: "计算机学院", kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const source = await db
    .insertInto("sources")
    .values({ college_id: college.id, url: "https://college.example/notices" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const id = await db.transaction().execute((trx) =>
    createProgram(trx, {
      college_id: college.id,
      cohort: 2027,
      kind: "summer_camp",
      name: "夏令营",
    }),
  );
  await version(id, source.id, 1, fields);
  return { id, sourceId: source.id };
}

// A notice that said `fields` about the program, merged as ingest does.
async function version(
  programId: number,
  sourceId: number,
  number: number,
  fields: ExtractedFields,
) {
  const notice = await db
    .insertInto("notices")
    .values({
      source_id: sourceId,
      url: `https://college.example/notices/${number}`,
      title: "通知",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const snapshot = await db
    .insertInto("snapshots")
    .values({ notice_id: notice.id, fetched_at: now, html: "", text: "报名时间" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto("program_versions")
      .values({
        program_id: programId,
        snapshot_id: snapshot.id,
        number,
        role: "call",
        fields: JSON.stringify(fields),
        changes: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return applyStored(trx, programId, id, toStoredFields(fields));
  });
}

async function detail(id: number) {
  const res = await api.programs[":id"].$get({ param: { id: String(id) } }, member);
  if (res.status !== 200) throw new Error("Detail failed");
  return res.json();
}

async function edit(id: number, body: object, as = editor) {
  return api.programs[":id"].$patch({ param: { id: String(id) }, json: { ...why, ...body } }, as);
}

async function revert(editId: number, as = editor) {
  return api.edits[":id"].revert.$post({ param: { id: String(editId) } }, as);
}

async function editIds(res: Awaited<ReturnType<typeof edit>>) {
  if (res.status !== 200) throw new Error(`Edit failed: ${await res.text()}`);
  return (await res.json()).edits.map((row) => row.id);
}

const june = (day: number) => ({ date: `2026-06-${String(day).padStart(2, "0")}` });

test("an edit records the parts it changes, which later notices leave alone", async () => {
  const { id, sourceId } = await program({ apply: field({ start: june(1), end: june(10) }) });
  await db.updateTable("programs").set({ verified_by: 1, verified_at: now }).execute();

  const res = await edit(id, { apply: { start: june(1), end: june(20) } });
  expect(res.status).toBe(200);
  if (res.status !== 200) throw new Error("Edit failed");
  const { edits } = await res.json();
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject({
    field: "apply:end",
    old_value: june(10),
    new_value: june(20),
    ...why,
    user: { display_name: "仓鼠" },
    via: "web",
    reverts_id: null,
    reverted: false,
  });
  const shown = await detail(id);
  expect(shown.fields.apply?.start?.version?.number).toBe(1);
  expect(shown.fields.apply?.end).toMatchObject({ value: june(20), evidence: [], version: null });
  expect(shown.apply_deadline).toBe(Date.parse("2026-06-20T16:00:00Z") / 1000);
  expect(shown.verified).toBeNull();

  // A later notice moves both: the start follows it, the end is held for review.
  const { changed, conflicts } = await version(id, sourceId, 2, {
    apply: field({ start: june(2), end: june(30) }),
  });
  expect(changed).toEqual(["apply:start"]);
  expect(conflicts.map((row) => row.key)).toEqual(["apply:end"]);
});

test("a cleared field stays cleared when notices state it again", async () => {
  const { id, sourceId } = await program({
    quota: field("20 人"),
    apply: field({ start: june(1), end: june(10) }),
  });
  await editIds(await edit(id, { quota: null, apply: { end: june(10) } }));

  const { fields } = await detail(id);
  expect(fields.quota).toBeUndefined();
  expect(fields.apply?.start).toBeUndefined();
  const again = await version(id, sourceId, 2, {
    quota: field("20 人"),
    apply: field({ start: june(1) }),
  });
  expect(again.changed).toEqual([]);
  expect(again.conflicts.map((row) => row.key).toSorted()).toEqual(["apply:start", "quota"]);
});

test("a revert puts the field back with its source, which notices update again", async () => {
  const { id, sourceId } = await program({ quota: field("20 人") });
  const [quota] = await editIds(await edit(id, { quota: "30 人" }));
  const [majors] = await editIds(await edit(id, { majors: ["软件工程"] }));

  const res = await revert(quota);
  expect(res.status).toBe(200);
  if (res.status !== 200) throw new Error("Revert failed");
  expect((await res.json()).edit).toMatchObject({
    field: "quota",
    old_value: "30 人",
    new_value: "20 人",
    reason: null,
    basis: null,
    reverts_id: quota,
  });
  expect((await revert(majors)).status).toBe(200);

  const { fields } = await detail(id);
  expect(fields.quota).toMatchObject({ value: "20 人", evidence, version: { number: 1 } });
  expect(fields.majors).toBeUndefined();
  const later = await version(id, sourceId, 2, { quota: field("25 人") });
  expect(later.changed).toEqual(["quota"]);
});

test("an edit is reverted only while the field still holds what it set", async () => {
  const { id } = await program({ quota: field("20 人") });
  const [first] = await editIds(await edit(id, { quota: "30 人" }));
  const [second] = await editIds(await edit(id, { quota: "40 人" }));

  const early = await revert(first);
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ error: { code: "edit_superseded" } });
  expect((await revert(second)).status).toBe(200);
  expect((await detail(id)).fields.quota).toMatchObject({ value: "30 人", version: null });
  expect((await revert(second)).status).toBe(409);
  expect((await revert(first)).status).toBe(200);
  expect((await detail(id)).fields.quota).toMatchObject({ value: "20 人", version: { number: 1 } });
});

test("an edit changed since is not reverted, even once the value is back", async () => {
  const { id } = await program({ quota: field("20 人") });
  const [quota] = await editIds(await edit(id, { quota: "30 人" }));
  await editIds(await edit(id, { quota: "40 人" }, admin));
  await editIds(await edit(id, { quota: "30 人" }, admin));
  const [name] = await editIds(await edit(id, { name: "暑期学校" }));
  await editIds(await edit(id, { name: "夏令营" }, admin));
  await editIds(await edit(id, { name: "暑期学校" }, admin));

  expect((await revert(quota)).status).toBe(409);
  expect((await revert(name)).status).toBe(409);
});

test("an edit already under way when an admin takes back editing is turned down", async () => {
  const { id } = await program({ quota: field("20 人") });
  const user = await db
    .updateTable("users")
    .set({ edit_revoked_at: now })
    .where("display_name", "=", "仓鼠")
    .returning("id")
    .executeTakeFirstOrThrow();
  await expect(
    editProgram({ user_id: user.id, via: "web" }, id, { quota: "30 人", ...why }),
  ).rejects.toMatchObject({ code: "edit_revoked" });
});

test("the name, cohort and kind are edited and reverted too", async () => {
  const { id } = await program({});
  const ids = await editIds(
    await edit(id, { name: "暑期学校", cohort: 2028, kind: "summer_camp" }),
  );
  expect(ids).toHaveLength(2);
  expect(await detail(id)).toMatchObject({ name: "暑期学校", cohort: 2028 });

  for (const editId of ids) expect((await revert(editId)).status).toBe(200);
  expect(await detail(id)).toMatchObject({ name: "夏令营", cohort: 2027 });
  const same = await edit(id, { name: "夏令营" });
  expect(same.status).toBe(400);
  expect(await same.json()).toMatchObject({ error: { code: "no_change" } });
});

test("only L3 and up edit, revert and verify, and not while muted or revoked", async () => {
  const { id } = await program({ quota: field("20 人") });
  const [editId] = await editIds(await edit(id, { quota: "30 人" }));
  await db
    .updateTable("users")
    .set({ edit_revoked_at: now })
    .where("display_name", "=", "管理鼠")
    .execute();
  const param = { id: String(id) };
  for (const [as, status] of [
    [guest, 401],
    [frozen, 403],
    [member, 403],
    [muted, 403],
    [admin, 403],
  ] as const) {
    expect((await edit(id, { quota: "40 人" }, as)).status).toBe(status);
    expect((await revert(editId, as)).status).toBe(status);
    expect((await api.programs[":id"].verify.$post({ param }, as)).status).toBe(status);
  }

  expect((await api.programs[":id"].verify.$post({ param }, editor)).status).toBe(204);
  expect((await detail(id)).verified).toEqual({ by: "仓鼠", at: now.getTime() / 1000 });
});

test("an admin reverts all someone's edits but the ones changed since, and stops their editing", async () => {
  const { id } = await program({ quota: field("20 人"), majors: field(["计算机"]) });
  await editIds(await edit(id, { quota: "30 人" }));
  await editIds(await edit(id, { majors: ["软件工程"] }));
  await editIds(await edit(id, { majors: ["人工智能"] }));
  await editIds(await edit(id, { quota: "40 人" }, admin));

  const users = api.admin.users[":id"]["revoke-edits"];
  const [target] = await db
    .selectFrom("users")
    .select("id")
    .where("display_name", "=", "仓鼠")
    .execute();
  const param = { id: String(target.id) };
  expect((await users.$post({ param }, editor)).status).toBe(403);
  const res = await users.$post({ param }, admin);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reverted: 2, kept: 1 });

  const { fields } = await detail(id);
  expect(fields.majors).toMatchObject({ value: ["计算机"], version: { number: 1 } });
  expect(fields.quota).toMatchObject({ value: "40 人", version: null });
  expect((await edit(id, { quota: "50 人" })).status).toBe(403);
  const audit = await db.selectFrom("audit_log").selectAll().executeTakeFirstOrThrow();
  expect(audit).toMatchObject({
    action: "revoke_edits",
    target_type: "user",
    target_id: target.id,
  });
  expect(audit.detail).toMatchObject({ reverted: [expect.any(Number), expect.any(Number)] });
});

test("edits are listed for a program and across the site, the latest first", async () => {
  const { id } = await program({ quota: field("20 人") });
  const [first] = await editIds(await edit(id, { quota: "30 人" }));
  await revert(first);
  await db.updateTable("programs").set({ deleted_at: now }).where("id", "!=", id).execute();

  const res = await api.programs[":id"].edits.$get({ param: { id: String(id) } }, member);
  if (res.status !== 200) throw new Error("Edits failed");
  const { edits } = await res.json();
  expect(edits.map((row) => [row.reverts_id, row.reverted])).toEqual([
    [first, false],
    [null, true],
  ]);
  const recent = await api.edits.$get({ query: { per_page: "20" } }, member);
  if (recent.status !== 200) throw new Error("Recent edits failed");
  expect(await recent.json()).toMatchObject({
    total: 2,
    page: 1,
    items: [{ reverts_id: first, program: { id, name: "夏令营", school: "测试大学" } }, {}],
  });
  expect((await api.edits.$get({ query: {} }, guest)).status).toBe(401);
});
