import { z } from "@hono/zod-openapi";
import { Evidence } from "../programs/schemas.ts";

export const UnresolvedDate = z
  .strictObject({
    field: z.enum(["apply.start", "apply.end", "event.start", "event.end", "dates"]),
    text: z.string().trim().min(1).max(2000),
    evidence: z.array(Evidence).min(1).max(20),
  })
  .openapi("UnresolvedDate");
export type UnresolvedDate = z.infer<typeof UnresolvedDate>;
