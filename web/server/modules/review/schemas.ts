import { z } from "@hono/zod-openapi";
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
  ProgramName,
  Text,
  Texts,
  TimeValue,
} from "../programs/schemas.ts";

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
    reason: z.string(named("理由")).trim().min(1).max(500),
    basis: z
      .string(named("依据"))
      .trim()
      .min(1)
      .max(2000)
      .openapi({ description: "原文链接，或截图的链接" }),
  })
  .openapi("ProgramEdit");
export type ProgramEdit = z.infer<typeof ProgramEdit>;

// A value as program_fields keeps it, one part of a field made of parts; or a program's name,
// cohort or kind.
const EditValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  TimeValue,
  DateWindow,
]);
export type EditValue = z.infer<typeof EditValue>;

export const Edit = z
  .object({
    id: Int,
    field: z.string().openapi({ description: "program_fields 的键，或 name、cohort、kind" }),
    old_value: EditValue.nullable().openapi({ description: "为空是原来没有" }),
    new_value: EditValue.nullable().openapi({ description: "为空是清空了" }),
    reason: z.string().nullable().openapi({ description: "撤销的为空" }),
    basis: z.string().nullable().openapi({ description: "撤销的为空" }),
    user: z.object({ id: Int, display_name: z.string() }),
    via: z.enum(["web", "agent"]),
    reverts_id: Int.nullable().openapi({ description: "撤销的是哪一次" }),
    reverted: z.boolean().openapi({ description: "这一次被撤销过" }),
    created_at: UnixSeconds,
  })
  .openapi("Edit");

export const ProgramEdits = z.object({ edits: z.array(Edit) }).openapi("ProgramEdits");

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
