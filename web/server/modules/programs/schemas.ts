import { z } from "@hono/zod-openapi";
import { Int, UnixSeconds } from "../../platform/http.ts";

// The shapes of programs and their fields (design §8.2): what extraction submits, what the
// database stores in program_fields and program_versions, and what pages show. Keys left out
// mean "not stated"; the crawler drops empty values instead of sending null.

export const KINDS = [
  "winter_camp",
  "summer_camp",
  "pre_recommendation",
  "september_round",
] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

export const ROLES = ["call", "update", "result"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const IsoDate = z.iso.date().openapi({ description: "YYYY-MM-DD，北京时间的日期" });

// A time as far as the notice states it, no further (design §8.2): to the minute, the day, the
// third of a month or the month. A strict object each, so no mix of the three gets through.
export const TimeValue = z
  .union([
    z
      .strictObject({
        date: IsoDate,
        time: z
          .string()
          .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/)
          .openapi({ description: "HH:MM；「24 点」写 24:00" }),
      })
      .openapi("TimeToMinute"),
    z
      .strictObject({
        date: IsoDate,
        mark: z
          .enum(["before", "about"])
          .optional()
          .openapi({ description: "before：「X 日前」；about：「前后」「左右」" }),
      })
      .openapi("TimeToDay"),
    z
      .strictObject({
        month: z
          .string()
          .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
          .openapi({ description: "YYYY-MM" }),
        part: z
          .enum(["early", "mid", "late"])
          .optional()
          .openapi({ description: "上旬（含月初）、中旬、下旬（含月底）" }),
      })
      .openapi("TimeToMonth"),
  ])
  .openapi("TimeValue");
export type TimeValue = z.infer<typeof TimeValue>;

const Text = z.string().trim().min(1).max(500);
const Texts = z.array(Text).min(1).max(100);

function hasTime(window: { start?: TimeValue; end?: TimeValue }) {
  return window.start !== undefined || window.end !== undefined;
}

export const Evidence = z
  .strictObject({
    quote: z.string().min(1).max(2000),
    attachment: z
      .number()
      .int()
      .min(0)
      .max(99)
      .optional()
      .openapi({ description: "附件在快照里的序号，从 0 开始；在正文里的不写" }),
  })
  .openapi("Evidence");
export type Evidence = z.infer<typeof Evidence>;

export const ApplyValue = z
  .strictObject({
    start: TimeValue.optional(),
    end: TimeValue.optional(),
    rolling: z.literal(true).optional().openapi({ description: "额满即止、先到先审" }),
  })
  .refine((v) => hasTime(v) || v.rolling, "报名时间至少要有开始、截止或额满即止")
  .openapi("ApplyValue");
export type ApplyValue = z.infer<typeof ApplyValue>;

const Mode = z.enum(["online", "offline", "hybrid"]);
const Degrees = z.array(z.enum(["master", "direct_phd"])).min(1);

export const EventValue = z
  .strictObject({
    start: TimeValue.optional(),
    end: TimeValue.optional(),
    mode: Mode.optional(),
    place: Text.optional(),
  })
  .refine((v) => hasTime(v) || v.mode !== undefined || v.place !== undefined, "活动时间是空的")
  .openapi("EventValue");

export const DateItem = z
  .strictObject({
    label: z.string().trim().min(1).max(50),
    start: TimeValue.optional(),
    end: TimeValue.optional(),
  })
  .refine(hasTime, "其他时间的每一项都要有时间")
  .openapi("DateItem");

// A field as extraction gives it: the value, the sentences behind it, and how sure the model is.
function entry<S extends z.ZodType>(value: S) {
  return z
    .strictObject({
      value,
      evidence: z.array(Evidence).min(1).max(20),
      confidence: z.number().min(0).max(1),
    })
    .optional();
}

// The fields of design §8.2, one key each; a new field is a new key here.
export const ExtractedFields = z
  .strictObject({
    apply: entry(ApplyValue),
    apply_url: entry(z.url({ protocol: /^(?:https?|mailto)$/ }).max(2000)),
    event: entry(EventValue),
    dates: entry(z.array(DateItem).min(1).max(30)),
    degrees: entry(Degrees.refine((v) => new Set(v).size === v.length, "招收类型有重复")),
    majors: entry(Texts),
    requirements: entry(Texts),
    materials: entry(Texts),
    assessment: entry(Texts),
    quota: entry(Text),
    benefits: entry(Texts),
    contacts: entry(Texts),
  })
  .openapi("ExtractedFields");
export type ExtractedFields = z.infer<typeof ExtractedFields>;
export type FieldKey = keyof ExtractedFields;
export type FieldValue<K extends FieldKey> = NonNullable<ExtractedFields[K]>["value"];

export const ProgramName = z.string().trim().min(1).max(200);
const COHORTS = { min: 2000, max: 2100 };
export const Cohort = z
  .number()
  .int()
  .min(COHORTS.min)
  .max(COHORTS.max)
  .openapi({ description: "届" });

