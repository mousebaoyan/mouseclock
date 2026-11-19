import { testClient } from "hono/testing";
import { beforeAll, expect, test, vi } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import { sendEmails } from "./email.ts";
import type { MessageKind } from "./kinds.ts";
import { sendMessages } from "./messages.ts";

// What went out, from which mailbox with which password; the mailboxes that fail to log in, and
// the addresses the receiving server turns down.
const smtp = vi.hoisted(() => ({
  sent: new Array<string>(),
  failing: new Set<string>(),
  refusing: new Set<string>(),
}));

vi.mock("nodemailer", () => ({
  createTransport: ({ auth }: { auth: { user: string; pass: string } }) => ({
    sendMail: async ({ to }: { to: string }) => {
      if (smtp.failing.has(auth.user)) throw new Error("Invalid login: 535 Login fail");
      if (smtp.refusing.has(to)) {
        throw Object.assign(new Error("550 Mailbox not found"), {
          command: "RCPT TO",
          responseCode: 550,
        });
      }
      smtp.sent.push(`${auth.user}:${auth.pass} → ${to}`);
    },
  }),
}));

// Emails go a second or two apart; not here.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

const v1 = testClient(app).api.v1;

type Session = { headers: { cookie: string; origin: string } };
const people = new Map<string, { id: number; as: Session }>();

