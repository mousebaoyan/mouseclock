import type { InferRequestType } from "hono/client";
import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createCrawlerToken } from "./service.ts";

const api = testClient(app).api.v1.crawler;
type AttachmentInfo = InferRequestType<
  (typeof api.notices)[":id"]["snapshot"]["$post"]
>["json"]["attachments"][number];
const file = {
  name: "申请表.docx",
  url: "https://x.edu.cn/f.docx",
  content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  text: "表",
};

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

async function snapshot(noticeId: number, attachments: AttachmentInfo[] = [], text = "正文") {
  const res = await api.notices[":id"].snapshot.$post(
    {
      param: { id: String(noticeId) },
      json: {
        fetched_at: 1780000000,
        html: "<p>正文</p>",
        text,
        attachments,
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

test("a probe is handed out once and a resent report changes nothing", async () => {
  const admin = await db
    .insertInto("users")
    .values({
      mousehole_id: 1,
      display_name: "管理员",
      level: 3,
      role: "admin",
      frozen: false,
      muted: false,
      mousehole_token: "t",
      synced_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const probe = await db
    .insertInto("source_probes")
    .values({ url: "https://p.edu.cn/tzgg.htm", browser: false, requested_by: admin.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  const handedOut = async () => (await work()).probes.filter((p) => p.id === probe.id);
  expect(await handedOut()).toEqual([
    { id: probe.id, url: "https://p.edu.cn/tzgg.htm", browser: false, config: null },
  ]);
  expect(await handedOut()).toEqual([]);

  const report = (title: string) =>
    api.probes[":id"].$post(
      {
        param: { id: String(probe.id) },
        json: {
          items: [{ url: "https://p.edu.cn/1.htm", title }],
          usage: [{ model: "m", input_tokens: 100, output_tokens: 10 }],
        },
      },
      crawler,
    );
  expect((await report("夏令营通知")).status).toBe(204);
  expect((await report("另一份")).status).toBe(204);
  const row = await db
    .selectFrom("source_probes")
    .select(["items", "finished_at", "leased_until"])
    .where("id", "=", probe.id)
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({
    items: [{ url: "https://p.edu.cn/1.htm", title: "夏令营通知" }],
    leased_until: null,
  });
  expect(row.finished_at).not.toBeNull();
  const calls = await db
    .selectFrom("model_calls")
    .select("id")
    .where("probe_id", "=", probe.id)
    .execute();
  expect(calls).toHaveLength(1);
  expect(await handedOut()).toEqual([]);

  const missing = await api.probes[":id"].$post(
    { param: { id: String(probe.id + 1000) }, json: { items: [], usage: [] } },
    crawler,
  );
  expect(missing.status).toBe(404);
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

  const first = await snapshot(noticeId, [file]);
  expect(first).toMatchObject({ missing_files: [0], extraction: { colleges: [{}] } });
  expect(await snapshot(noticeId, [file])).toEqual(first);
  expect((await snapshot(noticeId, [{ ...file, text: "新表" }])).snapshot_id).not.toBe(
    first.snapshot_id,
  );
});

test("attachment download errors keep their links and do not require files", async () => {
  const source = await newSource("attachments-error.edu.cn");
  const [notice] = (
    await list(source.id, [{ url: "https://attachments-error.edu.cn/1.htm", title: "通知" }])
  ).pending;
  const attachments = [
    { ...file, text: "", error: "需要验证码" },
    { ...file, url: "https://x.edu.cn/deleted.docx", text: "", error: "获取文件错误" },
  ];
  const first = await snapshot(notice.id, attachments);
  expect(first).toMatchObject({ missing_files: [], extraction: { colleges: [{}] } });
  expect(await snapshot(notice.id, attachments)).toEqual(first);
  expect(
    await db.selectFrom("snapshots").select("id").where("notice_id", "=", notice.id).execute(),
  ).toHaveLength(1);
  const stored = await db
    .selectFrom("attachments")
    .select(["position", "url", "text", "error", "data"])
    .where("snapshot_id", "=", first.snapshot_id)
    .orderBy("position")
    .execute();
  expect(stored).toEqual(
    attachments.map((attachment, position) => ({
      position,
      url: attachment.url,
      text: "",
      error: attachment.error,
      data: null,
    })),
  );
});

test("error updates and recovery reuse a text snapshot and request recovered files", async () => {
  const source = await newSource("attachments-recovery.edu.cn");
  const [notice] = (
    await list(source.id, [{ url: "https://attachments-recovery.edu.cn/1.htm", title: "通知" }])
  ).pending;
  const attachment = { ...file, text: "" };
  const first = await snapshot(notice.id, [{ ...attachment, error: "需要验证码" }]);
  await db
    .updateTable("snapshots")
    .set({ extracted_at: new Date() })
    .where("id", "=", first.snapshot_id)
    .execute();
  expect(await snapshot(notice.id, [{ ...attachment, error: "HTTP 503" }])).toEqual({
    snapshot_id: first.snapshot_id,
    missing_files: [],
    extraction: null,
  });
  expect(
    await db
      .selectFrom("attachments")
      .select("error")
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ error: "HTTP 503" });
  expect(await snapshot(notice.id, [attachment])).toEqual({
    snapshot_id: first.snapshot_id,
    missing_files: [0],
    extraction: null,
  });
  expect(
    await db
      .selectFrom("attachments")
      .select("error")
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ error: null });
  await db
    .updateTable("attachments")
    .set({ data: Buffer.from("original file") })
    .where("snapshot_id", "=", first.snapshot_id)
    .execute();
  expect(await snapshot(notice.id, [attachment])).toEqual({
    snapshot_id: first.snapshot_id,
    missing_files: [],
    extraction: null,
  });
});

test("failed downloads preserve known attachment text and files without changing old snapshots", async () => {
  const source = await newSource("attachments-known.edu.cn");
  const [notice] = (
    await list(source.id, [{ url: "https://attachments-known.edu.cn/1.htm", title: "通知" }])
  ).pending;
  const first = await snapshot(notice.id, [file]);
  const data = Buffer.from("original file");
  await db
    .updateTable("attachments")
    .set({ data })
    .where("snapshot_id", "=", first.snapshot_id)
    .execute();
  await db
    .updateTable("snapshots")
    .set({ extracted_at: new Date() })
    .where("id", "=", first.snapshot_id)
    .execute();
  const failed = { ...file, text: "", content_type: "text/html", error: "需要验证码" };
  expect(await snapshot(notice.id, [failed])).toEqual({
    snapshot_id: first.snapshot_id,
    missing_files: [],
    extraction: null,
  });
  expect(
    await db
      .selectFrom("attachments")
      .select(["text", "content_type", "error", "data"])
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ text: file.text, content_type: file.content_type, error: failed.error, data });
  const next = await snapshot(notice.id, [{ ...failed, error: "HTTP 503" }], "修改后的正文");
  expect(next.snapshot_id).not.toBe(first.snapshot_id);
  expect(next.missing_files).toEqual([]);
  expect(
    await db
      .selectFrom("attachments")
      .select(["text", "error", "data"])
      .where("snapshot_id", "=", next.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ text: file.text, error: "HTTP 503", data });
  expect(
    await db
      .selectFrom("attachments")
      .select("error")
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ error: failed.error });
});

test("attachment URL and order updates keep text versions and discard mismatched files", async () => {
  const source = await newSource("attachments-order.edu.cn");
  const [notice] = (
    await list(source.id, [{ url: "https://attachments-order.edu.cn/1.htm", title: "通知" }])
  ).pending;
  const attachments = [
    { ...file, text: "" },
    { ...file, url: "https://x.edu.cn/g.docx", text: "" },
  ];
  const first = await snapshot(notice.id, attachments);
  await db
    .updateTable("attachments")
    .set({ data: Buffer.from("original file") })
    .where("snapshot_id", "=", first.snapshot_id)
    .execute();
  const reordered = [{ ...attachments[1], error: "需要验证码" }, attachments[0]];
  expect(await snapshot(notice.id, reordered)).toMatchObject({
    snapshot_id: first.snapshot_id,
    missing_files: [1],
  });
  expect(
    await db
      .selectFrom("attachments")
      .select(["position", "url", "error", "data"])
      .where("snapshot_id", "=", first.snapshot_id)
      .orderBy("position")
      .execute(),
  ).toEqual(
    reordered.map((attachment, position) => ({
      position,
      url: attachment.url,
      error: "error" in attachment ? attachment.error : null,
      data: null,
    })),
  );
});

test("a delayed attachment upload cannot overwrite a replacement URL", async () => {
  const source = await newSource("attachments-stale.edu.cn");
  const [notice] = (
    await list(source.id, [{ url: "https://attachments-stale.edu.cn/1.htm", title: "通知" }])
  ).pending;
  const original = { ...file, text: "" };
  const first = await snapshot(notice.id, [original]);
  const replacement = { ...original, url: "https://x.edu.cn/replacement.docx" };
  expect(await snapshot(notice.id, [replacement])).toMatchObject({
    snapshot_id: first.snapshot_id,
    missing_files: [0],
  });
  const upload = (url: string, data: string) =>
    app.request(
      `/api/v1/crawler/snapshots/${first.snapshot_id}/attachments/0?${new URLSearchParams({ url })}`,
      {
        method: "PUT",
        headers: { ...crawler.headers, "content-type": "application/octet-stream" },
        body: data,
      },
    );
  expect((await upload(original.url, "stale file")).status).toBe(404);
  expect(
    await db
      .selectFrom("attachments")
      .select("data")
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ data: null });
  expect((await upload(replacement.url, "replacement file")).status).toBe(204);
  expect(
    await db
      .selectFrom("attachments")
      .select("data")
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ data: Buffer.from("replacement file") });
});

test("failed attachments are fetched once a day even when extraction found no programs", async () => {
  const source = await newSource("attachments-retry.edu.cn");
  const items = [{ url: "https://attachments-retry.edu.cn/1.htm", title: "通知" }];
  const [notice] = (await list(source.id, items)).pending;
  await api.sources[":id"].screening.$post(
    {
      param: { id: String(source.id) },
      json: { results: [{ notice_id: notice.id, score: 0.9, screened_in: true }], usage: [] },
    },
    crawler,
  );
  const failed = { ...file, text: "", error: "HTTP 503" };
  const first = await snapshot(notice.id, [failed]);
  const extracted = await api.snapshots[":id"].extraction.$post(
    { param: { id: String(first.snapshot_id) }, json: { programs: [], usage: [] } },
    crawler,
  );
  expect(extracted.status).toBe(204);
  expect((await list(source.id, items)).pending).toEqual([]);

  const dayAgo = new Date(Date.now() - 25 * 3600_000);
  await db.updateTable("notices").set({ checked_at: dayAgo }).where("id", "=", notice.id).execute();
  expect((await list(source.id, items)).pending).toMatchObject([{ id: notice.id, step: "fetch" }]);

  const recovered = await snapshot(notice.id, [{ ...file, text: "" }]);
  expect(recovered).toEqual({
    snapshot_id: first.snapshot_id,
    missing_files: [0],
    extraction: null,
  });
  await db.updateTable("notices").set({ checked_at: dayAgo }).where("id", "=", notice.id).execute();
  expect((await list(source.id, items)).pending).toMatchObject([{ id: notice.id, step: "fetch" }]);
  const uploaded = await app.request(
    `/api/v1/crawler/snapshots/${first.snapshot_id}/attachments/0?${new URLSearchParams({ url: file.url })}`,
    {
      method: "PUT",
      headers: { ...crawler.headers, "content-type": "application/octet-stream" },
      body: "recovered file",
    },
  );
  expect(uploaded.status).toBe(204);
  expect((await list(source.id, items)).pending).toEqual([]);

  await snapshot(notice.id, [failed]);
  const next = await snapshot(notice.id, [file]);
  expect(next.snapshot_id).not.toBe(first.snapshot_id);
  const nextUploaded = await app.request(
    `/api/v1/crawler/snapshots/${next.snapshot_id}/attachments/0?${new URLSearchParams({ url: file.url })}`,
    {
      method: "PUT",
      headers: { ...crawler.headers, "content-type": "application/octet-stream" },
      body: "new file",
    },
  );
  expect(nextUploaded.status).toBe(204);
  expect((await list(source.id, items)).pending).toMatchObject([{ id: notice.id, step: "fetch" }]);
  const nextExtracted = await api.snapshots[":id"].extraction.$post(
    { param: { id: String(next.snapshot_id) }, json: { programs: [], usage: [] } },
    crawler,
  );
  expect(nextExtracted.status).toBe(204);
  expect(
    await db
      .selectFrom("attachments")
      .select("error")
      .where("snapshot_id", "=", first.snapshot_id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ error: failed.error });
  await db.updateTable("notices").set({ checked_at: dayAgo }).where("id", "=", notice.id).execute();
  expect((await list(source.id, items)).pending).toEqual([]);
});

test("a notice of a program still open comes back to be fetched once a day", async () => {
  const source = await newSource("d.edu.cn");
  const items = [{ url: "https://d.edu.cn/1.htm", title: "冬令营通知" }];
  const [notice] = (await list(source.id, items)).pending;
  await api.sources[":id"].screening.$post(
    {
      param: { id: String(source.id) },
      json: { results: [{ notice_id: notice.id, score: 0.9, screened_in: true }], usage: [] },
    },
    crawler,
  );
  const { snapshot_id, extraction } = await snapshot(notice.id);
  if (!extraction) throw new Error("no extraction asked for");
  const deadline = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const extracted = await api.snapshots[":id"].extraction.$post(
    {
      param: { id: String(snapshot_id) },
      json: {
        programs: [
          {
            college_id: extraction.colleges[0].id,
            cohort: Number(deadline.slice(0, 4)) + 1,
            kind: "winter_camp",
            name: "冬令营",
            role: "call",
            fields: {
              apply: {
                value: { end: { date: deadline } },
                evidence: [{ quote: "正文" }],
                confidence: 0.9,
              },
            },
          },
        ],
        usage: [],
      },
    },
    crawler,
  );
  expect(extracted.status).toBe(204);
  expect((await list(source.id, items)).pending).toEqual([]);

  const dayAgo = new Date(Date.now() - 25 * 3600_000);
  await db.updateTable("notices").set({ checked_at: dayAgo }).where("id", "=", notice.id).execute();
  expect((await list(source.id, items)).pending).toMatchObject([{ id: notice.id, step: "fetch" }]);

  // Once the program has closed, nothing more to watch for.
  await db
    .updateTable("programs")
    .set({ apply_deadline: dayAgo })
    .where("college_id", "=", extraction.colleges[0].id)
    .execute();
  expect((await list(source.id, items)).pending).toEqual([]);
});
