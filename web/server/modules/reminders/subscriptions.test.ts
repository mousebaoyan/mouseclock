import { testClient } from "hono/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fakeUsers, revoked, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login, refreshUsers } from "../accounts/service.ts";
import { acceptReviewItem, removeProgram } from "../ingest/review-items.ts";
import type { TimeValue } from "../programs/schemas.ts";
import { applyStored, createProgram, setFields, toStoredFields } from "../programs/service.ts";
import type { MessageKind } from "./kinds.ts";
import { sendDeadlineMessages } from "./subscriptions.ts";

const v1 = testClient(app).api.v1;

type Session = { headers: { cookie: string; origin: string } };
const people = new Map<string, { id: number; as: Session }>();

async function signIn(profile: FakeUser) {
  const token = await login(profile, `fake-${profile.id}`, { ip: null, userAgent: "test" });
  const { id } = await db
    .selectFrom("users")
    .select("id")
    .where("mousehole_id", "=", profile.id)
    .executeTakeFirstOrThrow();
  people.set(profile.display_name, {
    id,
    as: { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } },
  });
}

function person(name: string) {
  const found = people.get(name);
  if (!found) throw new Error(`${name} isn't signed in`);
  return found;
}

// Beijing time, as the design states every time.
function at(beijing: string) {
  vi.setSystemTime(new Date(`${beijing}+08:00`));
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-06-01T12:00:00");
  await Promise.all(fakeUsers.map(signIn));
});

afterAll(() => vi.useRealTimers());

let college = { id: 0, sourceId: 0 };

beforeEach(async () => {
  at("2026-06-01T12:00:00");
  await sql`truncate schools, messages cascade`.execute(db);
  const school = await db
    .insertInto("schools")
    .values({ name: "北辰大学", short_names: [], tier: "985" })
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
    .values({ college_id: id, url: "https://cs.example/" })
    .returning("id")
    .executeTakeFirstOrThrow();
  college = { id, sourceId: source.id };
});

let notices = 0;

// A program, its first notice giving `deadline` and `more`.
async function program(
  name: string,
  deadline: TimeValue | null,
  more: { rolling?: true; apply_url?: string } = {},
) {
  const id = await db
    .transaction()
    .execute((trx) =>
      createProgram(trx, { college_id: college.id, cohort: 2027, kind: "summer_camp", name }),
    );
  await notice(id, "夏令营报名通知", { ...(deadline && { end: deadline }), ...more });
  return id;
}

