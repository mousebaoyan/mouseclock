import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import type { ApplyValue, Evidence, ExtractedFields, Kind } from "./schemas.ts";
import { deadlineOf, startOf } from "./time.ts";

// A field as program_fields keeps it. Other dates are kept one row each, keyed `dates:` and
// the label, so each carries the evidence of the version it came from and a later notice adds
// dates or replaces those of the same label instead of dropping the rest (design §8.4).
export type StoredField = { key: string; value: Json; evidence: Evidence[]; confidence: number };

export function toStoredFields(fields: ExtractedFields): StoredField[] {
  const { dates, ...rest } = fields;
  const rows: StoredField[] = Object.entries(rest).map(([key, entry]) => ({ key, ...entry }));
  if (!dates) return rows;
  const { value, ...support } = dates;
  return [
    ...rows,
    ...value.map(({ label, ...time }) => ({ key: `dates:${label}`, value: time, ...support })),
  ];
}

export async function createProgram(
  trx: Transaction<DB>,
  {
    college_id,
    cohort,
    kind,
    name,
  }: { college_id: number; cohort: number; kind: Kind; name: string },
) {
  const { id } = await trx
    .insertInto("programs")
    .values({ college_id, cohort, kind, name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

// Puts what a version says on its program, unless a person set the field: those come back as
// conflicts for the review page (design §8.4). Returns the keys whose value changed.
export async function applyStored(
  trx: Transaction<DB>,
  programId: number,
  versionId: number,
  rows: StoredField[],
) {
  const current = new Map(
    (
      await trx
        .selectFrom("program_fields")
        .select(["key", "value", "edit_id"])
        .where("program_id", "=", programId)
        .forUpdate()
        .execute()
    ).map((field) => [field.key, field]),
  );
  const changed: string[] = [];
  const conflicts: StoredField[] = [];
  for (const row of rows) {
    const now = current.get(row.key);
    if (now && isDeepStrictEqual(now.value, row.value)) continue;
    if (now?.edit_id) {
      conflicts.push(row);
      continue;
    }
    const values = {
      value: JSON.stringify(row.value),
      evidence: JSON.stringify(row.evidence),
      confidence: row.confidence,
      version_id: versionId,
      edit_id: null,
      updated_at: new Date(),
    };
    await trx
      .insertInto("program_fields")
      .values({ program_id: programId, key: row.key, ...values })
      .onConflict((oc) => oc.columns(["program_id", "key"]).doUpdateSet(values))
      .execute();
    changed.push(row.key);
  }
  if (changed.includes("apply")) await refreshApplyTimes(trx, programId);
  return { changed, conflicts };
}

// The instants the table sorts and reminds by, worked out from the apply field (design §8.2).
async function refreshApplyTimes(trx: Transaction<DB>, programId: number) {
  const apply = await trx
    .selectFrom("program_fields")
    .select(sql<ApplyValue>`value`.as("value"))
    .where("program_id", "=", programId)
    .where("key", "=", "apply")
    .executeTakeFirst();
  await trx
    .updateTable("programs")
    .set({
      apply_start: apply?.value.start ? startOf(apply.value.start) : null,
      apply_deadline: apply?.value.end ? deadlineOf(apply.value.end) : null,
    })
    .where("id", "=", programId)
    .execute();
}
