import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeEach, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";

const api = testClient(app).api.v1;
type As = { headers: Record<string, string> };

async function writer(profile: FakeUser): Promise<As> {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

let schoolId = 0;
let crawled = 0;
let waiting = 0;

beforeEach(async () => {
  await sql`truncate schools, inclusion_requests, follows, messages restart identity cascade`.execute(
    db,
  );
  ({ id: schoolId } = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_names: [] })
    .returning("id")
    .executeTakeFirstOrThrow());
  [crawled, waiting] = await Promise.all(["计算机学院", "软件学院"].map(college));
  await db
    .insertInto("sources")
    .values({ college_id: crawled, url: "https://cs.example/" })
    .execute();
});

async function college(name: string) {
  const { id } = await db
    .insertInto("colleges")
    .values({ school_id: schoolId, name, kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

function follow(as: As, id: number) {
  return api.colleges[":id"].follow.$put({ param: { id: String(id) } }, as);
}

function unfollow(as: As, id: number) {
  return api.colleges[":id"].follow.$delete({ param: { id: String(id) } }, as);
}

async function detail(as: As, id: number) {
  const res = await api.colleges[":id"].$get({ param: { id: String(id) } }, as);
  if (res.status !== 200) throw new Error("College failed");
  const { followers, following } = await res.json();
  return { followers, following };
}

async function asks(as: As) {
  const res = await api["inclusion-requests"].$get({ query: {} }, as);
  if (res.status !== 200) throw new Error("List failed");
  return (await res.json()).items.map((r) => [r.college.name, r.votes, r.mine, r.following]);
}

test("a college's page counts its followers; muted members follow too, guests and frozen don't", async () => {
  const [one, two, , , muted, frozen] = await Promise.all(fakeUsers.map(writer));
  expect((await follow(one, crawled)).status).toBe(204);
  expect((await follow(one, crawled)).status).toBe(204);
  expect((await follow(muted, crawled)).status).toBe(204);
  expect(await detail(one, crawled)).toEqual({ followers: 2, following: true });
  expect(await detail(two, crawled)).toEqual({ followers: 2, following: false });

  expect((await follow({ headers: { origin: env.PUBLIC_URL } }, crawled)).status).toBe(401);
  expect((await follow(frozen, crawled)).status).toBe(403);
  expect((await follow(one, waiting + 100)).status).toBe(404);

  expect((await unfollow(one, crawled)).status).toBe(204);
  expect((await unfollow(one, crawled)).status).toBe(204);
  expect(await detail(one, crawled)).toEqual({ followers: 1, following: false });
  // Following one crawled already asks for nothing.
  expect(await asks(one)).toEqual([]);
});

test("following a college not crawled yet asks for it: one vote each, gone with the last", async () => {
  const [one, two] = await Promise.all(fakeUsers.slice(0, 2).map(writer));
  await follow(one, waiting);
  expect(await asks(one)).toEqual([["软件学院", 1, true, true]]);

  // Voting as well is still one vote.
  const [{ id }] = await db.selectFrom("inclusion_requests").select("id").execute();
  const vote = api["inclusion-requests"][":id"].vote;
  await vote.$put({ param: { id: String(id) } }, two);
  await follow(two, waiting);
  expect(await asks(two)).toEqual([["软件学院", 2, true, true]]);

  // Withdrawing the vote leaves the follow's.
  await vote.$delete({ param: { id: String(id) } }, two);
  expect(await asks(two)).toEqual([["软件学院", 2, true, true]]);
  await unfollow(one, waiting);
  expect(await asks(two)).toEqual([["软件学院", 1, true, true]]);
  await unfollow(two, waiting);
  expect(await asks(two)).toEqual([]);
});

test("the muted follow a college not crawled yet without asking for it or counting as a vote", async () => {
  const [one, , , , muted] = await Promise.all(fakeUsers.slice(0, 5).map(writer));
  expect((await follow(muted, waiting)).status).toBe(204);
  expect(await detail(one, waiting)).toEqual({ followers: 1, following: false });
  expect(await asks(one)).toEqual([]);

  await follow(one, waiting);
  expect(await asks(one)).toEqual([["软件学院", 1, true, true]]);
  expect(await asks(muted)).toEqual([["软件学院", 1, false, true]]);
  // Nor do they keep the ask on the list.
  await unfollow(one, waiting);
  expect(await asks(one)).toEqual([]);
});

test("my follows go by school, those not crawled with how their ask goes; included tells them", async () => {
  const [one, , admin] = await Promise.all(fakeUsers.slice(0, 3).map(writer));
  await follow(one, waiting);
  await follow(one, crawled);
  const mine = async () => {
    const res = await api.me.follows.$get({ query: { cohort: "2027" } }, one);
    if (res.status !== 200) throw new Error("Follows failed");
    return (await res.json()).follows.map((f) => [f.college.name, f.crawled, f.request]);
  };
  const [{ id }] = await db.selectFrom("inclusion_requests").select("id").execute();
  expect(await mine()).toEqual([
    ["计算机学院", true, null],
    ["软件学院", false, { id, status: "queued" }],
  ]);

  const source = {
    college_id: waiting,
    url: "https://se.example/notices",
    section: "",
    browser: false,
    keep_all: false,
    config: null,
    unavailable_reason: null,
  };
  expect((await api.admin.sources.$post({ json: source }, admin)).status).toBe(201);
  expect(await mine()).toEqual([
    ["计算机学院", true, null],
    ["软件学院", true, null],
  ]);
  const messages = await db
    .selectFrom("messages")
    .innerJoin("users", "users.id", "messages.user_id")
    .select(["users.display_name", "messages.title", "messages.link"])
    .execute();
  expect(messages).toEqual([
    { display_name: "鼠鼠", title: "测试大学 软件学院已收录", link: `/colleges/${waiting}` },
  ]);
});