// A notice with a version of the program giving these fields.
async function notice(
  programId: number,
  title: string,
  fields: { start?: TimeValue; end?: TimeValue; rolling?: true; apply_url?: string },
) {
  notices += 1;
  await db.transaction().execute(async (trx) => {
    const { source_id } = await trx
      .selectFrom("sources")
      .innerJoin("programs", "programs.college_id", "sources.college_id")
      .select("sources.id as source_id")
      .where("programs.id", "=", programId)
      .executeTakeFirstOrThrow();
    const n = await trx
      .insertInto("notices")
      .values({
        source_id,
        url: `https://cs.example/${notices}`,
        title,
        published_on: "2026-05-01",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const snapshot = await trx
      .insertInto("snapshots")
      .values({ notice_id: n.id, fetched_at: new Date(), html: "", text: "报名" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { count } = await trx
      .selectFrom("program_versions")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("program_id", "=", programId)
      .executeTakeFirstOrThrow();
    const version = await trx
      .insertInto("program_versions")
      .values({
        program_id: programId,
        snapshot_id: snapshot.id,
        number: Number(count) + 1,
        role: "call",
        fields: {},
        changes: [],
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const support = { evidence: [{ quote: "报名" }], confidence: 1 };
    const { apply_url, ...apply } = fields;
    await applyStored(
      trx,
      programId,
      version.id,
      toStoredFields({
        ...(Object.keys(apply).length > 0 && { apply: { value: apply, ...support } }),
        ...(apply_url && { apply_url: { value: apply_url, ...support } }),
      }),
    );
  });
}

async function subscribe(name: string, programId: number) {
  return v1.programs[":id"].subscription.$put(
    { param: { id: String(programId) } },
    person(name).as,
  );
}

// What came to a member, oldest first: its kind, and its title and body as one line.
async function messagesOf(name: string) {
  const rows = await db
    .selectFrom("messages")
    .select(["kind", "title", "body"])
    .where("user_id", "=", person(name).id)
    .orderBy("id")
    .execute();
  return rows.map((m) => ({ kind: m.kind, text: `${m.title} ${m.body}` }));
}

// The messages a member got, each of its kind and saying what design §11.3 has it say.
async function expectMessages(name: string, expected: [MessageKind, ...string[]][]) {
  const got = await messagesOf(name);
  expect(got.map((m) => m.kind)).toEqual(expected.map(([kind]) => kind));
  for (const [i, [, ...facts]] of expected.entries()) {
    for (const fact of facts) expect(got[i].text).toContain(fact);
  }
}

async function tick(beijing: string) {
  at(beijing);
  await sendDeadlineMessages();
}

const JUNE_30 = { date: "2026-06-30", time: "17:00" };

// The review page's 可能重复, accepted: `duplicate` goes into `kept` (design §12.2).
async function merge(duplicate: number, kept: number) {
  const { snapshot_id, name } = await db
    .selectFrom("program_versions as v")
    .innerJoin("programs as p", "p.id", "v.program_id")
    .select(["v.snapshot_id", "p.name"])
    .where("v.program_id", "=", duplicate)
    .executeTakeFirstOrThrow();
  const { id } = await db
    .insertInto("review_items")
    .values({
      reason: "possible_duplicate",
      program_id: duplicate,
      snapshot_id,
      payload: {
        college_id: college.id,
        cohort: 2027,
        kind: "summer_camp",
        name,
        role: "call",
        fields: {},
      },
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await acceptReviewItem({ user_id: person("管理鼠").id, via: "web" }, id, { program_id: kept });
}

test("ten at once, closed ones too, until they are cleared; the table's tag follows", async () => {
  // Two closed, then open ones whose deadlines come in the other order to their ids.
  const ids = [];
  for (let i = 1; i <= 11; i++) {
    const day = i <= 2 ? `2026-05-2${i}` : `2026-07-${String(20 - i).padStart(2, "0")}`;
    ids.push(await program(`项目 ${i}`, { date: day }));
  }
  const tag = async () =>
    (await v1.programs.$get({ query: { cohort: "2027" } }, person("鼠鼠").as)).headers.get("etag");
  const before = await tag();
  for (const id of ids.slice(0, 10)) expect((await subscribe("鼠鼠", id)).status).toBe(204);
  expect(await tag()).not.toBe(before);
  expect((await subscribe("鼠鼠", ids[0])).status).toBe(204);

  const full = await subscribe("鼠鼠", ids[10]);
  expect(full.status).toBe(409);
  expect(await full.json()).toMatchObject({ error: { code: "subscription_limit" } });

  const res = await v1.me.subscriptions.$get({}, person("鼠鼠").as);
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const mine = await res.json();
  expect(mine.limit).toBe(10);
  // The open ones by deadline, then the closed ones, the latest to close first.
  expect(mine.programs.map((p) => p.id)).toEqual([
    ...ids.slice(2, 10).toReversed(),
    ids[1],
    ids[0],
  ]);
  expect(mine.programs[0].subscribers).toBe(1);

  const unsubscribed = await tag();
  await v1.programs[":id"].subscription.$delete(
    { param: { id: String(ids[2]) } },
    person("鼠鼠").as,
  );
  expect(await tag()).not.toBe(unsubscribed);
  await v1.me.subscriptions.closed.$delete({}, person("鼠鼠").as);
  expect((await subscribe("鼠鼠", ids[10])).status).toBe(204);
  const after = await v1.me.subscriptions.$get({}, person("鼠鼠").as);
  if (after.status !== 200) throw new Error(`status ${after.status}`);
  expect((await after.json()).programs.map((p) => p.id)).toEqual(ids.slice(3, 11).toReversed());
});

test("reminded three days before the deadline's day at 9 in Beijing, once, with the original and where to apply", async () => {
  const id = await program("2027 年夏令营", JUNE_30, {
    rolling: true,
    apply_url: "https://apply.example/",
  });
  await subscribe("鼠鼠", id);
  await tick("2026-06-27T08:59:00");
  expect(await messagesOf("鼠鼠")).toEqual([]);
  await tick("2026-06-27T09:00:00");
  const reminded = [
    "deadline_soon",
    "「2027 年夏令营」快截止了",
    "6月30日 17:00 截止",
    "还剩 3 天",
    "额满即止",
  ] satisfies [MessageKind, ...string[]];
  await expectMessages("鼠鼠", [reminded]);
  await tick("2026-06-28T09:00:00");
  await expectMessages("鼠鼠", [reminded]);
  const email = await db
    .selectFrom("emails")
    .select("body")
    .where("user_id", "=", person("鼠鼠").id)
    .executeTakeFirstOrThrow();
  expect(email.body).toContain("通知原文：https://cs.example/");
  expect(email.body).toContain("报名入口：https://apply.example/");
});

test("subscribing past the time to remind reminds at once, unless it closed", async () => {
  const soon = await program("快截止的", { date: "2026-07-01", mark: "before" });
  const closed = await program("截止了的", { date: "2026-06-29" });
  at("2026-06-30T10:00:00");
  await subscribe("鼠鼠", soon);
  await subscribe("鼠鼠", closed);
  const reminded = ["deadline_soon", "「快截止的」", "7月1日前 截止", "就在今天"] satisfies [
    MessageKind,
    ...string[],
  ];
  await expectMessages("鼠鼠", [reminded]);
  await tick("2026-06-30T10:01:00");
  await expectMessages("鼠鼠", [reminded]);
});

test("a deadline that moves is told once, with what it was and why, and reminded of anew", async () => {
  const id = await program("2027 年夏令营", JUNE_30);
  await subscribe("鼠鼠", id);
  await notice(id, "关于延长报名时间的通知", { end: { date: "2026-07-05" } });
  await tick("2026-06-02T12:00:00");
  await tick("2026-06-02T12:01:00");
  // The same moment written another way isn't news, nor another part of the apply field.
  await notice(id, "报名通知（更正）", { end: { date: "2026-07-05", time: "24:00" } });
  await notice(id, "补充通知", { start: { date: "2026-06-05" } });
  await tick("2026-06-02T12:02:00");
  // Reminded of the new deadline at its time, not the old one's.
  await tick("2026-06-27T09:00:00");
  await tick("2026-07-02T09:00:00");
  at("2026-07-02T12:00:00");
  await db.transaction().execute((trx) => setFields(trx, id, [["apply:end", null]]));
  await tick("2026-07-02T12:01:00");
  // Past the time to remind of it, the message about it is the reminder.
  at("2026-07-08T12:00:00");
  await notice(id, "再次延长", { end: { date: "2026-07-10", time: "12:00" } });
  await tick("2026-07-08T12:01:00");
  await tick("2026-07-09T12:00:00");
  await expectMessages("鼠鼠", [
    ["deadline_changed", "改为 7月5日", "原为 6月30日 17:00", "依据通知「关于延长报名时间的通知」"],
    ["deadline_soon", "7月5日 24:00 截止", "还剩 3 天"],
    ["deadline_changed", "已清空", "原为 7月5日 24:00", "人工修改"],
    ["deadline_changed", "改为 7月10日 12:00（还剩 2 天）", "原来未注明", "依据通知「再次延长」"],
  ]);
});

test("a merge moves subscriptions to the one kept, one for those on both; deleting drops them", async () => {
  const kept = await program("夏令营", JUNE_30);
  const duplicate = await program("夏令营（重复）", { date: "2026-06-30" });
  const removed = await program("不是招生通知", JUNE_30);
  await subscribe("鼠鼠", duplicate);
  await subscribe("仓鼠", duplicate);
  await subscribe("仓鼠", kept);
  await subscribe("仓鼠", removed);
  await merge(duplicate, kept);
  await removeProgram({ user_id: person("管理鼠").id, via: "web" }, removed, "不是招生通知");
  expect((await subscribe("鼠鼠", removed)).status).toBe(404);

  const subscribed = await db
    .selectFrom("subscriptions")
    .select(["user_id", "program_id"])
    .execute();
  expect(subscribed).toHaveLength(2);
  expect(subscribed).toEqual(
    expect.arrayContaining([
      { user_id: person("鼠鼠").id, program_id: kept },
      { user_id: person("仓鼠").id, program_id: kept },
    ]),
  );
  // What the duplicate said differs from the one kept.
  await tick("2026-06-01T12:01:00");
  await expectMessages("鼠鼠", [
    ["deadline_changed", "「夏令营」报名截止变了", "改为 6月30日 17:00", "原为 6月30日；"],
  ]);
  await expectMessages("仓鼠", []);
});

test("those mousehole turns down are refreshed for their subscriptions and get nothing until they log in again", async () => {
  const id = await program("2027 年夏令营", JUNE_30);
  await subscribe("鼠鼠", id);
  await subscribe("仓鼠", id);
  await db.deleteFrom("sessions").where("user_id", "=", person("鼠鼠").id).execute();
  revoked.add(fakeUsers[0].id);
  at("2026-06-01T14:00:00");
  await refreshUsers();
  revoked.clear();
  await tick("2026-06-27T09:00:00");
  await expectMessages("鼠鼠", []);
  await expectMessages("仓鼠", [["deadline_soon"]]);

  await signIn(fakeUsers[0]);
  await notice(id, "关于延长报名时间的通知", { end: { date: "2026-07-05" } });
  await tick("2026-06-27T09:01:00");
  await expectMessages("鼠鼠", [["deadline_changed", "改为 7月5日"]]);
});
