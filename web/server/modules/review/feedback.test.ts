import type { z } from "@hono/zod-openapi";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import { applyStored, createProgram, toStoredFields } from "../programs/service.ts";
import type { FeedbackInput } from "./schemas.ts";

const api = testClient(app).api.v1;
type As = { headers: Record<string, string> };
let member: As, editor: As, admin: As, owner: As, muted: As;

async function session(profile: FakeUser): Promise<As> {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

beforeAll(async () => {
  [member, editor, admin, owner, muted] = await Promise.all(fakeUsers.slice(0, 5).map(session));
});

let programId = 0;
let collegeId = 0;

beforeEach(async () => {
  await sql`truncate schools, messages cascade`.execute(db);
  const school = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_names: [] })
    .returning("id")
    .executeTakeFirstOrThrow();
  ({ id: collegeId } = await db
    .insertInto("colleges")
    .values({ school_id: school.id, name: "计算机学院", kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow());
  programId = await program();
});

const DEADLINE = { date: "2026-06-14", time: "17:00" };

// A program whose notice said when applying ends.
async function program() {
  const source = await db
    .insertInto("sources")
    .values({ college_id: collegeId, url: `https://cs.example/${Math.random()}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  const notice = await db
    .insertInto("notices")
    .values({ source_id: source.id, url: `https://cs.example/${Math.random()}`, title: "通知" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const snapshot = await db
    .insertInto("snapshots")
    .values({ notice_id: notice.id, fetched_at: new Date(), html: "", text: "报名时间" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return db.transaction().execute(async (trx) => {
    const id = await createProgram(trx, {
      college_id: collegeId,
      cohort: 2027,
      kind: "summer_camp",
      name: "夏令营",
    });
    const fields = {
      apply: { value: { end: DEADLINE }, evidence: [{ quote: "报名时间" }], confidence: 1 },
    };
    const version = await trx
      .insertInto("program_versions")
      .values({
        program_id: id,
        snapshot_id: snapshot.id,
        number: 1,
        role: "call",
        fields: JSON.stringify(fields),
        changes: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await applyStored(trx, id, version.id, toStoredFields(fields));
    return id;
  });
}

const why = { reason: "补充通知改了截止", basis: "https://cs.example/notices/2" };
const later = { date: "2026-06-20", time: "17:00" };
const moved = { date: "2026-06-16", time: "17:00" };

async function give(as: As, json: z.input<typeof FeedbackInput>, id = programId) {
  const res = await api.programs[":id"].feedback.$post({ param: { id: String(id) }, json }, as);
  return { status: res.status, id: res.status === 201 ? (await res.json()).id : null };
}

async function waiting(id = programId) {
  const res = await api.programs[":id"].feedback.$get({ param: { id: String(id) } }, member);
  if (res.status !== 200) throw new Error("List failed");
  return (await res.json()).feedback.map((f) => [f.user.display_name, f.kind, f.field, f.reason]);
}

async function detail(id = programId) {
  const res = await api.programs[":id"].$get({ param: { id: String(id) } }, member);
  if (res.status !== 200) throw new Error("Detail failed");
  return res.json();
}

async function messages() {
  const rows = await db
    .selectFrom("messages")
    .innerJoin("users", "users.id", "messages.user_id")
    .select(["users.display_name", "messages.title", "messages.body"])
    .orderBy("messages.id")
    .execute();
  return rows.map((m) => [m.display_name, m.title, m.body]);
}

function withdraw(id: number | null, as: As) {
  return api.feedback[":id"].$delete({ param: { id: String(id) } }, as);
}

function accept(id: number, as = editor) {
  return api.feedback[":id"].accept.$post({ param: { id: String(id) } }, as);
}

function reject(id: number, note: string, as = editor) {
  return api.feedback[":id"].reject.$post({ param: { id: String(id) }, json: { note } }, as);
}

test("feedback says where, once each place a person waits on; muted members can't give it", async () => {
  const whole = await give(member, { kind: "problem", field: null, reason: "和另一个项目重复了" });
  expect(whole.status).toBe(201);
  const first = await give(member, { kind: "edit", field: "apply:end", value: later, ...why });
  if (first.id === null) throw new Error("Give failed");
  // Again for the same place: it replaces the one waiting, whose id a reviewer can't pass.
  const again = await give(member, { kind: "problem", field: "apply:end", reason: "截止不对" });
  expect(await waiting()).toEqual([
    ["鼠鼠", "problem", null, "和另一个项目重复了"],
    ["鼠鼠", "problem", "apply:end", "截止不对"],
  ]);
  expect((await accept(first.id)).status).toBe(404);

  expect((await give(muted, { kind: "problem", field: null, reason: "不对" })).status).toBe(403);
  expect(
    (await give(member, { kind: "edit", field: "apply:end", value: "明天", ...why })).status,
  ).toBe(400);
  expect((await give(member, { kind: "edit", field: "nope", value: null, ...why })).status).toBe(
    400,
  );
  expect((await give(member, { kind: "problem", field: "constructor", reason: "x" })).status).toBe(
    400,
  );
  // An other date's label as DateItem keeps it, and both ends of its window as written.
  const window = { end: DEADLINE };
  expect(
    (await give(member, { kind: "edit", field: "dates:初试 ", value: window, ...why })).status,
  ).toBe(400);
  expect(
    (
      await give(member, {
        kind: "edit",
        field: "dates:初试",
        value: { start: { date: "6月1日" }, ...window },
        ...why,
      })
    ).status,
  ).toBe(400);
  expect((await give(member, { kind: "edit", field: "name", value: null, ...why })).status).toBe(
    400,
  );
  expect(
    (await give(member, { kind: "edit", field: "apply:end", value: DEADLINE, ...why })).status,
  ).toBe(400);
  expect(
    (await give(member, { kind: "edit", field: "quota", value: "10 人", reason: "x", basis: "" }))
      .status,
  ).toBe(400);

  // Only its giver withdraws it.
  expect((await withdraw(again.id, editor)).status).toBe(404);
  expect((await withdraw(again.id, member)).status).toBe(204);
  expect(await waiting()).toEqual([["鼠鼠", "problem", null, "和另一个项目重复了"]]);
});

test("an accepted edit request is the reviewer's edit and links to it; L3 decide others' only", async () => {
  const { id } = await give(member, { kind: "edit", field: "apply:end", value: later, ...why });
  if (id === null) throw new Error("Give failed");
  expect((await accept(id, member)).status).toBe(403);
  const own = await give(editor, { kind: "edit", field: "quota", value: "10 人", ...why });
  if (own.id === null) throw new Error("Give failed");
  expect((await accept(own.id, editor)).status).toBe(403);

  // The review page sets what it is now beside what it was, and says it changed.
  await api.programs[":id"].$patch(
    { param: { id: String(programId) }, json: { apply: { end: moved }, ...why } },
    admin,
  );
  const queue = await api.feedback.$get({ query: {} }, editor);
  if (queue.status !== 200) throw new Error("Queue failed");
  expect((await queue.json()).items.map((f) => [f.field, f.current_value, f.changed])).toEqual([
    ["apply:end", moved, true],
    ["quota", null, false],
  ]);

  expect((await accept(id)).status).toBe(204);
  expect((await accept(id)).status).toBe(404);
  expect((await detail()).fields.apply?.end?.value).toEqual(later);
  const history = await api.programs[":id"].edits.$get(
    { param: { id: String(programId) } },
    member,
  );
  if (history.status !== 200) throw new Error("History failed");
  expect((await history.json()).edits[0]).toMatchObject({
    field: "apply:end",
    new_value: later,
    user: { display_name: "仓鼠" },
    feedback_id: id,
    ...why,
  });

  expect((await reject(own.id, "", admin)).status).toBe(400);
  expect((await reject(own.id, "原文没写名额", admin)).status).toBe(204);
});

test("those who gave feedback hear how it ended", async () => {
  const problem = await give(member, { kind: "problem", field: "apply:end", reason: "截止不对" });
  const edit = await give(member, { kind: "edit", field: "quota", value: "10 人", ...why });
  if (problem.id === null || edit.id === null) throw new Error("Give failed");
  await accept(problem.id);
  await reject(edit.id, "原文没写名额");
  expect(await messages()).toEqual([
    ["鼠鼠", "你对「夏令营」的反馈已改正", ""],
    ["鼠鼠", "你对「夏令营」的修改申请未通过", "原文没写名额"],
  ]);
});

test("three people finding a program wrong dispute it until an admin reviews it", async () => {
  await give(member, { kind: "problem", field: "apply:end", reason: "截止不对" });
  const second = await give(editor, { kind: "edit", field: "apply:end", value: later, ...why });
  if (second.id === null) throw new Error("Give failed");
  await reject(second.id, "原文就是 14 日", admin);
  expect((await detail()).disputed).toBe(false);
  // Rejected still counts; the same person again doesn't.
  await give(member, { kind: "problem", field: null, reason: "不该收" });
  expect((await detail()).disputed).toBe(false);
  const third = await give(owner, { kind: "problem", field: null, reason: "日期对不上" });
  if (third.id === null) throw new Error("Give failed");
  expect((await detail()).disputed).toBe(true);
  const table = await api.programs.$get({ query: { cohort: "2027" } }, member);
  if (table.status !== 200) throw new Error("Table failed");
  expect((await table.json()).programs.map((p) => p.disputed)).toEqual([true]);

  // It stays though one is withdrawn, which still shows.
  await api.feedback[":id"].$delete({ param: { id: String(third.id) } }, owner);
  expect((await detail()).disputed).toBe(true);
  const open = async () => {
    const res = await api.disputes.$get({}, admin);
    if (res.status !== 200) throw new Error("Disputes failed");
    return (await res.json()).disputes;
  };
  const [dispute] = await open();
  expect(dispute.feedback.map((f) => [f.reason, f.status])).toEqual([
    ["截止不对", "pending"],
    ["补充通知改了截止", "rejected"],
    ["不该收", "pending"],
    ["日期对不上", "withdrawn"],
  ]);

  const confirmed = { result: "confirmed", note: "核对原文没错" } as const;
  const resolve = (id: number, as = admin) =>
    api.disputes[":id"].resolve.$post({ param: { id: String(id) }, json: confirmed }, as);
  expect((await resolve(dispute.id, editor)).status).toBe(403);
  expect((await resolve(dispute.id)).status).toBe(204);
  expect((await detail()).disputed).toBe(false);
  expect(await waiting()).toEqual([]);
  const closed = await db
    .selectFrom("feedback")
    .select(["status", "review_note"])
    .where("user_id", "in", db.selectFrom("users").select("id").where("display_name", "=", "鼠鼠"))
    .execute();
  expect(closed).toEqual([
    { status: "rejected", review_note: "核对原文没错" },
    { status: "rejected", review_note: "核对原文没错" },
  ]);
  const history = await api.programs[":id"].edits.$get(
    { param: { id: String(programId) } },
    member,
  );
  if (history.status !== 200) throw new Error("History failed");
  expect((await history.json()).reviews).toMatchObject([
    { by: { display_name: "管理鼠" }, result: "confirmed", note: "核对原文没错" },
  ]);

  // Counted afresh after it; deciding the old one again, as from a page loaded before, leaves the
  // new one be.
  await give(member, { kind: "problem", field: null, reason: "还是不对" });
  await give(editor, { kind: "problem", field: null, reason: "还是不对" });
  expect((await detail()).disputed).toBe(false);
  await give(owner, { kind: "problem", field: null, reason: "还是不对" });
  expect((await detail()).disputed).toBe(true);
  expect((await resolve(dispute.id)).status).toBe(409);
  expect((await open()).map((d) => d.feedback.length)).toEqual([3]);
});

test("a deleted program's feedback waiting closes, and what was withdrawn stays so", async () => {
  const withdrawn = await give(member, { kind: "problem", field: "apply:end", reason: "撤回的" });
  await withdraw(withdrawn.id, member);
  await give(editor, { kind: "problem", field: null, reason: "不是保研通知" });
  const res = await api.programs[":id"].$delete(
    { param: { id: String(programId) }, json: { reason: "不是保研通知" } },
    admin,
  );
  expect(res.status).toBe(204);
  const statuses = await db
    .selectFrom("feedback")
    .select(["reason", "status", "review_note"])
    .orderBy("id")
    .execute();
  expect(statuses).toEqual([
    { reason: "撤回的", status: "withdrawn", review_note: null },
    { reason: "不是保研通知", status: "rejected", review_note: "项目已删除" },
  ]);
  expect(await messages()).toEqual([["仓鼠", "你对「夏令营」的反馈已处理", "项目已删除"]]);
});

test("feedback through an Agent says so, and is ten a day", async () => {
  const made = await api.me.tokens.$post(
    { json: { name: "我的 Codex", scope: "personal" } },
    member,
  );
  if (made.status !== 201) throw new Error("Make failed");
  const agent = { headers: { authorization: `Bearer ${(await made.json()).token}` } };
  const places = [
    "apply:start",
    "apply:end",
    "apply_url",
    "event:start",
    "event:end",
    "event:mode",
    "event:place",
    "degrees",
    "majors",
    "requirements",
  ];
  for (const field of places) {
    expect((await give(agent, { kind: "problem", field, reason: "不对" })).status).toBe(201);
  }
  expect((await give(agent, { kind: "problem", field: "materials", reason: "不对" })).status).toBe(
    429,
  );
  // On the web, as many as one likes.
  expect((await give(member, { kind: "problem", field: "materials", reason: "不对" })).status).toBe(
    201,
  );
  const given = await db.selectFrom("feedback").select("via").orderBy("id").execute();
  expect(given.map((f) => f.via)).toEqual([...places.map(() => "agent"), "web"]);
});