// The cohort as a query string gives it.
export const ProgramTableQuery = z.object({
  cohort: z.coerce.number().int().min(COHORTS.min).max(COHORTS.max).openapi({ description: "届" }),
});

// A row of the table (design §10): only what the table shows, filters and sorts by. `apply` is
// what the page shows; the two instants are for status, countdowns and sorting.
export const TableProgram = z
  .object({
    id: Int,
    school: z.object({ name: z.string(), short_name: z.string(), tiers: z.array(z.string()) }),
    college: z.object({
      id: Int,
      name: z.string(),
      region: z.string(),
      directions: z.array(z.string()),
    }),
    kind: Kind,
    name: z.string(),
    apply: z.union([ApplyValue, z.null()]),
    apply_start: UnixSeconds.nullable(),
    apply_deadline: UnixSeconds.nullable(),
    notice: z
      .object({ url: z.string(), published_on: IsoDate.nullable() })
      .openapi({ description: "原文：最近一个报名版本的通知，没有就用最近一个版本的" }),
  })
  .openapi("TableProgram");
export const ProgramTable = z
  .object({
    preview: z.boolean().openapi({ description: "没登录或账号已冻结，只有截止最近的几条" }),
    programs: z.array(TableProgram),
  })
  .openapi("ProgramTable");

const Notice = z.object({
  title: z.string(),
  url: z.string(),
  published_on: IsoDate.nullable(),
  removed: z.boolean().openapi({ description: "原文已删除，快照照样能看" }),
});

const FieldVersion = z
  .object({ number: Int, snapshot_id: Int, notice: Notice.pick({ title: true, url: true }) })
  .openapi("FieldVersion");

// A field, or a part of one, as program_fields keeps it: its own evidence, and the version it
// came from. Parts can come from different versions, as a deadline put back does.
function part<S extends z.ZodType>(value: S) {
  return z.object({
    value,
    evidence: z.array(Evidence),
    confidence: z.number().nullable(),
    version: z.union([FieldVersion, z.null()]).openapi({ description: "为空是人改的" }),
  });
}

// One of the other dates, which has a start, an end or both (§8.2).
const DateWindow = z.union([
  z.object({ start: TimeValue, end: TimeValue.optional() }),
  z.object({ end: TimeValue }),
]);
export type DateWindow = z.infer<typeof DateWindow>;

// The fields of design §8.2 put back together, each part with what supports it.
export const ProgramFields = z
  .object({
    apply: z
      .object({
        start: part(TimeValue).optional(),
        end: part(TimeValue).optional(),
        rolling: part(z.literal(true)).optional(),
      })
      .optional(),
    apply_url: part(z.string()).optional(),
    event: z
      .object({
        start: part(TimeValue).optional(),
        end: part(TimeValue).optional(),
        mode: part(Mode).optional(),
        place: part(z.string()).optional(),
      })
      .optional(),
    dates: z
      .array(part(DateWindow).extend({ label: z.string() }))
      .optional()
      .openapi({ description: "按时间先后" }),
    degrees: part(Degrees).optional(),
    majors: part(Texts).optional(),
    requirements: part(Texts).optional(),
    materials: part(Texts).optional(),
    assessment: part(Texts).optional(),
    quota: part(Text).optional(),
    benefits: part(Texts).optional(),
    contacts: part(Texts).optional(),
  })
  .openapi("ProgramFields");
export type ProgramFields = z.infer<typeof ProgramFields>;

export const ProgramDetail = z
  .object({
    id: Int,
    school: z.object({ name: z.string(), short_name: z.string(), tiers: z.array(z.string()) }),
    college: z.object({ id: Int, name: z.string(), region: z.string() }),
    cohort: Int,
    kind: Kind,
    name: z.string(),
    apply_start: UnixSeconds.nullable(),
    apply_deadline: UnixSeconds.nullable(),
    verified: z.union([
      z.object({ by: z.string(), at: UnixSeconds }).openapi("Verified"),
      z.null(),
    ]),
    notice: Notice.openapi({ description: "原文，选法同总表" }),
    fields: ProgramFields,
  })
  .openapi("ProgramDetail");

export const Attachment = z
  .object({
    position: Int,
    name: z.string(),
    content_type: z.string(),
    size: Int.nullable().openapi({ description: "字节数；为空是抓取节点还没传上文件" }),
  })
  .openapi("Attachment");
export type Attachment = z.infer<typeof Attachment>;

export const ProgramVersions = z
  .object({
    versions: z.array(
      z.object({
        number: Int,
        role: Role,
        changes: z.array(z.string()).openapi({ description: "改了的字段，键同 program_fields" }),
        notice: Notice,
        snapshot: z.object({ id: Int, fetched_at: UnixSeconds }),
        attachments: z.array(Attachment),
      }),
    ),
  })
  .openapi("ProgramVersions");

export const SnapshotDetail = z
  .object({
    id: Int,
    fetched_at: UnixSeconds,
    notice: Notice,
    html: z.string().openapi({ description: "按白名单净化过，不含脚本、样式和图片" }),
    attachments: z.array(Attachment),
  })
  .openapi("SnapshotDetail");
