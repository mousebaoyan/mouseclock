import type { Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";

export async function recordAudit(
  trx: Transaction<DB>,
  entry: {
    user_id: number;
    action: string;
    target_type: "school" | "college" | "source";
    target_id: number;
    detail: Record<string, unknown>;
  },
) {
  await trx
    .insertInto("audit_log")
    .values({ ...entry, detail: JSON.stringify(entry.detail) })
    .execute();
}
