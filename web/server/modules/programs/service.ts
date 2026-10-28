import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import type { Evidence, ExtractedFields, Kind, TimeValue } from "./schemas.ts";
import { deadlineOf, startOf } from "./time.ts";

// A field as program_fields keeps it. The fields made of parts are kept a row per part, keyed by
// the field and the part: `apply:end`, `event:mode`, and `dates:` with the label of each other
// date. Each part then carries the evidence of the version it came from, and a later notice that
// states only some parts, such as a new deadline, replaces those and keeps the rest (design §8.4).
export type StoredField = { key: string; value: Json; evidence: Evidence[]; confidence: number };

export function toStoredFields({ apply, event, dates, ...rest }: ExtractedFields): StoredField[] {
  const byLabel = dates && {
    ...dates,
    value: Object.fromEntries(dates.value.map(({ label, ...time }) => [label, time])),
  };
  return [
    ...partsOf("apply", apply),
    ...partsOf("event", event),
    ...partsOf("dates", byLabel),
    ...Object.entries(rest).map(([key, entry]) => ({ key, ...entry })),
  ];
}

function partsOf(
  field: string,
  entry: { value: Record<string, Json>; evidence: Evidence[]; confidence: number } | undefined,
): StoredField[] {
  if (!entry) return [];
  const { value, ...support } = entry;
  return Object.entries(value).map(([part, v]) => ({
    key: `${field}:${part}`,
    value: v,
    ...support,
  }));
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
  if (changed.some((key) => APPLY_TIMES.includes(key))) await refreshApplyTimes(trx, programId);
  return { changed, conflicts };
}

const APPLY_TIMES = ["apply:start", "apply:end"];

// The instants the table sorts and reminds by, worked out from the apply field (design §8.2).
async function refreshApplyTimes(trx: Transaction<DB>, programId: number) {
  const times = new Map(
    (
      await trx
        .selectFrom("program_fields")
        .select(["key", sql<TimeValue>`value`.as("value")])
        .where("program_id", "=", programId)
        .where("key", "in", APPLY_TIMES)
        .execute()
    ).map((field) => [field.key, field.value]),
  );
  const start = times.get("apply:start");
  const end = times.get("apply:end");
  await trx
    .updateTable("programs")
    .set({
      apply_start: start ? startOf(start) : null,
      apply_deadline: end ? deadlineOf(end) : null,
    })
    .where("id", "=", programId)
    .execute();
}
