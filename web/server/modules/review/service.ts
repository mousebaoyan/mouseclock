import type { Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";

// Why something waits on the review page instead of going on the table (design §8.3, §8.4).
export type ReviewReason =
  // a field held back from a version
  | "evidence_not_found"
  | "low_confidence"
  | "implausible"
  | "conflicts_edit"
  // a program from an extraction
  | "unknown_program"
  | "unknown_college"
  | "implausible_cohort"
  | "possible_duplicate"
  | "no_deadline";

export type ReviewItem = {
  reason: ReviewReason;
  snapshot_id: number;
  program_id?: number;
  version_id?: number;
  key?: string;
  payload: Json;
};

export async function holdForReview(trx: Transaction<DB>, items: ReviewItem[]) {
  if (items.length === 0) return;
  await trx
    .insertInto("review_items")
    .values(items.map((item) => ({ ...item, payload: JSON.stringify(item.payload) })))
    .execute();
}
