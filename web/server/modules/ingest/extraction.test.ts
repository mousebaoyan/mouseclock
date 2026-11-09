import { testClient } from "hono/testing";
import { beforeAll, expect, test } from "vitest";
import { fakeUsers, type FakeUser } from "../../../test/fake-mousehole.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { login } from "../accounts/service.ts";
import type { ExtractedFields } from "../programs/schemas.ts";
import { createCrawlerToken } from "./service.ts";
import type { UnresolvedDate } from "./schemas.ts";

const v1 = testClient(app).api.v1;
const api = v1.crawler;

let crawler = { headers: {} };
let member = { headers: { cookie: "", origin: env.PUBLIC_URL } };
let editor = member;

async function session(profile: FakeUser) {
  const token = await login(profile, "fake", { ip: null, userAgent: "test" });
  return { headers: { cookie: `mouseclock_session=${token}`, origin: env.PUBLIC_URL } };
}

beforeAll(async () => {
  crawler = { headers: { authorization: `Bearer ${await createCrawlerToken("test")}` } };
  [member, editor] = await Promise.all([session(fakeUsers[0]), session(fakeUsers[1])]);
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
  const { snapshot_id } = await snapshot(notice.id, BODY);
  return { cs: cs.id, se: se.id, notice: notice.id, snapshot: snapshot_id };
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
  return res.json();
}

async function extract(
  snapshotId: number,
  programs: {
    program_id?: number;
    college_id: number;
    cohort?: number;
    role?: "call" | "update" | "result";
    fields: ExtractedFields;
    unresolved_dates?: UnresolvedDate[];
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

test("unparsed update dates wait for review without overwriting existing dates or duplicating items", async () => {
  const { cs, notice, snapshot: first } = await setUp("raw-date.edu.cn");
  await extract(first, [{ college_id: cs, fields: { apply: APPLY } }]);
  const [program] = await programsOf(cs);
  const raw = "截止顺延至下周二17点。名额120人。";
  const second = await snapshot(notice, raw);
  const payload = [
    {
      program_id: program.id,
      college_id: cs,
      role: "update" as const,
      fields: { quota: { value: "120人", ...sure("名额120人") } },
      unresolved_dates: [
        {
          field: "apply.end" as const,
          text: "下周二17点",
          evidence: sure("截止顺延至下周二17点").evidence,
        },
      ],
    },
  ];
  await extract(second.snapshot_id, payload);
  await extract(second.snapshot_id, payload);
  const current = await fieldsOf(program.id);
  expect(current["apply:start"]).toEqual(APPLY.value.start);
  expect(current["apply:end"]).toEqual(APPLY.value.end);
  expect(current.quota).toBe("120人");
  expect(await reviewOf(second.snapshot_id)).toEqual([
    { reason: "unparsed_date", key: null, program_id: program.id },
  ]);
  const listed = await v1["review-items"].$get({ query: { reason: "unparsed_date" } }, editor);
  expect(listed.status).toBe(200);
  if (listed.status !== 200) throw new Error("Cannot list raw date review");
  const { items } = await listed.json();
  const item = items.find((i) => i.notice.snapshot_id === second.snapshot_id);
  expect(item?.extracted?.program.unresolved_dates).toEqual(payload[0].unresolved_dates);
  if (!item) throw new Error("Missing raw date review");
  const accepted = await v1["review-items"][":id"].accept.$post(
    { param: { id: String(item.id) }, json: {} },
    editor,
  );
  expect(accepted.status).toBe(204);
  expect((await fieldsOf(program.id))["apply:end"]).toEqual(APPLY.value.end);
});

test("merging a duplicate preserves its pending unparsed dates on the original project", async () => {
  const { cs, notice, snapshot: first } = await setUp("duplicate-raw.edu.cn");
  await extract(first, [{ college_id: cs, fields: { apply: APPLY } }]);
  const [original] = await programsOf(cs);
  const text = "报名截止改为下周二17点。";
  const second = await snapshot(notice, text);
  await extract(second.snapshot_id, [
    {
      college_id: cs,
      fields: {},
      unresolved_dates: [
        {
          field: "apply.end",
          text: "下周二17点",
          evidence: [{ quote: text }],
        },
      ],
    },
  ]);
  const items = await pendingOf(second.snapshot_id);
  const duplicate = items.find((item) => item.reason === "possible_duplicate");
  const unresolved = items.find((item) => item.reason === "unparsed_date");
  if (!duplicate || !unresolved) throw new Error("Missing duplicate or raw date review");
  const res = await v1["review-items"][":id"].accept.$post(
    { param: { id: String(duplicate.id) }, json: { program_id: original.id } },
    editor,
  );
  expect(res.status).toBe(204);
  const remaining = await pendingOf(second.snapshot_id);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({
    id: unresolved.id,
    reason: "unparsed_date",
    program_id: original.id,
  });
});

test("unparsed dates require original evidence and cannot also contain a guessed normalized value", async () => {
  const { cs, snapshot: snap } = await setUp("bad-raw-date.edu.cn");
  for (const value of [
    { text: "不存在的日期", fields: {} },
    { text: "6月14日17:00", fields: { apply: APPLY } },
  ]) {
    const res = await api.snapshots[":id"].extraction.$post(
      {
        param: { id: String(snap) },
        json: {
          programs: [
            {
              college_id: cs,
              cohort: 2027,
              kind: "summer_camp",
              role: "call",
              name: "夏令营",
              fields: value.fields,
              unresolved_dates: [
                { field: "apply.end", text: value.text, evidence: APPLY.evidence },
              ],
            },
          ],
          usage: [],
        },
      },
      crawler,
    );
    expect(res.status).toBe(400);
  }
  expect(await programsOf(cs)).toEqual([]);
});

test("a new call with an unparsed deadline creates one specific review, not a missing-deadline duplicate", async () => {
  const { cs, notice } = await setUp("new-raw-date.edu.cn");
  const { snapshot_id } = await snapshot(notice, "报名截止为下周二17点。");
  await extract(snapshot_id, [
    {
      college_id: cs,
      fields: {},
      unresolved_dates: [
        {
          field: "apply.end",
          text: "下周二17点",
          evidence: sure("报名截止为下周二17点").evidence,
        },
      ],
    },
  ]);
  const [program] = await programsOf(cs);
  expect(program.apply_deadline).toBeNull();
  expect(await reviewOf(snapshot_id)).toEqual([
    { reason: "unparsed_date", key: null, program_id: program.id },
  ]);
});

async function programsOf(collegeId: number) {
  return db
    .selectFrom("programs")
    .select(["id", "cohort", "kind", "name", "apply_start", "apply_deadline"])
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
  expect(await fieldsOf(program.id)).toEqual({
    "apply:start": { date: "2026-06-01", time: "08:00" },
    "apply:end": { date: "2026-06-14", time: "17:00" },
    "event:start": { date: "2026-07-06" },
    "event:end": { date: "2026-07-09" },
    materials: ["申请表"],
  });
  const versions = await db
    .selectFrom("program_versions")
    .select(["number", "role", "changes"])
    .where("program_id", "=", program.id)
    .execute();
  expect(versions).toEqual([
    {
      number: 1,
      role: "call",
      changes: ["apply:start", "apply:end", "event:start", "event:end", "materials"],
    },
  ]);
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
    { reason: "implausible", key: "apply:end", program_id: program.id },
    { reason: "low_confidence", key: "majors", program_id: program.id },
    { reason: "evidence_not_found", key: "quota", program_id: program.id },
    { reason: "no_deadline", key: null, program_id: program.id },
  ]);
});

