import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createCrawlerToken } from "./service.ts";

const api = testClient(app).api.v1.crawler;

let crawler = { headers: {} };

beforeAll(async () => {
  crawler = { headers: { authorization: `Bearer ${await createCrawlerToken("test")}` } };
});

async function newSource(host: string) {
  const school = await db
    .insertInto("schools")
    .values({ name: host })
    .returning("id")
    .executeTakeFirstOrThrow();
  const college = await db
    .insertInto("colleges")
    .values({ school_id: school.id, name: "计算机学院", kind: "college", region: "四川" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return db
    .insertInto("sources")
    .values({ college_id: college.id, url: `https://${host}/tzgg.htm` })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function work() {
  const res = await api.work.$get({}, crawler);
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res.json();
}

async function list(sourceId: number, items: { url: string; title: string }[]) {
  const res = await api.sources[":id"].listing.$post(
    { param: { id: String(sourceId) }, json: { items } },
    crawler,
  );
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res.json();
}

async function snapshot(noticeId: number, attachmentText?: string) {
  const res = await api.notices[":id"].snapshot.$post(
    {
      param: { id: String(noticeId) },
      json: {
        fetched_at: 1780000000,
        html: "<p>正文</p>",
        text: "正文",
        attachments:
          attachmentText === undefined
            ? []
            : [
                {
                  name: "申请表.docx",
                  url: "https://x.edu.cn/f.docx",
                  content_type: "x",
                  text: attachmentText,
                },
              ],
      },
    },
    crawler,
  );
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res.json();
}

test("only a valid crawler token gets in", async () => {
  const res = await api.work.$get({}, { headers: { authorization: "Bearer nope" } });
  expect(res.status).toBe(401);
});

test("a due source is handed out once until its round is reported", async () => {
  const source = await newSource("a.edu.cn");
  const handedOut = async () => (await work()).sources.filter((s) => s.id === source.id);
  expect(await handedOut()).toMatchObject([{ backfill: true }]);
  expect(await handedOut()).toEqual([]);

  const now = Math.floor(Date.now() / 1000);
  const json = {
    source_id: source.id,
    started_at: now - 60,
    finished_at: now,
    listed: 0,
    new_count: 0,
    useful_count: 0,
    notice_failures: [],
  };
  expect((await api.runs.$post({ json }, crawler)).status).toBe(204);
  expect((await api.runs.$post({ json }, crawler)).status).toBe(204);
  const runs = await db
    .selectFrom("crawl_runs")
    .select("id")
    .where("source_id", "=", source.id)
    .execute();
  expect(runs).toHaveLength(1);
  expect(await handedOut()).toEqual([]);

  await db
    .updateTable("sources")
    .set({ crawled_at: new Date(Date.now() - 13 * 3600_000) })
    .where("id", "=", source.id)
    .execute();
  expect(await handedOut()).toMatchObject([{ backfill: false }]);
});

test("listing again finds nothing new and hands back what is unfinished", async () => {
  const source = await newSource("b.edu.cn");
  const items = [
    { url: "https://b.edu.cn/1.htm", title: "夏令营通知", published_on: "2026-05-19" },
    { url: "https://b.edu.cn/2.htm", title: "运动会通知" },
  ];
  expect(await list(source.id, items)).toMatchObject({
    new_count: 2,
    pending: [{ step: "screen" }, { step: "screen" }],
  });
  const { pending } = await list(source.id, items);
  const [camp, games] = pending;
  expect(pending).toHaveLength(2);

  const screening = await api.sources[":id"].screening.$post(
    {
      param: { id: String(source.id) },
      json: {
        results: [
          { notice_id: camp.id, score: 0.9, screened_in: true },
          { notice_id: games.id, score: 0.1, screened_in: false },
        ],
        usage: [{ model: "judge", input_tokens: 40, output_tokens: 2 }],
      },
    },
    crawler,
  );
  expect(screening.status).toBe(204);
  expect(await list(source.id, items)).toEqual({
    new_count: 0,
    pending: [{ ...camp, step: "fetch" }],
  });

  expect(await snapshot(camp.id)).toMatchObject({ extraction: { published_on: "2026-05-19" } });
  await db
    .updateTable("snapshots")
    .set({ extracted_at: new Date() })
    .where("notice_id", "=", camp.id)
    .execute();
  expect(await list(source.id, items)).toEqual({ new_count: 0, pending: [] });
});

test("the same words make no new snapshot, changed attachment text does", async () => {
  const source = await newSource("c.edu.cn");
  const { pending } = await list(source.id, [{ url: "https://c.edu.cn/1.htm", title: "推免通知" }]);
  const noticeId = pending[0].id;

  const first = await snapshot(noticeId, "表");
  expect(first).toMatchObject({ missing_files: [0], extraction: { colleges: [{}] } });
  expect(await snapshot(noticeId, "表")).toEqual(first);
  expect((await snapshot(noticeId, "新表")).snapshot_id).not.toBe(first.snapshot_id);
});
