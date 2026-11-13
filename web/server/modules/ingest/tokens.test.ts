import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";

const v1 = testClient(app).api.v1;
const tokens = v1.admin["crawler-tokens"];

let admin = { headers: {} };
let owner = admin;

async function session(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

beforeAll(async () => {
  [admin, owner] = await Promise.all([session(fakeUsers[2]), session(fakeUsers[3])]);
});

test("the owner makes a token the crawler can use, and revoking it stops it at once", async () => {
  expect((await tokens.$post({ json: { name: " " } }, owner)).status).toBe(400);
  const made = await tokens.$post({ json: { name: "上海" } }, owner);
  if (made.status !== 201) throw new Error(`status ${made.status}`);
  const { token } = await made.json();
  const crawler = { headers: { authorization: `Bearer ${token}` } };
  expect((await v1.crawler.work.$get({}, crawler)).status).toBe(200);

  const list = await tokens.$get({}, owner);
  if (list.status !== 200) throw new Error(`status ${list.status}`);
  const [listed] = await list.json();
  expect(listed).toMatchObject({ name: "上海", revoked_at: null });
  expect(listed.last_seen_at).not.toBeNull();

  const revoke = (as: typeof owner) =>
    tokens[":id"].revoke.$post({ param: { id: String(listed.id) } }, as);
  expect((await revoke(owner)).status).toBe(204);
  expect((await v1.crawler.work.$get({}, crawler)).status).toBe(401);
  expect((await revoke(owner)).status).toBe(409);

  const audit = await db
    .selectFrom("audit_log")
    .select("action")
    .where("target_type", "=", "crawler_token")
    .where("target_id", "=", listed.id)
    .orderBy("id")
    .execute();
  expect(audit.map((row) => row.action)).toEqual(["create", "revoke"]);
});

test("only the owner sees, makes and revokes tokens", async () => {
  expect((await tokens.$get({}, admin)).status).toBe(403);
  expect((await tokens.$post({ json: { name: "x" } }, admin)).status).toBe(403);
  const revoke = tokens[":id"].revoke.$post({ param: { id: "1" } }, admin);
  expect((await revoke).status).toBe(403);
  expect((await tokens.$get({})).status).toBe(401);
});
