import { z } from "@hono/zod-openapi";
import { Int, Url } from "../../platform/http.ts";
import {
  AttachmentFailureKind,
  Cohort,
  Evidence,
  ExtractedFields,
  Kind,
  ProgramName,
  Role,
} from "../programs/schemas.ts";
import { Failure } from "../sources/schemas.ts";

export const MB = 1024 * 1024;

export const UnresolvedDate = z
  .strictObject({
    field: z.enum(["apply.start", "apply.end", "event.start", "event.end", "dates"]),
    text: z.string().trim().min(1).max(2000),
    evidence: z.array(Evidence).min(1).max(20),
  })
  .openapi("UnresolvedDate");
export type UnresolvedDate = z.infer<typeof UnresolvedDate>;

export const Detail = z.string().max(1000).openapi({ description: "具体原因，比如 HTTP 403" });
export const NoticeFailure = z
  .strictObject({ url: Url, failure: Failure, detail: Detail.optional() })
  .openapi("NoticeFailure");
export type NoticeFailure = z.infer<typeof NoticeFailure>;
export const Usage = z
  .strictObject({
    model: z.string().min(1).max(100),
    input_tokens: Int.min(0),
    output_tokens: Int.min(0),
  })
  .openapi("Usage");
export type Usage = z.infer<typeof Usage>;

// One program a notice is about, as design §8.2 lays out.
export const ExtractedProgram = z
  .strictObject({
    program_id: Int.optional().openapi({ description: "对照里的哪个项目；新项目不写" }),
    college_id: Int,
    cohort: Cohort,
    kind: Kind,
    name: ProgramName,
    role: Role.openapi({ description: "call：报名；update：补充；result：名单" }),
    fields: ExtractedFields,
    unresolved_dates: z.array(UnresolvedDate).max(30).optional(),
    checked: z
      .array(z.enum(["no_deadline", "new"]))
      .max(2)
      .optional()
      .openapi({
        description:
          "另一个模型也这样判断（总体设计 §8.3）：no_deadline 是报名通知确实没写截止，new 是学校没有这个项目，同学院、同届、同类型的那几个都不是",
      }),
  })
  .openapi("ExtractedProgram");
export type ExtractedProgram = z.infer<typeof ExtractedProgram>;

const attachment = {
  name: z.string().min(1).max(500),
  url: Url,
  content_type: z.string().min(1).max(200),
};
export const AttachmentInfo = z
  .union([
    z
      .strictObject({
        ...attachment,
        text: z.string().max(2 * MB),
        read_from_pictures: z.boolean().openapi({
          description: "文字里有 LLM 从图片或扫描页读出来的部分",
        }),
      })
      .openapi("ReadAttachment"),
    z
      .strictObject({ ...attachment, failure: AttachmentFailureKind, detail: Detail.optional() })
      .openapi("UnreadAttachment"),
  ])
  .openapi("AttachmentInfo");
export type AttachmentInfo = z.infer<typeof AttachmentInfo>;

// An attachment a round couldn't read, on the notice it is in.
export const AttachmentFailure = z
  .strictObject({
    notice_url: Url,
    url: Url,
    failure: AttachmentFailureKind,
    detail: Detail.optional(),
  })
  .openapi("AttachmentFailure");
export type AttachmentFailure = z.infer<typeof AttachmentFailure>;
