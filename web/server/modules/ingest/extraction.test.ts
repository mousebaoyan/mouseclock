import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import type { ExtractedFields } from "../programs/schemas.ts";
import { createCrawlerToken } from "./service.ts";

const api = testClient(app).api.v1.crawler;

let crawler = { headers: {} };

beforeAll(async () => {
  crawler = { headers: { authorization: `Bearer ${await createCrawlerToken("test")}` } };
});

const BODY = [
  "报名时间：2026年6月1日8:00至6月14日17:00，逾期不予受理。",
  "活动于7月6日至9日在本院举行。",
  "材料请于6月20日前寄出。",
].join("\n");

// A school with two colleges and a source on the first, and a notice published on 2026-05-19
// with its first snapshot; returns what an extraction refers to.
async function setUp(host: string) {
  const school = await db
    .insertInto("schools")
    .values({ name: host })
    .returning("id")
    .executeTakeFirstOrThrow();
  const [cs, se] = await db
    .insertInto("colleges")
    .values([
      { school_id: school.id, name: "计算机学院", kind: "college", region: "四川" },
      { school_id: school.id, name: "软件学院", kind: "college", region: "四川" },
    ])
    .returning("id")
    .execute();
  const source = await db
    .insertInto("sources")
    .values({ college_id: cs.id, url: `https://${host}/tzgg.htm` })
    .returning("id")
    .executeTakeFirstOrThrow();
  const notice = await db
    .insertInto("notices")
    .values({
      source_id: source.id,
      url: `https://${host}/1.htm`,
      title: "夏令营通知",
      published_on: "2026-05-19",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { cs: cs.id, se: se.id, notice: notice.id, snapshot: await snapshot(notice.id, BODY) };
}

async function snapshot(noticeId: number, text: string) {
  const res = await api.notices[":id"].snapshot.$post(
    {
      param: { id: String(noticeId) },
      json: {
        fetched_at: 1780000000,
        html: "",
        text,
        attachments: [
          {
            name: "申请表.docx",
            url: "https://x.edu.cn/f.docx",
            content_type: "x",
            text: "附件一 申请表",
          },
        ],
      },
    },
    crawler,
  );
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return (await res.json()).snapshot_id;
}

async function extract(
  snapshotId: number,
  programs: {
    program_id?: number;
    college_id: number;
    cohort?: number;
    role?: "call" | "update" | "result";
    fields: ExtractedFields;
  }[],
) {
  const res = await api.snapshots[":id"].extraction.$post(
    {
      param: { id: String(snapshotId) },
      json: {
        programs: programs.map((p) => ({
          cohort: 2027,
          kind: "summer_camp" as const,
          name: "2026 年夏令营",
          role: "call" as const,
          ...p,
        })),
        usage: [{ model: "llm", input_tokens: 3000, output_tokens: 400 }],
      },
    },
    crawler,
  );
  expect(res.status).toBe(204);
}

const sure = (quote: string, attachment?: number) => ({
  evidence: [attachment === undefined ? { quote } : { quote, attachment }],
  confidence: 0.95,
});

const APPLY = {
  value: {
    start: { date: "2026-06-01", time: "08:00" },
    end: { date: "2026-06-14", time: "17:00" },
  },
  ...sure("报名时间：2026年6月1日8:00至6月14日17:00"),
};

async function programsOf(collegeId: number) {
  return db
    .selectFrom("programs")
    .select(["id", "cohort", "kind", "name", "apply_deadline"])
    .where("college_id", "=", collegeId)
    .orderBy("id")
    .execute();
}

async function fieldsOf(programId: number) {
  const rows = await db
    .selectFrom("program_fields")
    .select(["key", "value"])
    .where("program_id", "=", programId)
    .orderBy("key")
    .execute();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function reviewOf(snapshotId: number) {
  return db
    .selectFrom("review_items")
    .select(["reason", "key", "program_id"])
    .where("snapshot_id", "=", snapshotId)
    .orderBy("id")
    .execute();
}

test("a call makes a program with its fields once, however often it is sent", async () => {
  const { cs, snapshot: snap } = await setUp("a.edu.cn");
  const fields: ExtractedFields = {
    apply: APPLY,
    // Lines broken differently from the text, and a quote from the attachment.
    event: {
      value: { start: { date: "2026-07-06" }, end: { date: "2026-07-09" } },
      ...sure("活动于7月6日\n至9日在本院举行"),
    },
    materials: { value: ["申请表"], ...sure("附件一 申请表", 0) },
  };
  await extract(snap, [{ college_id: cs, fields }]);
  await extract(snap, [{ college_id: cs, fields }]);

  const [program, ...others] = await programsOf(cs);
  expect(others).toEqual([]);
  expect(program).toMatchObject({ cohort: 2027, kind: "summer_camp", name: "2026 年夏令营" });
  expect(program.apply_deadline?.toISOString()).toBe("2026-06-14T09:00:00.000Z");
  expect(Object.keys(await fieldsOf(program.id))).toEqual(["apply", "event", "materials"]);
  const versions = await db
    .selectFrom("program_versions")
    .select(["number", "role", "changes"])
    .where("program_id", "=", program.id)
    .execute();
  expect(versions).toEqual([{ number: 1, role: "call", changes: ["apply", "event", "materials"] }]);
  expect(await reviewOf(snap)).toEqual([]);
});

test("fields without their quotes, unsure ones and deadlines before the notice wait for review", async () => {
  const { cs, snapshot: snap } = await setUp("b.edu.cn");
  await extract(snap, [
    {
      college_id: cs,
      fields: {
        apply: { ...APPLY, value: { end: { date: "2026-05-01" } } },
        quota: { value: "100 人", ...sure("拟招收100人") },
        majors: { value: ["计算机科学与技术"], evidence: APPLY.evidence, confidence: 0.3 },
        apply_url: { value: "https://b.edu.cn/apply", ...sure("报名时间") },
      },
    },
  ]);
  const [program] = await programsOf(cs);
  expect(Object.keys(await fieldsOf(program.id))).toEqual(["apply_url"]);
  expect(await reviewOf(snap)).toEqual([
    { reason: "implausible", key: "apply", program_id: program.id },
    { reason: "low_confidence", key: "majors", program_id: program.id },
    { reason: "evidence_not_found", key: "quota", program_id: program.id },
    { reason: "no_deadline", key: null, program_id: program.id },
  ]);
});

test("a later notice changes what it states, adds dates by label, and keeps a person's edits", async () => {
  const { cs, notice, snapshot: first } = await setUp("c.edu.cn");
  await extract(first, [
    {
      college_id: cs,
      fields: {
        apply: APPLY,
        dates: {
          value: [{ label: "材料寄出", end: { date: "2026-06-20", mark: "before" } }],
          ...sure("材料请于6月20日前寄出"),
        },
        quota: { value: "100 人", ...sure("逾期不予受理") },
      },
    },
  ]);
  const [{ id: programId }] = await programsOf(cs);
  const user = await db
    .insertInto("users")
    .values({
      mousehole_id: 1,
      display_name: "鼠鼠",
      level: 3,
      role: "user",
      frozen: false,
      muted: false,
      mousehole_token: "t",
      synced_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const edit = await db
    .insertInto("edits")
    .values({
      program_id: programId,
      field: "quota",
      new_value: JSON.stringify("120 人"),
      reason: "原文写的是 120 人",
      basis: "https://c.edu.cn/1.htm",
      user_id: user.id,
      via: "web",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .updateTable("program_fields")
    .set({ value: JSON.stringify("120 人"), version_id: null, edit_id: edit.id })
    .where("program_id", "=", programId)
    .where("key", "=", "quota")
    .execute();

  const extended = `${BODY}\n报名截止延长至6月21日。确认参加请于7月1日前回复。名额150人。`;
  const second = await snapshot(notice, extended);
  await extract(second, [
    {
      program_id: programId,
      college_id: cs,
      role: "update",
      fields: {
        apply: {
          value: { ...APPLY.value, end: { date: "2026-06-21" } },
          ...sure("报名截止延长至6月21日"),
        },
        dates: {
          value: [{ label: "确认参加", end: { date: "2026-07-01", mark: "before" } }],
          ...sure("确认参加请于7月1日前回复"),
        },
        quota: { value: "150 人", ...sure("名额150人") },
      },
    },
  ]);

  expect(await fieldsOf(programId)).toEqual({
    apply: { start: { date: "2026-06-01", time: "08:00" }, end: { date: "2026-06-21" } },
    "dates:材料寄出": { end: { date: "2026-06-20", mark: "before" } },
    "dates:确认参加": { end: { date: "2026-07-01", mark: "before" } },
    quota: "120 人",
  });
  const [, version] = await db
    .selectFrom("program_versions")
    .select(["number", "changes"])
    .where("program_id", "=", programId)
    .orderBy("number")
    .execute();
  expect(version).toEqual({ number: 2, changes: ["apply", "dates:确认参加"] });
  expect(await reviewOf(second)).toEqual([
    { reason: "conflicts_edit", key: "quota", program_id: programId },
  ]);
});

test("programs that can't be placed wait for review, and an irrelevant notice is just done", async () => {
  const elsewhere = await setUp("d.edu.cn");
  await extract(elsewhere.snapshot, [{ college_id: elsewhere.cs, fields: { apply: APPLY } }]);
  const [foreign] = await programsOf(elsewhere.cs);

  const { cs, se, notice, snapshot: snap } = await setUp("e.edu.cn");
  await extract(snap, [
    { college_id: se, fields: { apply: APPLY } },
    { college_id: elsewhere.cs, fields: {} },
    { college_id: cs, cohort: 2030, fields: {} },
    { college_id: cs, program_id: foreign.id, fields: {} },
  ]);
  expect(await programsOf(se)).toHaveLength(1);
  expect(await programsOf(cs)).toEqual([]);
  expect(await reviewOf(snap)).toEqual([
    { reason: "unknown_college", key: null, program_id: null },
    { reason: "implausible_cohort", key: null, program_id: null },
    { reason: "unknown_program", key: null, program_id: null },
  ]);

  const irrelevant = await snapshot(notice, "运动会通知");
  await extract(irrelevant, []);
  const done = await db
    .selectFrom("snapshots")
    .select("extracted_at")
    .where("id", "=", irrelevant)
    .executeTakeFirstOrThrow();
  expect(done.extracted_at).not.toBeNull();
});

test("a new program like one already there is flagged as a possible duplicate", async () => {
  const { cs, notice, snapshot: snap } = await setUp("g.edu.cn");
  await extract(snap, [{ college_id: cs, fields: { apply: APPLY } }]);
  const second = await snapshot(notice, `${BODY}\n第二批`);
  await extract(second, [{ college_id: cs, fields: { apply: APPLY } }]);
  const [, batch2] = await programsOf(cs);
  expect(await reviewOf(second)).toEqual([
    { reason: "possible_duplicate", key: null, program_id: batch2.id },
  ]);
});
