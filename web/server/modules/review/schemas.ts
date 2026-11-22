import { z } from "@hono/zod-openapi";
import { VIAS } from "../../platform/access.ts";
import { Int, named, Page, PageParams, UnixSeconds } from "../../platform/http.ts";
import {
  ApplyUrl,
  ApplyValue,
  Cohort,
  DateItem,
  DateWindow,
  DegreeList,
  EventValue,
  Kind,
  Mode,
  ProgramName,
  Text,
  Texts,
  TimeValue,
  StoredValue,
} from "../programs/schemas.ts";

const DisputeResult = z.enum(["corrected", "confirmed"]);
export type DisputeResult = z.infer<typeof DisputeResult>;

// What a program has besides its fields, which people can change too.
export const ProgramColumns = z.object({
  name: ProgramName.optional(),
  cohort: Cohort.optional(),
  kind: Kind.optional(),
});

// A field's new value, or null to clear it.
function edited<S extends z.ZodType>(value: S) {
  return value.nullable().optional();
}

// Why a change is asked for or made, by a direct edit or an edit request alike.
const Reason = z.string(named("理由")).trim().min(1).max(500);
const Basis = z
  .string(named("依据"))
  .trim()
  .min(1)
  .max(2000)
  .openapi({ description: "原文或截图的链接，或者一句说明" });

// A direct edit (design §12.4): what it changes, the fields as extraction gives them, and why.
export const ProgramEdit = z
  .strictObject({
    ...ProgramColumns.shape,
    apply: edited(ApplyValue),
    apply_url: edited(ApplyUrl),
    event: edited(EventValue),
    dates: edited(
      z
        .array(DateItem)
        .min(1)
        .max(30)
        .refine(
          (dates) => new Set(dates.map((date) => date.label)).size === dates.length,
          "其他时间的名称有重复",
        ),
    ),
    degrees: edited(DegreeList),
    majors: edited(Texts),
    requirements: edited(Texts),
    materials: edited(Texts),
    assessment: edited(Texts),
    quota: edited(Text),
    benefits: edited(Texts),
    contacts: edited(Texts),
    reason: Reason,
    basis: Basis,
  })
  .openapi("ProgramEdit");
export type ProgramEdit = z.infer<typeof ProgramEdit>;

export const Edit = z
  .object({
    id: Int,
    field: z.string().openapi({ description: "program_fields 的键，或 name、cohort、kind" }),
    old_value: StoredValue.nullable().openapi({ description: "为空是原来没有" }),
    new_value: StoredValue.nullable().openapi({ description: "为空是清空了" }),
    reason: z.string().nullable().openapi({ description: "撤销的为空" }),
    basis: z.string().nullable().openapi({ description: "撤销的为空" }),
    user: z.object({ id: Int, display_name: z.string() }),
    via: z.enum(VIAS),
    reverts_id: Int.nullable().openapi({ description: "撤销的是哪一次" }),
    feedback_id: Int.nullable().openapi({ description: "照哪条修改申请改的" }),
    reverted: z.boolean().openapi({ description: "这一次被撤销过" }),
    created_at: UnixSeconds,
  })
  .openapi("Edit");

export const ProgramEdits = z.object({ edits: z.array(Edit) }).openapi("ProgramEdits");

// A program's edits, with its disputes' reviews (design §12.3).
export const ProgramHistory = ProgramEdits.extend({
  reviews: z
    .array(
      z.object({
        by: z.object({ id: Int, display_name: z.string() }),
        at: UnixSeconds,
        result: DisputeResult,
        note: z.string(),
      }),
    )
    .openapi({ description: "争议的复核，最新的在前" }),
}).openapi("ProgramHistory");

export const RecentEdit = Edit.extend({
  program: z.object({ id: Int, name: z.string(), school: z.string(), college: z.string() }),
}).openapi("RecentEdit");
export const RecentEdits = Page(RecentEdit).openapi("RecentEdits");
export const RecentEditsQuery = PageParams;

export const RevokeResult = z
  .object({
    reverted: Int.openapi({ description: "撤销了几次修改" }),
    kept: Int.openapi({ description: "之后又被别人改过或已经撤销的，没有撤" }),
  })
  .openapi("RevokeResult");

export const EditRevokedUser = z
  .object({
    id: Int,
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    revoked_at: UnixSeconds.openapi({ description: "收回的时间" }),
  })
  .openapi("EditRevokedUser");