async function signIn(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
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

beforeAll(async () => {
  await Promise.all(fakeUsers.map(signIn));
});

async function send(kind: MessageKind, ...names: string[]) {
  await db.transaction().execute((trx) =>
    sendMessages(
      trx,
      kind,
      names.map((name) => ({
        user_id: person(name).id,
        title: "北辰大学 计算机学院「2027 年夏令营」快截止了",
        body: "6 月 30 日 17:00 截止，还剩 3 天",
        link: "/programs/1",
      })),
    ),
  );
}

async function messagesOf(name: string) {
  const res = await v1.messages.$get({ query: {} }, person(name).as);
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

async function unseen(name: string) {
  const res = await v1.me.$get({}, person(name).as);
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return (await res.json()).unseen_messages;
}

// A member's emails in order, each sent, dropped or still waiting.
async function emailsTo(name: string) {
  const rows = await db
    .selectFrom("emails")
    .select(["id", "sent_at", "dropped_at", "attempts", "next_at"])
    .where("user_id", "=", person(name).id)
    .orderBy("id")
    .execute();
  return rows.map(({ sent_at, dropped_at, ...email }) => ({
    ...email,
    state: sent_at ? "sent" : dropped_at ? "dropped" : "waiting",
  }));
}

// A QQ mailbox as the owner would enter it; without a password it keeps the saved one.
function box(username: string, password?: string) {
  return { host: "smtp.qq.com", port: 465, username, password };
}

test("messages reach members but not frozen accounts, and seeing them covers what the page showed", async () => {
  await send("deadline_soon", "鼠鼠", "冻结鼠");
  const [first] = await messagesOf("鼠鼠");
  expect(first).toMatchObject({ kind: "deadline_soon", link: "/programs/1", seen: false });
  expect(await unseen("鼠鼠")).toBe(1);
  expect(
    await db
      .selectFrom("messages")
      .select("id")
      .where("user_id", "=", person("冻结鼠").id)
      .execute(),
  ).toEqual([]);

  // One comes after the page opened, before it says what it showed was seen.
  await send("deadline_changed", "鼠鼠");
  const seen = await v1.messages.seen.$post({ json: { up_to: first.id } }, person("鼠鼠").as);
  expect(seen.status).toBe(204);
  expect(await unseen("鼠鼠")).toBe(1);
  expect((await messagesOf("鼠鼠")).map((m) => m.seen)).toEqual([false, true]);
});

test("an email goes by the owner's rule until the member sets their own, and never takes it away", async () => {
  await send("deadline_soon", "仓鼠", "站长");
  // The owner has no QQ number to send to.
  expect(await emailsTo("仓鼠")).toHaveLength(1);
  expect(await emailsTo("站长")).toEqual([]);

  const mine = person("仓鼠").as;
  const off = await v1.me["email-settings"].$patch({ json: { deadline_soon: false } }, mine);
  expect(off.status).toBe(200);
  await send("deadline_soon", "仓鼠");
  expect(await emailsTo("仓鼠")).toHaveLength(1);

  const rules = v1.admin["email-rules"];
  const owner = person("站长").as;
  expect((await rules.$put({ json: { deadline_changed: "never" } }, mine)).status).toBe(403);
  expect((await rules.$put({ json: { deadline_changed: "default_off" } }, owner)).status).toBe(204);
  await send("deadline_changed", "仓鼠");
  expect(await emailsTo("仓鼠")).toHaveLength(1);
  const settings = await v1.me["email-settings"].$get({}, mine);
  if (settings.status !== 200) throw new Error(`status ${settings.status}`);
  expect((await settings.json()).kinds).toEqual([
    { kind: "deadline_soon", label: "快截止了", enabled: false, default_enabled: true },
    { kind: "deadline_changed", label: "截止变了", enabled: false, default_enabled: false },
    { kind: "college_news", label: "学院有新通知", enabled: true, default_enabled: true },
    { kind: "inclusion_result", label: "求收录有结果", enabled: true, default_enabled: true },
  ]);

  // A member's own switch doesn't outlast "never", and the kind leaves their page.
  await v1.me["email-settings"].$patch({ json: { deadline_soon: true } }, mine);
  expect((await rules.$put({ json: { deadline_soon: "never" } }, owner)).status).toBe(204);
  await send("deadline_soon", "仓鼠");
  expect(await emailsTo("仓鼠")).toHaveLength(1);
  const after = await v1.me["email-settings"].$get({}, mine);
  if (after.status !== 200) throw new Error(`status ${after.status}`);
  expect((await after.json()).kinds.map((k) => k.kind)).toEqual([
    "deadline_changed",
    "college_news",
    "inclusion_result",
  ]);
  await rules.$put(
    { json: { deadline_soon: "default_on", deadline_changed: "default_on" } },
    owner,
  );
});

test("emails leave through the mailboxes in order, and go no further once their member opted out", async () => {
  const accounts = v1.admin["mail-accounts"];
  const owner = person("站长").as;
  expect(
    (await accounts.$put({ json: { accounts: [box("a@qq.com", "pa"), box("b@qq.com")] } }, owner))
      .status,
  ).toBe(400);
  const saved = await accounts.$put(
    { json: { accounts: [box("a@qq.com", "pa"), box("b@qq.com", "pb")] } },
    owner,
  );
  expect(saved.status).toBe(204);
  // Saved again without passwords, they keep theirs, which the database holds encrypted.
  expect(
    (await accounts.$put({ json: { accounts: [box("a@qq.com"), box("b@qq.com")] } }, owner)).status,
  ).toBe(204);
  const stored = await db.selectFrom("mail_accounts").select("password").orderBy("sort").execute();
  expect(stored.map((row) => row.password)).not.toContain("pa");
  const listed = await accounts.$get({}, owner);
  if (listed.status !== 200) throw new Error(`status ${listed.status}`);
  expect(await listed.json()).toEqual([
    { host: "smtp.qq.com", port: 465, username: "a@qq.com" },
    { host: "smtp.qq.com", port: 465, username: "b@qq.com" },
  ]);

  const tested = await accounts.test.$post({ json: { qq: "10004" } }, owner);
  if (tested.status !== 200) throw new Error(`status ${tested.status}`);
  expect((await tested.json()).map((r) => r.error)).toEqual([null, null]);
  expect(smtp.sent).toEqual(["a@qq.com:pa → 10004@qq.com", "b@qq.com:pb → 10004@qq.com"]);
  // What the tests before queued.
  await sendEmails();
  smtp.sent.length = 0;

  await send("deadline_soon", "管理鼠", "禁言鼠");
  await v1.me["email-settings"].$patch({ json: { deadline_soon: false } }, person("禁言鼠").as);
  smtp.failing.add("a@qq.com");
  await sendEmails();
  // a@qq.com failed and rests; b@qq.com took over. The muted member turned emails off meanwhile.
  expect(smtp.sent).toEqual(["b@qq.com:pb → 10003@qq.com"]);
  expect((await emailsTo("管理鼠")).map((email) => email.state)).toEqual(["sent"]);
  expect((await emailsTo("禁言鼠")).map((email) => email.state)).toEqual(["dropped"]);

  // b@qq.com is turned down for one address, but a@qq.com, resting, hasn't tried it: the email
  // waits 5 minutes for another go. A refused address doesn't rest b@qq.com, which sends the next.
  smtp.sent.length = 0;
  smtp.refusing.add("10003@qq.com");
  await send("deadline_soon", "管理鼠", "鼠鼠");
  await sendEmails();
  expect(smtp.sent).toEqual(["b@qq.com:pb → 10001@qq.com"]);
  const [, waiting] = await emailsTo("管理鼠");
  expect(waiting).toMatchObject({ state: "waiting", attempts: 1 });
  const wait = waiting.next_at.getTime() - Date.now();
  expect(wait).toBeGreaterThan(4 * 60_000);
  expect(wait).toBeLessThan(6 * 60_000);

  // Saving the mailboxes ends their rest. Turned down by both, the email is dropped.
  smtp.failing.delete("a@qq.com");
  await accounts.$put({ json: { accounts: [box("a@qq.com"), box("b@qq.com")] } }, owner);
  await db
    .updateTable("emails")
    .set({ next_at: new Date() })
    .where("id", "=", waiting.id)
    .execute();
  await sendEmails();
  expect((await emailsTo("管理鼠")).map((email) => email.state)).toEqual(["sent", "dropped"]);
});
