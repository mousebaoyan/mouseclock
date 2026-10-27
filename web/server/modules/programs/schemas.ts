import { z } from "@hono/zod-openapi";

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

export const EventValue = z
  .strictObject({
    start: TimeValue.optional(),
    end: TimeValue.optional(),
    mode: z.enum(["online", "offline", "hybrid"]).optional(),
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
    degrees: entry(
      z
        .array(z.enum(["master", "direct_phd"]))
        .min(1)
        .refine((v) => new Set(v).size === v.length, "招收类型有重复"),
    ),
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
export const Cohort = z.number().int().min(2000).max(2100).openapi({ description: "届" });