// What a part of a program can be changed to, a part each for the fields made of parts, the way
// program_fields and edits keep them (design §12.1).
const PART_VALUES = new Map<string, z.ZodType<StoredValue>>([
  ["name", ProgramName],
  ["cohort", Cohort],
  ["kind", Kind],
  ["apply:start", TimeValue],
  ["apply:end", TimeValue],
  ["apply:rolling", z.literal(true)],
  ["apply_url", ApplyUrl],
  ["event:start", TimeValue],
  ["event:end", TimeValue],
  ["event:mode", Mode],
  ["event:place", Text],
  ["degrees", DegreeList],
  ["majors", Texts],
  ["requirements", Texts],
  ["materials", Texts],
  ["assessment", Texts],
  ["quota", Text],
  ["benefits", Texts],
  ["contacts", Texts],
]);

// One of the other dates is `dates:` and its label as DateItem trims it: 1–50 characters, with no
// space at either end.
function partValue(field: string) {
  return /^dates:\S(?:[\s\S]{0,48}\S)?$/.test(field) ? DateWindow : PART_VALUES.get(field);
}

const FeedbackField = z
  .string()
  .refine((field) => partValue(field) !== undefined, "不知道说的是哪一处")
  .openapi({
    description:
      "说的是哪一处：program_fields 的键（分部分的字段一部分一个，比如 apply:end、dates:初试），或者 name、cohort、kind",
  });

// A problem pointed out, or an edit asked for (design §12.1).
export const FeedbackInput = z
  .union([
    z.strictObject({
      kind: z.literal("problem"),
      field: FeedbackField.nullable().openapi({ description: "为空是说整个项目" }),
      reason: Reason.openapi({ description: "哪里不对" }),
      basis: Basis.nullable().default(null),
    }),
    z.strictObject({
      kind: z.literal("edit"),
      field: FeedbackField,
      value: StoredValue.nullable().openapi({ description: "改成什么，为空是清空" }),
      reason: Reason,
      basis: Basis,
    }),
  ])
  .transform((input, ctx) => {
    if (input.kind === "problem") return input;
    if (input.value === null) {
      if (!Object.hasOwn(ProgramColumns.shape, input.field)) return input;
      ctx.addIssue({ code: "custom", path: ["value"], message: "名称、届和类型不能清空" });
      return z.NEVER;
    }
    const parsed = partValue(input.field)?.safeParse(input.value);
    if (parsed?.success) return { ...input, value: parsed.data };
    ctx.addIssue({ code: "custom", path: ["value"], message: "改成的值写法不对" });
    return z.NEVER;
  })
  .openapi("FeedbackInput");
export type FeedbackInput = z.output<typeof FeedbackInput>;

export const FEEDBACK_STATUSES = ["pending", "accepted", "rejected", "withdrawn"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
const FeedbackKind = z.enum(["problem", "edit"]);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const Feedback = z
  .object({
    id: Int,
    program: z.object({ id: Int, name: z.string(), school: z.string(), college: z.string() }),
    kind: FeedbackKind,
    field: z.string().nullable(),
    old_value: StoredValue.nullable().openapi({ description: "提的时候这一处的值" }),
    proposed_value: StoredValue.nullable().openapi({ description: "修改申请改成什么，为空是清空" }),
    reason: z.string(),
    basis: z.string().nullable(),
    status: z.enum(FEEDBACK_STATUSES),
    via: z.enum(VIAS),
    user: z.object({ id: Int, display_name: z.string() }),
    created_at: UnixSeconds,
    review: z
      .object({ by: z.string(), at: UnixSeconds, note: z.string().nullable() })
      .nullable()
      .openapi({ description: "处理的人、时间和说明；还没处理的为空" }),
  })
  .openapi("Feedback");

export const ProgramFeedback = z.object({ feedback: z.array(Feedback) }).openapi("ProgramFeedback");
export const FeedbackPage = Page(Feedback).openapi("FeedbackPage");

// On the review page: what the part is now, and whether it changed since it was given.
export const QueuedFeedback = Feedback.extend({
  current_value: StoredValue.nullable(),
  current_version: Int.nullable().openapi({
    description: "这一处现在的值来自第几版通知；为空是人改的，或者是名称、届、类型",
  }),
  changed: z.boolean().openapi({ description: "提了以后这一处又变过" }),
}).openapi("QueuedFeedback");
export const FeedbackQueue = Page(QueuedFeedback).openapi("FeedbackQueue");

export const FeedbackReview = z.strictObject({
  note: z.string(named("说明")).trim().min(1).max(500),
});

export const DisputeResolution = z
  .strictObject({
    result: DisputeResult.openapi({ description: "改正了，还是确认没错" }),
    note: z.string(named("说明")).trim().min(1).max(500),
  })
  .openapi("DisputeResolution");

export const Disputes = z
  .object({
    disputes: z.array(
      z.object({
        id: Int,
        program: Feedback.shape.program,
        opened_at: UnixSeconds,
        feedback: z
          .array(Feedback)
          .openapi({ description: "上次复核以后的反馈，各带现在的状态：待处理的和驳回了的算人数" }),
      }),
    ),
  })
  .openapi("Disputes");
