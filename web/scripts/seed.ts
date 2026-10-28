import {
  recordExtraction,
  recordListing,
  recordRun,
  recordScreening,
  recordSnapshot,
  type ExtractedProgram,
} from "../server/modules/ingest/service.ts";
import type { ExtractedFields, Kind } from "../server/modules/programs/schemas.ts";
import { db } from "../server/platform/db.ts";
import { endSession, login, resolveSession } from "../server/modules/accounts/service.ts";
import {
  createCollege,
  createSchool,
  createSource,
  type Actor,
} from "../server/modules/sources/service.ts";
import { fakeUsers } from "../test/fake-mousehole.ts";
import type { z } from "zod";
import type { SchoolInput } from "../server/modules/sources/schemas.ts";

// Made-up schools, notices and programs for working on pages locally (`pnpm seed`), entered the
// way the crawler's results are, so they go through the same checks and merging. Sites are under
// .example, which resolves nowhere; dates are counted from today, so there are programs open,
// closing, closed and not yet open whenever it runs.

const DAY_MS = 24 * 3600_000;
const USAGE = [{ model: "seed", input_tokens: 0, output_tokens: 0 }];

// A Beijing calendar day `days` from today, as YYYY-MM-DD.
function day(days: number) {
  return new Date(Date.now() + 8 * 3600_000 + days * DAY_MS).toISOString().slice(0, 10);
}

