import { data } from "react-router";
import {
  PublicCollegeDetail as PublicCollegeDetailSchema,
  PublicCollegeList as PublicCollegeListSchema,
} from "../server/modules/sources/schemas.ts";
import type { z } from "zod";

export type PublicCollegeList = z.infer<typeof PublicCollegeListSchema>;
export type PublicCollegeDetail = z.infer<typeof PublicCollegeDetailSchema>;
export const publicCollegeListSchema = PublicCollegeListSchema;
export const publicCollegeDetailSchema = PublicCollegeDetailSchema;

function isErrorBody(value: unknown): value is { error: { message: string } } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  );
}

export async function readPublicApi<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await res.json();
  if (res.status !== 200) {
    if (!isErrorBody(body)) throw data("服务器返回了无效错误", { status: res.status });
    throw data(body.error.message, { status: res.status });
  }
  return schema.parse(body);
}
