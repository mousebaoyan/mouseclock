import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import { createCrawlerToken } from "../ingest/service.ts";

const v1 = testClient(app).api.v1;
const api = v1.crawler;

let crawler = { headers: {} };
let editor = { headers: {} };

async function session(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

beforeAll(async () => {
  crawler = { headers: { authorization: `Bearer ${await createCrawlerToken("test")}` } };
  editor = await session(fakeUsers[1]);
});

const BODY = "报名时间：2026年6月1日8:00至6月14日17:00，逾期不予受理。";
const APPLY = {
  value: {
    start: { date: "2026-06-01", time: "08:00" },
    end: { date: "2026-06-14", time: "17:00" },
  },
  evidence: [{ quote: "报名时间：2026年6月1日8:00至6月14日17:00" }],
  confidence: 0.95,
};
const now = Math.floor(Date.now() / 1000);

let cs = 0;
let source = 0;

// A college with a source whose first round read its list an hour ago, and someone following it.
beforeEach(async () => {
  await sql`truncate schools, follows, messages, announced_notices restart identity cascade`.execute(
    db,
  );
  const school = await db
    .insertInto("schools")
    .values({ name: "测试大学" })
    .returning("id")
    .executeTakeFirstOrThrow();
  ({ id: cs } = await db
    .insertInto("colleges")
    .values({ school_id: school.id, name: "计算机学院", kind: "college", region: "四川" })
    .returning("id")
    .executeTakeFirstOrThrow());
  source = await sourceOf(cs, "https://cs.example/tzgg.htm", true);
  const [follower] = await Promise.all(fakeUsers.slice(0, 1).map(session));
  expect(
    (await v1.colleges[":id"].follow.$put({ param: { id: String(cs) } }, follower)).status,
  ).toBe(204);
});

async function sourceOf(collegeId: number, url: string, crawledBefore: boolean) {
  const { id } = await db
    .insertInto("sources")
    .values({ college_id: collegeId, url })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (crawledBefore) await round(id, now - 3600);
  return id;
}

async function round(sourceId: number, startedAt: number, failure?: "no_items") {
  const json = {
    source_id: sourceId,
    started_at: startedAt,
    finished_at: startedAt + 60,
    ...(failure ? { failure, detail: "" } : {}),
    listed: 0,
    new_count: 0,
    useful_count: 0,
    notice_failures: [],
    usage: [],
  };
  expect((await api.runs.$post({ json }, crawler)).status).toBe(204);
}

// A notice first seen `ago` seconds back, with a call for `collegeId` in it.
async function notice(
  sourceId: number,
  url: string,
  title: string,
  ago: number,
  collegeId = cs,
  cohort = 2027,
) {
  const { id } = await db
    .insertInto("notices")
    .values({
      source_id: sourceId,
      url,
      title,
      published_on: "2026-05-19",
      first_seen_at: new Date((now - ago) * 1000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const snap = await api.notices[":id"].snapshot.$post(
    {
      param: { id: String(id) },
      json: { fetched_at: Math.floor(now - ago), html: "", text: BODY, attachments: [] },
    },
    crawler,
  );
  if (snap.status !== 200) throw new Error(`status ${snap.status}`);
  const { snapshot_id } = await snap.json();
  const res = await api.snapshots[":id"].extraction.$post(
    {
      param: { id: String(snapshot_id) },
      json: {
        programs: [
          {
            college_id: collegeId,
            cohort,
            kind: "summer_camp",
            name: title,
            role: "call",
            fields: { apply: APPLY },
          },
        ],
        usage: [],
      },
    },
    crawler,
  );
  expect(res.status).toBe(204);
  return snapshot_id;
}

async function messages() {
  const rows = await db
    .selectFrom("messages")
    .select(["kind", "title", "body", "link"])
    .orderBy("id")
    .execute();
  return rows.map((m) => [m.kind, m.title, m.body, m.link]);
}

test("followers hear once of a round's new notices, by college, not of those reached back for", async () => {
  // Found by the first round, which reaches back: from past years, most likely.
  await notice(source, "https://cs.example/old.htm", "去年的夏令营", 3590);
  await round(source, now - 120);
  expect(await messages()).toEqual([]);

  await notice(source, "https://cs.example/1.htm", "夏令营通知", 60);
  await round(source, now - 60);
  const [program] = await db
    .selectFrom("programs")
    .select("id")
    .where("name", "=", "夏令营通知")
    .execute();
  const one = [
    "college_news",
    "测试大学 计算机学院发了 1 条新通知",
    "「夏令营通知」（报名）",
    `/programs/${program.id}`,
  ];
  expect(await messages()).toEqual([one]);

  // Two in a round: one message, to the college; the last round sent again tells of nothing.
  await notice(source, "https://cs.example/2.htm", "补充通知", 50);
  await notice(source, "https://cs.example/3.htm", "延期通知", 40);
  await round(source, now - 60);
  expect(await messages()).toEqual([one]);
  await round(source, now - 30);
  expect(await messages()).toEqual([
    one,
    [
      "college_news",
      "测试大学 计算机学院发了 2 条新通知",
      "「补充通知」（报名）；「延期通知」（报名）",
      `/colleges/${cs}`,
    ],
  ]);
});

test("a notice seen first under another source, or in a source's first round, is no news", async () => {
  const graduate = await sourceOf(cs, "https://grad.example/tzgg.htm", true);
  await notice(graduate, "https://cs.example/1.htm", "夏令营通知", 60);
  await round(graduate, now - 30);
  await notice(source, "https://cs.example/1.htm", "夏令营通知", 30);
  await round(source, now - 10);
  // A first round that failed to read its list leaves the next the first, which ends in the same
  // second as it lists the last of its notices.
  const fresh = await sourceOf(cs, "https://new.example/tzgg.htm", false);
  await round(fresh, now - 600, "no_items");
  await notice(fresh, "https://new.example/1.htm", "往年的通知", 59.5);
  await round(fresh, now - 120);
  expect((await messages()).map((m) => m[2])).toEqual(["「夏令营通知」（报名）"]);
});

test("a held program is told of once a reviewer places it", async () => {
  const snap = await notice(source, "https://cs.example/1.htm", "夏令营通知", 60, cs, 2030);
  await round(source, now - 60);
  expect(await messages()).toEqual([]);
  const [item] = await db
    .selectFrom("review_items")
    .select("id")
    .where("snapshot_id", "=", snap)
    .execute();
  const res = await v1["review-items"][":id"].accept.$post(
    { param: { id: String(item.id) }, json: { college_id: cs, cohort: 2027 } },
    editor,
  );
  expect(res.status).toBe(204);
  expect((await messages()).map((m) => m[1])).toEqual(["测试大学 计算机学院发了 1 条新通知"]);
});