function chinese(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

type Plan = {
  kind: Kind;
  cohort: number;
  name: string;
  // Days from today.
  published: number;
  opens: number;
  closes: number;
  event?: [number, number];
  majors: string[];
  quota?: string;
  // How sure the made-up model is of the quota: below 0.7 sends it to the review page.
  quotaConfidence?: number;
};

function sure(quote: string, confidence = 0.95) {
  return { evidence: [{ quote }], confidence };
}

// A notice's words, and the fields an extraction finds in them with their sentences.
function write(college: string, plan: Plan) {
  const lines = [`${college}关于举办${plan.name}的通知`];
  const fields: ExtractedFields = {};

  const apply = `报名时间：${chinese(day(plan.opens))}9:00至${chinese(day(plan.closes))}17:00`;
  lines.push(`${apply}，逾期不予受理。`);
  fields.apply = {
    value: {
      start: { date: day(plan.opens), time: "09:00" },
      end: { date: day(plan.closes), time: "17:00" },
    },
    ...sure(apply),
  };
  fields.apply_url = {
    value: "https://yz.example/apply",
    ...sure("报名网址：https://yz.example/apply"),
  };
  lines.push("报名网址：https://yz.example/apply");
  if (plan.event) {
    const [from, to] = plan.event;
    const event = `活动于${chinese(day(from))}至${chinese(day(to))}在本院线下举行`;
    lines.push(`${event}。`);
    fields.event = {
      value: { start: { date: day(from) }, end: { date: day(to) }, mode: "offline" },
      ...sure(event),
    };
  }
  const majors = `招收专业：${plan.majors.join("、")}`;
  lines.push(`${majors}。`);
  fields.majors = { value: plan.majors, ...sure(majors) };
  fields.degrees = { value: ["master", "direct_phd"], ...sure("招收学术学位硕士和直博生") };
  lines.push("招收学术学位硕士和直博生。");
  if (plan.quota) {
    const quota = `拟招收${plan.quota}`;
    lines.push(`${quota}。`);
    fields.quota = { value: plan.quota, ...sure(quota, plan.quotaConfidence) };
  }
  const materials = "申请材料：申请表、成绩单、排名证明、英语成绩证明";
  lines.push(`${materials}。`);
  fields.materials = {
    value: ["申请表", "成绩单", "排名证明", "英语成绩证明"],
    ...sure(materials),
  };
  lines.push("联系人：王老师，电话 000-00000000。");
  return { text: lines.join("\n"), fields };
}

function html(text: string) {
  return text
    .split("\n")
    .map((line) => `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`)
    .join("");
}

const SCHOOLS = [
  {
    name: "北辰大学",
    short: "北辰",
    tiers: ["c9", "985", "211", "double_first_class"],
    region: "北京",
  },
  { name: "东湖大学", short: "东湖", tiers: ["985", "211", "double_first_class"], region: "湖北" },
  { name: "南山理工大学", short: "南理工", tiers: ["211", "double_first_class"], region: "广东" },
  { name: "西江师范大学", short: "西江师大", tiers: ["double_first_class"], region: "广西" },
  { name: "临海科技大学", short: "临海科大", tiers: [], region: "浙江" },
] satisfies {
  name: string;
  short: string;
  tiers: z.infer<typeof SchoolInput>["tiers"];
  region: string;
}[];
const COLLEGES = [
  { name: "计算机学院", directions: ["计算机", "人工智能"] },
  { name: "软件学院", directions: ["软件"] },
  { name: "网络空间安全学院", directions: ["网络安全"] },
];
const MAJORS = ["计算机科学与技术", "软件工程", "人工智能", "网络空间安全"];

// What each college published: this autumn's pre-recommendation and September round, last
// summer's camp, and this winter's camps; some colleges say nothing on some of them.
function plansFor(i: number): Plan[] {
  const majors = MAJORS.slice(i % 2, (i % 2) + 2);
  const plans: Plan[] = [
    {
      kind: "summer_camp",
      cohort: 2027,
      name: "2026 年优秀大学生夏令营",
      published: -160,
      opens: -155,
      closes: -140,
      event: [-110, -107],
      majors,
      quota: `${60 + i * 10} 人左右`,
    },
    {
      kind: "pre_recommendation",
      cohort: 2027,
      name: "2027 年推免生预报名",
      published: -70,
      opens: -65,
      closes: -50,
      majors,
    },
    {
      kind: "winter_camp",
      cohort: 2028,
      name: "2026 年冬令营",
      published: -2 - i,
      opens: -1 - i,
      closes: 3 + i * 4,
      event: [30 + i, 32 + i],
      majors,
      quota: `${30 + i * 5} 人`,
      quotaConfidence: i === 1 ? 0.5 : 0.95,
    },
  ];
  if (i % 3 === 0) {
    plans.push({
      kind: "september_round",
      cohort: 2027,
      name: "2027 年推免生招生（九推）",
      published: -45,
      opens: -40,
      closes: -38,
      majors,
    });
  }
  if (i % 4 === 1) {
    plans.push({
      kind: "summer_camp",
      cohort: 2028,
      name: "2027 年优秀大学生夏令营预告",
      published: -1,
      opens: 200,
      closes: 220,
      majors,
    });
  }
  return plans;
}

const existing = await db.selectFrom("schools").select("id").limit(1).executeTakeFirst();
if (existing) {
  throw new Error("The database already has schools; seed an empty one (docker compose down -v).");
}

// Reuse the local login's admin rather than inventing a second kind of audit actor.
const token = await login(fakeUsers[2], "fake-3", { ip: null, userAgent: "seed" });
const session = await resolveSession(token);
if (!session) throw new Error("Seed admin has no session");
await endSession(session.id);
const actor: Actor = { user_id: session.viewer.id, via: "seed" };

let i = 0;
for (const school of SCHOOLS) {
  const { id: schoolId } = await createSchool(actor, {
    name: school.name,
    short_name: school.short,
    tiers: school.tiers,
  });
  for (const college of COLLEGES.slice(0, 2 + (i % 2))) {
    const collegeId = await createCollege(actor, {
      school_id: schoolId,
      name: college.name,
      kind: "college",
      region: school.region,
      directions: college.directions,
    });
    const host = `cs${i}.example`;
    const sourceId = await createSource(actor, {
      college_id: collegeId,
      url: `https://${host}/tzgg.htm`,
      section: "通知公告",
      browser: i === 2,
      config: null,
      unavailable_reason: i === 3 ? "示例：需要登录" : null,
    });

    const plans = plansFor(i);
    const items = [
      ...plans.map((plan, n) => ({
        url: `https://${host}/info/${n + 1}.htm`,
        title: `${college.name}关于举办${plan.name}的通知`,
        published_on: day(plan.published),
      })),
      { url: `https://${host}/info/99.htm`, title: "关于学术报告的通知", published_on: day(-3) },
    ];
    const { pending } = await recordListing(sourceId, items);
    await recordScreening(
      sourceId,
      pending.map((notice) => {
        const relevant = !notice.title.includes("学术报告");
        return { notice_id: notice.id, score: relevant ? 0.9 : 0.05, screened_in: relevant };
      }),
      USAGE,
    );

    for (const [n, plan] of plans.entries()) {
      const notice = pending[n];
      const { text, fields } = write(college.name, plan);
      const snapshot = await recordSnapshot(notice.id, {
        fetched_at: new Date(),
        html: html(text),
        text,
        attachments: [],
      });
      const program: ExtractedProgram = {
        college_id: collegeId,
        cohort: plan.cohort,
        kind: plan.kind,
        name: plan.name,
        role: "call",
        fields,
      };
      await recordExtraction(snapshot.snapshot_id, [program], USAGE);
    }

    // The first college extends its winter camp's deadline, so that program has two versions.
    if (i === 0) {
      const winter = await db
        .selectFrom("programs")
        .select("id")
        .where("college_id", "=", collegeId)
        .where("kind", "=", "winter_camp")
        .executeTakeFirstOrThrow();
      const apply = `报名截止时间延长至${chinese(day(10))}17:00`;
      const text = `${college.name}关于延长冬令营报名时间的通知\n${apply}，其他安排不变。`;
      const listed = await recordListing(sourceId, [
        {
          url: `https://${host}/info/50.htm`,
          title: "关于延长冬令营报名时间的通知",
          published_on: day(0),
        },
      ]);
      const [notice] = listed.pending.filter((p) => p.step === "screen");
      await recordScreening(
        sourceId,
        [{ notice_id: notice.id, score: 0.8, screened_in: true }],
        USAGE,
      );
      const snapshot = await recordSnapshot(notice.id, {
        fetched_at: new Date(),
        html: html(text),
        text,
        attachments: [],
      });
      await recordExtraction(
        snapshot.snapshot_id,
        [
          {
            program_id: winter.id,
            college_id: collegeId,
            cohort: 2028,
            kind: "winter_camp",
            name: plans[2].name,
            role: "update",
            fields: {
              apply: {
                value: { end: { date: day(10), time: "17:00" } },
                evidence: [{ quote: apply }],
                confidence: 0.9,
              },
            },
          },
        ],
        USAGE,
      );
    }

    // A round a day for the last three days; one site has been refusing for two.
    for (const ago of [3, 2, 1]) {
      const started = new Date(Date.now() - ago * DAY_MS);
      const refused = i === 2 && ago < 3;
      await recordRun({
        source_id: sourceId,
        started_at: started,
        finished_at: new Date(started.getTime() + 40_000),
        ...(refused ? { failure: "http_status" as const, detail: "HTTP 403" } : {}),
        listed: refused ? 0 : items.length,
        new_count: refused || ago < 3 ? 0 : items.length,
        useful_count: refused || ago < 3 ? 0 : plans.length,
        notice_failures: [],
      });
    }
    i++;
  }
}

const counts = await db
  .selectFrom("programs")
  .select((eb) => eb.fn.countAll<number>().as("programs"))
  .executeTakeFirstOrThrow();
console.log(`Seeded ${SCHOOLS.length} schools, ${i} colleges and ${counts.programs} programs.`);
await db.destroy();
