import type { z } from "@hono/zod-openapi";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeEach, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import type { TagPatch } from "./schemas.ts";

const api = testClient(app).api.v1;
type As = { headers: Record<string, string> };

async function writer(profile: FakeUser): Promise<As> {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

let presets: { id: number; name: string }[] = [];

beforeEach(async () => {
  await sql`truncate schools, college_tags, audit_log restart identity cascade`.execute(db);
  presets = await db
    .insertInto("college_tags")
    .values([
      { name: "有机试", description: "考核里有上机编程", sort: 1 },
      { name: "看重科研", description: "考核看重论文和科研经历", sort: 2 },
      { name: "看重竞赛", description: "考核看重竞赛获奖", sort: 3 },
    ])
    .returning(["id", "name"])
    .execute();
});

async function college() {
  const school = await db
    .insertInto("schools")
    .values({ name: "测试大学", short_names: [], tier: "985" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id } = await db
    .insertInto("colleges")
    .values({ school_id: school.id, name: "计算机学院", kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

const param = (collegeId: number, tagId: number) => ({
  id: String(collegeId),
  tag: String(tagId),
});
const tag = (as: As, collegeId: number, tagId: number) =>
  api.colleges[":id"].tags[":tag"].$put({ param: param(collegeId, tagId) }, as);

async function page(as: As, collegeId: number) {
  const res = await api.colleges[":id"].$get({ param: { id: String(collegeId) } }, as);
  if (res.status !== 200) throw new Error("College failed");
  const { tags, tag_counts } = await res.json();
  return { tags, counts: tag_counts.map((t) => [t.name, t.count, t.mine]) };
}

async function listed(as: As) {
  const res = await api.colleges.$get({}, as);
  if (res.status !== 200) throw new Error("Colleges failed");
  return (await res.json()).schools.flatMap((s) => s.colleges.map((c) => c.tags));
}

test("a tag counts as the college's once three members put it on, one vote each", async () => {
  const id = await college();
  const [exam, research] = presets;
  const [one, two, three] = await Promise.all(fakeUsers.slice(0, 3).map(writer));
  expect((await tag(one, id, exam.id)).status).toBe(204);
  expect((await tag(one, id, exam.id)).status).toBe(204);
  await tag(two, id, exam.id);
  await tag(one, id, research.id);
  expect(await page(one, id)).toEqual({
    tags: [],
    counts: [
      ["有机试", 2, true],
      ["看重科研", 1, true],
      ["看重竞赛", 0, false],
    ],
  });

  await tag(three, id, exam.id);
  expect((await page(three, id)).tags).toEqual(["有机试"]);
  expect(await listed(one)).toEqual([["有机试"]]);

  const untag = () => api.colleges[":id"].tags[":tag"].$delete({ param: param(id, exam.id) }, one);
  expect((await untag()).status).toBe(204);
  expect((await untag()).status).toBe(204);
  expect((await page(one, id)).counts[0]).toEqual(["有机试", 2, false]);

  expect((await tag(one, id, exam.id + 100)).status).toBe(404);
  expect((await tag(one, id + 100, exam.id)).status).toBe(404);
});

test("muted and frozen members can't tag; only admins see who did and remove votes", async () => {
  const id = await college();
  const [exam] = presets;
  const [one, two, admin, , muted, frozen] = await Promise.all(fakeUsers.map(writer));
  const guest = { headers: { origin: env.PUBLIC_URL } };
  expect((await tag(guest, id, exam.id)).status).toBe(401);
  expect((await tag(muted, id, exam.id)).status).toBe(403);
  expect((await tag(frozen, id, exam.id)).status).toBe(403);
  await tag(one, id, exam.id);
  await tag(two, id, exam.id);

  const votes = (as: As) =>
    api.colleges[":id"].tags[":tag"].votes.$get({ param: param(id, exam.id) }, as);
  expect((await votes(one)).status).toBe(403);
  const seen = await votes(admin);
  if (seen.status !== 200) throw new Error("Votes failed");
  const [latest, earliest] = (await seen.json()).votes;
  expect([latest.user.display_name, earliest.user.display_name]).toEqual(["仓鼠", "鼠鼠"]);

  const removeVote = (as: As, vote: number) =>
    api.admin["tag-votes"][":id"].$delete({ param: { id: String(vote) } }, as);
  expect((await removeVote(one, latest.id)).status).toBe(403);
  expect((await removeVote(admin, latest.id)).status).toBe(204);
  expect((await removeVote(admin, latest.id)).status).toBe(404);
  expect((await page(one, id)).counts[0]).toEqual(["有机试", 1, true]);

  const cleared = await api.admin.colleges[":id"].tags[":tag"].$delete(
    { param: param(id, exam.id) },
    admin,
  );
  expect(cleared.status).toBe(204);
  expect((await page(one, id)).counts[0]).toEqual(["有机试", 0, false]);
  const audit = await db
    .selectFrom("audit_log")
    .select(["action", "target_type", "target_id"])
    .orderBy("id")
    .execute();
  expect(audit).toEqual([
    { action: "remove_vote", target_type: "college_tag", target_id: exam.id },
    { action: "clear", target_type: "college_tag", target_id: exam.id },
  ]);
});

async function order() {
  const tags = await db
    .selectFrom("college_tags")
    .select(["name", "sort"])
    .orderBy("sort")
    .execute();
  return tags.map((t) => `${t.sort}${t.name}`);
}

test("admins keep the presets: rename keeping the votes, reorder, delete with the votes", async () => {
  const id = await college();
  const { school_id } = await db
    .selectFrom("colleges")
    .select("school_id")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const { id: second } = await db
    .insertInto("colleges")
    .values({ school_id, name: "软件学院", kind: "college", region: "北京" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const [exam, research, contest] = presets;
  const [one, admin] = await Promise.all([fakeUsers[0], fakeUsers[2]].map(writer));
  await tag(one, id, exam.id);
  await tag(one, second, exam.id);
  const kept = await api.admin.tags.$get({}, admin);
  if (kept.status !== 200) throw new Error("Tags failed");
  // One member, however many colleges they put it on.
  expect((await kept.json()).tags.map((t) => t.voters)).toEqual([1, 0, 0]);
  const patch = (tagId: number, json: z.input<typeof TagPatch>) =>
    api.admin.tags[":id"].$patch({ param: { id: String(tagId) }, json }, admin);

  const json = { name: "有夏令营机试", description: "夏令营考核里有上机编程" };
  expect((await api.admin.tags.$post({ json }, one)).status).toBe(403);
  expect((await api.admin.tags.$post({ json }, admin)).status).toBe(201);
  expect((await api.admin.tags.$post({ json }, admin)).status).toBe(409);
  expect((await patch(research.id, { name: "有夏令营机试" })).status).toBe(409);

  expect((await patch(exam.id, { name: "要机试" })).status).toBe(204);
  expect((await page(one, id)).counts[0]).toEqual(["要机试", 1, true]);

  expect((await patch(contest.id, { sort: 1 })).status).toBe(204);
  expect(await order()).toEqual(["1看重竞赛", "2要机试", "3看重科研", "4有夏令营机试"]);
  expect((await patch(contest.id, { sort: 9 })).status).toBe(204);
  expect(await order()).toEqual(["1要机试", "2看重科研", "3有夏令营机试", "4看重竞赛"]);

  const removed = await api.admin.tags[":id"].$delete({ param: { id: String(exam.id) } }, admin);
  expect(removed.status).toBe(204);
  expect(await order()).toEqual(["1看重科研", "2有夏令营机试", "3看重竞赛"]);
  const votes = await db.selectFrom("college_tag_votes").select("id").execute();
  expect(votes).toEqual([]);
  const audit = await db
    .selectFrom("audit_log")
    .select(["action", "detail"])
    .where("action", "=", "delete")
    .executeTakeFirstOrThrow();
  expect(audit.detail).toMatchObject({
    before: { name: "要机试" },
    votes: [{ college_id: id }, { college_id: second }],
  });
});
