import type { Transaction } from "kysely";
import type { DB } from "../../db/types.ts";

// The audit log of what admins and the owner do (design §12.4), written in the transaction that
// does it. Every module that has admin actions records them here, so it sits below them all.
export async function recordAudit(
  trx: Transaction<DB>,
  entry: {
    user_id: number;
    action: string;
    target_type:
      | "school"
      | "college"
      | "college_tag"
      | "program"
      | "source"
      | "source_probe"
      | "user"
      | "review_item"
      | "crawler_token"
      | "email_rules"
      | "mail_accounts";
    // None for settings, which have no row of their own.
    target_id: number | null;
    detail: Record<string, unknown>;
  },
) {
  await trx
    .insertInto("audit_log")
    .values({ ...entry, detail: JSON.stringify(entry.detail) })
    .execute();
}
