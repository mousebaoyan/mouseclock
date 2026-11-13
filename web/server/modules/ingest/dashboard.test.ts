import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { fakeUsers } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";

const crawlRuns = testClient(app).api.v1["crawl-runs"];

let member = { headers: {} };

beforeAll(async () => {
  const token = await login(fakeUsers[0], "fake", { ip: null, userAgent: "test" });
  member = { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
});

// Beijing time, as the dashboard counts days.
const at = (time: string) => new Date(`${time}+08:00`);

async function source(name: string) {
  const school = await db
    .insertInto("schools")
    .values({ name })
    .returning("id")
    .executeTakeFirstOrThrow();
  const college = await db
    .insertInto("colleges")
    .values({ school_id: school.id, name: "计算机学院", kind: "college", region: "四川" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id } = await db
    .insertInto("sources")
    .values({ college_id: college.id, url: `https://${name}/tzgg.htm` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

async function run(
  sourceId: number,
  time: string,
  outcome: { failure?: "http_status"; notice_failures?: number } = {},
) {
  await db
    .insertInto("crawl_runs")
    .values({
      source_id: sourceId,
      started_at: at(time),
      finished_at: new Date(at(time).getTime() + 60_000),
      failure: outcome.failure ?? null,
      detail: outcome.failure ? "HTTP 403" : "",
      listed: outcome.failure ? 0 : 20,
      new_count: 0,
      useful_count: 0,
      notice_failures: JSON.stringify(
        Array.from({ length: outcome.notice_failures ?? 0 }, (_, i) => ({
          url: `https://x.edu.cn/${i}.htm`,
          failure: "timeout",
        })),
      ),
    })
    .execute();
}

async function noticeFirstSeen(sourceId: number, time: string) {
  await db
    .insertInto("notices")
    .values({
      source_id: sourceId,
      url: `https://x.edu.cn/${time}.htm`,
      title: "通知",
      first_seen_at: at(time),
    })
    .execute();
}

async function day(query: { date: string; source_id?: string }) {
  const res = await crawlRuns.$get({ query }, member);
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res.json();
}

test("a day lists the sources crawled on it, those failing or gone quiet first", async () => {
  const [failing, quiet, fine, later] = await Promise.all([
    source("failing.edu.cn"),
    source("quiet.edu.cn"),
    source("fine.edu.cn"),
    source("later.edu.cn"),
  ]);
  // The day before in Beijing, though the same day in UTC: a round of its own, yet one of the
  // two latest.
  await run(failing, "2026-07-09T23:30:00", { failure: "http_status" });
  await run(failing, "2026-07-10T00:30:00", { failure: "http_status" });
  await noticeFirstSeen(failing, "2026-07-01T10:00:00");
  await run(quiet, "2026-07-10T08:00:00");
  await noticeFirstSeen(quiet, "2026-06-01T10:00:00");
  await run(fine, "2026-07-10T08:00:00", { notice_failures: 25 });
  await run(fine, "2026-07-10T12:00:00");
  await noticeFirstSeen(fine, "2026-07-10T08:01:00");
  await run(later, "2026-07-11T08:00:00");
  // Seen after the day: it doesn't count for the day.
  await noticeFirstSeen(quiet, "2026-07-11T08:01:00");

  await db
    .insertInto("model_calls")
    .values([
      {
        purpose: "screening",
        source_id: fine,
        model: "semif",
        input_tokens: 100,
        output_tokens: 1,
        created_at: at("2026-07-10T08:00:30"),
      },
      {
        purpose: "screening",
        source_id: fine,
        model: "semif",
        input_tokens: 200,
        output_tokens: 2,
        created_at: at("2026-07-10T12:00:30"),
      },
      {
        purpose: "extraction",
        source_id: fine,
        model: "llm",
        input_tokens: 3000,
        output_tokens: 400,
        created_at: at("2026-07-10T12:01:00"),
      },
      {
        purpose: "probe",
        model: "llm",
        input_tokens: 5000,
        output_tokens: 600,
        created_at: at("2026-07-10T15:00:00"),
      },
      {
        purpose: "screening",
        source_id: later,
        model: "semif",
        input_tokens: 100,
        output_tokens: 1,
        created_at: at("2026-07-11T08:00:30"),
      },
    ])
    .execute();
  await db
    .insertInto("crawler_tokens")
    .values({ name: "a", token_hash: Buffer.from("a"), last_seen_at: at("2026-07-10T16:00:00") })
    .execute();

  const result = await day({ date: "2026-07-10" });
  expect(result.items.map((s) => [s.id, s.failing, s.stale])).toEqual([
    [failing, true, false],
    [quiet, false, true],
    [fine, false, false],
  ]);
  expect(result).toMatchObject({ failing: 1, stale: 1, total: 3, date: "2026-07-10" });
  expect(result.crawler_seen_at).toBe(at("2026-07-10T16:00:00").getTime() / 1000);
  expect(result.usage).toEqual([
    { purpose: "extraction", model: "llm", calls: 1, input_tokens: 3000, output_tokens: 400 },
    { purpose: "probe", model: "llm", calls: 1, input_tokens: 5000, output_tokens: 600 },
    { purpose: "screening", model: "semif", calls: 2, input_tokens: 300, output_tokens: 3 },
  ]);

  const [first, second] = result.items[2].runs;
  expect(first.notice_failures).toHaveLength(20);
  expect(first.notice_failure_count).toBe(25);
  expect(second.started_at).toBe(at("2026-07-10T12:00:00").getTime() / 1000);
  expect(result.items[2].usage).toEqual({ input_tokens: 3300, output_tokens: 403 });
  expect(result.items[0].runs).toHaveLength(1);
  expect(result.items[0].usage).toEqual({ input_tokens: 0, output_tokens: 0 });

  // Out of the busy months nothing is flagged for being quiet; one source can be asked for.
  await run(quiet, "2026-10-10T08:00:00");
  expect((await day({ date: "2026-10-10" })).items.map((s) => s.stale)).toEqual([false]);
  expect(
    (await day({ date: "2026-07-10", source_id: String(fine) })).items.map((s) => s.id),
  ).toEqual([fine]);
});

test("only members see the dashboard", async () => {
  expect((await crawlRuns.$get({ query: {} })).status).toBe(401);
  const res = await crawlRuns.$get({ query: {} }, member);
  expect(res.status).toBe(200);
});
