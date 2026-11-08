import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { unix } from "../../platform/http.ts";
import type { ApplyValue, Evidence, ExtractedFields, Kind, TimeValue } from "./schemas.ts";
import { deadlineOf, startOf } from "./time.ts";

// The apply field put back together from its parts, null when the notice gave none. `program`
// is the column holding the program's id, such as "programs.id".
export function applyOf(program: string) {
  return sql<ApplyValue | null>`(
    select jsonb_object_agg(split_part(field.key, ':', 2), field.value)
    from program_fields as field
    where field.program_id = ${sql.ref(program)} and field.key like 'apply:%'
  )`;
}

// Guests and frozen accounts see a preview of the table (design §6.2).
const PREVIEW_SIZE = 5;

// One cohort's programs for the table (design §10), by deadline. The link is to the notice of
// the latest call, or of the latest version if no call was found; every program is made with
// its first version.
export async function listPrograms(cohort: number, preview: boolean) {
  let query = db
    .selectFrom("programs as p")
    .innerJoin("colleges as c", "c.id", "p.college_id")
    .innerJoin("schools as s", "s.id", "c.school_id")
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom("program_versions as v")
          .innerJoin("snapshots as sn", "sn.id", "v.snapshot_id")
          .innerJoin("notices as n", "n.id", "sn.notice_id")
          .select(["n.url", "n.published_on"])
          .whereRef("v.program_id", "=", "p.id")
          .orderBy(sql`v.role = 'call'`, "desc")
          .orderBy("v.number", "desc")
          .limit(1)
          .as("notice"),
      (join) => join.onTrue(),
    )
    .select([
      "p.id",
      "p.name",
      "p.apply_start",
      "p.apply_deadline",
      sql<Kind>`p.kind`.as("kind"),
      applyOf("p.id").as("apply"),
      "s.name as school_name",
      "s.short_name as school_short_name",
      "s.tiers as school_tiers",
      "c.id as college_id",
      "c.name as college_name",
      "c.region as college_region",
      "c.directions as college_directions",
      "notice.url as notice_url",
      "notice.published_on as notice_published_on",
    ])
    .where("p.cohort", "=", cohort)
    .where("p.deleted_at", "is", null)
    .orderBy("p.apply_deadline", (order) => order.asc().nullsLast())
    .orderBy("p.id");
  if (preview) query = query.where("p.apply_deadline", ">", new Date()).limit(PREVIEW_SIZE);
  const rows = await query.execute();
  return {
    preview,
    programs: rows.map((row) => ({
      id: row.id,
      school: { name: row.school_name, short_name: row.school_short_name, tiers: row.school_tiers },
      college: {
        id: row.college_id,
        name: row.college_name,
        region: row.college_region,
        directions: row.college_directions,
      },
      kind: row.kind,
      name: row.name,
      apply: row.apply,
      apply_start: row.apply_start ? unix(row.apply_start) : null,
      apply_deadline: row.apply_deadline ? unix(row.apply_deadline) : null,
      notice: { url: row.notice_url, published_on: row.notice_published_on },
    })),
  };
}

// What the table's data is as of. It changes only with a new version, an edit or revert, or what
// admins do (reviews, deleting programs, editing schools and colleges), and each of those adds a
// row to one of these tables.
export async function tableVersion() {
  const { rows } = await sql<{ version: string }>`
    select concat(
      (select coalesce(max(id), 0) from program_versions), '-',
      (select coalesce(max(id), 0) from edits), '-',
      (select coalesce(max(id), 0) from audit_log)
    ) as version
  `.execute(db);
  return rows[0].version;
}

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