test("a later notice changes the parts it states, adds dates by label, and keeps a person's edits", async () => {
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
      // Not one of the fake users the review tests log in as.
      mousehole_id: 100,
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
  expect(second.extraction?.programs).toEqual([
    {
      id: programId,
      college_id: cs,
      cohort: 2027,
      kind: "summer_camp",
      name: "2026 年夏令营",
      apply: APPLY.value,
    },
  ]);
  await extract(second.snapshot_id, [
    {
      program_id: programId,
      college_id: cs,
      role: "update",
      fields: {
        apply: { value: { end: { date: "2026-06-21" } }, ...sure("报名截止延长至6月21日") },
        dates: {
          value: [{ label: "确认参加", end: { date: "2026-07-01", mark: "before" } }],
          ...sure("确认参加请于7月1日前回复"),
        },
        quota: { value: "150 人", ...sure("名额150人") },
      },
    },
  ]);

  expect(await fieldsOf(programId)).toEqual({
    "apply:start": { date: "2026-06-01", time: "08:00" },
    "apply:end": { date: "2026-06-21" },
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
  expect(version).toEqual({ number: 2, changes: ["apply:end", "dates:确认参加"] });
  const [program] = await programsOf(cs);
  expect(program.apply_start?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  expect(program.apply_deadline?.toISOString()).toBe("2026-06-21T16:00:00.000Z");
  expect(await reviewOf(second.snapshot_id)).toEqual([
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

  const { snapshot_id: irrelevant } = await snapshot(notice, "运动会通知");
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
  const { snapshot_id: second } = await snapshot(notice, `${BODY}\n第二批`);
  await extract(second, [{ college_id: cs, fields: { apply: APPLY } }]);
  const [, batch2] = await programsOf(cs);
  expect(await reviewOf(second)).toEqual([
    { reason: "possible_duplicate", key: null, program_id: batch2.id },
  ]);
});

// The review page (design §12.2).

async function pendingOf(snapshotId: number) {
  return db
    .selectFrom("review_items")
    .select(["id", "reason", "key", "program_id"])
    .where("snapshot_id", "=", snapshotId)
    .where("status", "=", "pending")
    .orderBy("id")
    .execute();
}

async function accept(id: number, decision: object = {}, as = editor) {
  return v1["review-items"][":id"].accept.$post({ param: { id: String(id) }, json: decision }, as);
}

test("an accepted field goes on the table from its version, a rejected one doesn't", async () => {
  const { cs, snapshot: snap } = await setUp("r1.edu.cn");
  await extract(snap, [
    {
      college_id: cs,
      fields: {
        apply: APPLY,
        quota: { value: "100 人", ...sure("拟招收100人") },
        majors: { value: ["计算机科学与技术"], evidence: APPLY.evidence, confidence: 0.3 },
      },
    },
  ]);
  const [program] = await programsOf(cs);
  const [majors, quota] = await pendingOf(snap);

  const list = await v1["review-items"].$get({ query: { reason: "low_confidence" } }, editor);
  if (list.status !== 200) throw new Error("List failed");
  const listed = await list.json();
  expect(listed.reason).toBe("low_confidence");
  expect(listed.counts.evidence_not_found).toBeGreaterThan(0);
  expect(listed.items.find((item) => item.id === majors.id)).toEqual(
    expect.objectContaining({
      id: majors.id,
      program: {
        id: program.id,
        name: "2026 年夏令营",
        college: "计算机学院",
        school: "r1.edu.cn",
      },
      field: {
        key: "majors",
        version: 1,
        value: ["计算机科学与技术"],
        evidence: APPLY.evidence,
        confidence: 0.3,
        current: null,
      },
      extracted: null,
    }),
  );

  expect((await accept(majors.id, { program_id: program.id })).status).toBe(400);
  expect((await accept(majors.id)).status).toBe(204);
  const reject = v1["review-items"][":id"].reject;
  expect((await reject.$post({ param: { id: String(quota.id) } }, editor)).status).toBe(204);
  expect((await accept(quota.id)).status).toBe(409);
  expect(await fieldsOf(program.id)).toMatchObject({ majors: ["计算机科学与技术"] });
  expect((await fieldsOf(program.id)).quota).toBeUndefined();
  const version = await db
    .selectFrom("program_versions")
    .select("changes")
    .where("program_id", "=", program.id)
    .executeTakeFirstOrThrow();
  expect(version.changes).toContain("majors");
  const decided = await db
    .selectFrom("review_items")
    .select(["status", "resolved_by"])
    .where("id", "in", [majors.id, quota.id])
    .orderBy("id")
    .execute();
  expect(decided.map((row) => row.status)).toEqual(["accepted", "rejected"]);
  expect(decided[0].resolved_by).not.toBeNull();
  const audit = await db
    .selectFrom("audit_log")
    .select(["action", "target_id"])
    .where("target_type", "=", "review_item")
    .where("target_id", "in", [majors.id, quota.id])
    .orderBy("target_id")
    .execute();
  expect(audit).toEqual([
    { action: "accept", target_id: majors.id },
    { action: "reject", target_id: quota.id },
  ]);
});

test("accepting a conflict puts the version's value over a person's", async () => {
  const { cs, notice, snapshot: snap } = await setUp("r2.edu.cn");
  await extract(snap, [{ college_id: cs, fields: { apply: APPLY } }]);
  const [program] = await programsOf(cs);
  const edit = await v1.programs[":id"].$patch(
    {
      param: { id: String(program.id) },
      json: { quota: "20 人", reason: "原文写的", basis: "https://r2.edu.cn/1.htm" },
    },
    editor,
  );
  expect(edit.status).toBe(200);
  const { snapshot_id: second } = await snapshot(notice, `${BODY}\n拟招收30人`);
  await extract(second, [
    {
      program_id: program.id,
      college_id: cs,
      fields: { quota: { value: "30 人", ...sure("拟招收30人") } },
    },
  ]);
  const [conflict] = await pendingOf(second);
  expect(conflict.reason).toBe("conflicts_edit");

  expect((await accept(conflict.id)).status).toBe(204);
  const field = await db
    .selectFrom("program_fields")
    .select(["value", "version_id", "edit_id"])
    .where("program_id", "=", program.id)
    .where("key", "=", "quota")
    .executeTakeFirstOrThrow();
  expect(field).toMatchObject({ value: "30 人", edit_id: null });
  expect(field.version_id).not.toBeNull();
});

test("a program that couldn't be placed is merged where the reviewer says", async () => {
  const { cs, se, notice, snapshot: snap } = await setUp("r3.edu.cn");
  await extract(snap, [{ college_id: se, fields: { apply: APPLY } }]);
  const [existing] = await programsOf(se);
  const { snapshot_id: second } = await snapshot(notice, `${BODY}\n第二轮`);
  await extract(second, [
    { college_id: cs, cohort: 2030, fields: { apply: APPLY } },
    {
      college_id: cs,
      program_id: 999_999,
      fields: { quota: { value: "10 人", ...sure("报名时间") } },
    },
  ]);
  const [cohort, unknown] = await pendingOf(second);

  const other = await setUp("r3x.edu.cn");
  expect((await accept(cohort.id)).status).toBe(400);
  expect((await accept(cohort.id, { college_id: other.cs, cohort: 2027 })).status).toBe(404);
  expect(
    (await accept(cohort.id, { program_id: existing.id, college_id: cs, cohort: 2027 })).status,
  ).toBe(400);
  expect((await accept(cohort.id, { college_id: cs, cohort: 2027 })).status).toBe(204);
  const [created] = await programsOf(cs);
  expect(created).toMatchObject({ cohort: 2027, kind: "summer_camp" });
  expect(await fieldsOf(created.id)).toHaveProperty("apply:end");

  expect((await accept(unknown.id, { program_id: existing.id })).status).toBe(204);
  expect(await fieldsOf(existing.id)).toMatchObject({ quota: "10 人" });
  const versions = await db
    .selectFrom("program_versions")
    .select("snapshot_id")
    .where("program_id", "=", existing.id)
    .orderBy("number")
    .execute();
  expect(versions.map((v) => v.snapshot_id)).toEqual([snap, second]);
});

test("a duplicate is merged into the original and deleted", async () => {
  const { cs, notice, snapshot: snap } = await setUp("r4.edu.cn");
  await extract(snap, [{ college_id: cs, fields: { apply: APPLY } }]);
  const { snapshot_id: second } = await snapshot(notice, `${BODY}\n第二批`);
  await extract(second, [
    {
      college_id: cs,
      fields: {
        apply: APPLY,
        majors: { value: ["软件工程"], evidence: APPLY.evidence, confidence: 0.3 },
      },
    },
  ]);
  const [original, duplicate] = await programsOf(cs);
  const [flagged, unsure] = await pendingOf(second);
  expect([flagged.reason, unsure.reason]).toEqual(["possible_duplicate", "low_confidence"]);

  expect((await accept(flagged.id, { program_id: duplicate.id })).status).toBe(400);
  // A person's edit would go with the duplicate, so it is undone first.
  const edited = await v1.programs[":id"].$patch(
    {
      param: { id: String(duplicate.id) },
      json: { quota: "20 人", reason: "原文写的", basis: "https://r4.edu.cn/1.htm" },
    },
    editor,
  );
  expect(edited.status).toBe(200);
  expect((await accept(flagged.id, { program_id: original.id })).status).toBe(409);
  const edit = await db
    .selectFrom("edits")
    .select("id")
    .where("program_id", "=", duplicate.id)
    .executeTakeFirstOrThrow();
  const revert = v1.edits[":id"].revert.$post({ param: { id: String(edit.id) } }, editor);
  expect((await revert).status).toBe(200);
  expect((await accept(flagged.id, { program_id: original.id })).status).toBe(204);
  expect(await programsOf(cs)).toHaveLength(2);
  const gone = await db
    .selectFrom("programs")
    .select("deleted_at")
    .where("id", "=", duplicate.id)
    .executeTakeFirstOrThrow();
  expect(gone.deleted_at).not.toBeNull();
  const versions = await db
    .selectFrom("program_versions")
    .select("snapshot_id")
    .where("program_id", "=", original.id)
    .orderBy("number")
    .execute();
  expect(versions.map((v) => v.snapshot_id)).toEqual([snap, second]);
  // The duplicate's unsure field waits again, on the original.
  expect((await pendingOf(second)).map((item) => [item.reason, item.program_id])).toEqual([
    ["low_confidence", original.id],
  ]);
});

test("only L3 and up see and decide the items", async () => {
  const { cs, snapshot: snap } = await setUp("r5.edu.cn");
  await extract(snap, [{ college_id: cs, fields: {} }]);
  const [item] = await pendingOf(snap);
  expect((await v1["review-items"].$get({ query: {} }, member)).status).toBe(403);
  expect((await accept(item.id, {}, member)).status).toBe(403);
  const reject = v1["review-items"][":id"].reject;
  expect((await reject.$post({ param: { id: String(item.id) } }, member)).status).toBe(403);
});
