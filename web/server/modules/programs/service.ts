import { isDeepStrictEqual } from "node:util";
import { sql, type ExpressionBuilder, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { sanitizeSnapshot } from "./sanitize.ts";
import type {
  ApplyValue,
  Attachment,
  DateWindow,
  Evidence,
  ExtractedFields,
  Kind,
  ProgramFields,
  Role,
  TimeValue,
} from "./schemas.ts";
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

// The notice a program links to as its original, on the table and its page: the latest call's,
// or the latest version's if no call was found. Every program is made with its first version.
function originalNotice(eb: ExpressionBuilder<DB & { p: DB["programs"] }, "p">) {
  return eb
    .selectFrom("program_versions as v")
    .innerJoin("snapshots as sn", "sn.id", "v.snapshot_id")
    .innerJoin("notices as n", "n.id", "sn.notice_id")
    .select(["n.title", "n.url", "n.published_on", "n.removed_at"])
    .whereRef("v.program_id", "=", "p.id")
    .orderBy(sql`v.role = 'call'`, "desc")
    .orderBy("v.number", "desc")
    .limit(1)
    .as("notice");
}

// One cohort's programs for the table (design §10), by deadline.
export async function listPrograms(cohort: number, preview: boolean) {
  let query = db
    .selectFrom("programs as p")
    .innerJoin("colleges as c", "c.id", "p.college_id")
    .innerJoin("schools as s", "s.id", "c.school_id")
    .innerJoinLateral(originalNotice, (join) => join.onTrue())
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

// A program's fields put back together (design §8.2), the parts of a field under it. Each part
// keeps its own evidence and the version it came from.
function fieldsOf(program: string) {
  return sql<ProgramFields>`(
    select coalesce(jsonb_object_agg(field, value), '{}')
    from (
      -- Each aggregate runs on every field, so the one for parts skips the rows without.
      select field, case
        when field in ('apply', 'event') then jsonb_object_agg(sub, part) filter (where sub is not null)
        when field = 'dates' then jsonb_agg(part || jsonb_build_object('label', sub))
        else jsonb_agg(part) -> 0 -- a field of one row
      end as value
      from (
        select
          split_part(f.key, ':', 1) as field,
          nullif(substr(f.key, strpos(f.key, ':') + 1), f.key) as sub,
          jsonb_build_object(
            'value', f.value,
            'evidence', f.evidence,
            'confidence', f.confidence,
            'version', case when v.id is not null then jsonb_build_object(
              'number', v.number,
              'snapshot_id', v.snapshot_id,
              'notice', jsonb_build_object('title', n.title, 'url', n.url)
            ) end
          ) as part
        from program_fields as f
        left join program_versions as v on v.id = f.version_id
        left join snapshots as sn on sn.id = v.snapshot_id
        left join notices as n on n.id = sn.notice_id
        where f.program_id = ${sql.ref(program)}
      ) as part
      group by field
    ) as field
  )`;
}

function notFound(): never {
  throw new AppError(404, "not_found", "项目不存在");
}

// A program's page (design §10): its fields with their evidence, and the original to check
// them against.
export async function getProgram(id: number) {
  const row = await db
    .selectFrom("programs as p")
    .innerJoin("colleges as c", "c.id", "p.college_id")
    .innerJoin("schools as s", "s.id", "c.school_id")
    .innerJoinLateral(originalNotice, (join) => join.onTrue())
    .leftJoin("users as u", "u.id", "p.verified_by")
    .select([
      "p.id",
      "p.cohort",
      "p.name",
      "p.apply_start",
      "p.apply_deadline",
      "p.verified_at",
      sql<Kind>`p.kind`.as("kind"),
      fieldsOf("p.id").as("fields"),
      "s.name as school_name",
      "s.short_name as school_short_name",
      "s.tiers as school_tiers",
      "c.id as college_id",
      "c.name as college_name",
      "c.region as college_region",
      "u.display_name as verified_by",
      "notice.title as notice_title",
      "notice.url as notice_url",
      "notice.published_on as notice_published_on",
      "notice.removed_at as notice_removed_at",
    ])
    .where("p.id", "=", id)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) notFound();
  return {
    id: row.id,
    school: { name: row.school_name, short_name: row.school_short_name, tiers: row.school_tiers },
    college: { id: row.college_id, name: row.college_name, region: row.college_region },
    cohort: row.cohort,
    kind: row.kind,
    name: row.name,
    apply_start: row.apply_start ? unix(row.apply_start) : null,
    apply_deadline: row.apply_deadline ? unix(row.apply_deadline) : null,
    verified:
      row.verified_at && row.verified_by
        ? { by: row.verified_by, at: unix(row.verified_at) }
        : null,
    notice: {
      title: row.notice_title,
      url: row.notice_url,
      published_on: row.notice_published_on,
      removed: row.notice_removed_at !== null,
    },
    // The other dates in order of time, worked out as the table's instants are.
    fields: {
      ...row.fields,
      dates: row.fields.dates?.toSorted(
        (a, b) => earliest(a.value) - earliest(b.value) || a.label.localeCompare(b.label, "zh-CN"),
      ),
    },
  };
}

function earliest(window: DateWindow) {
  return startOf("start" in window ? window.start : window.end).getTime();
}

// A snapshot's attachments, without the files themselves.
function attachmentsOf(snapshot: string) {
  return sql<Attachment[]>`(
    select coalesce(jsonb_agg(jsonb_build_object(
      'position', a.position,
      'name', a.name,
      'content_type', a.content_type,
      'size', octet_length(a.data)
    ) order by a.position), '[]')
    from attachments as a
    where a.snapshot_id = ${sql.ref(snapshot)}
  )`;
}

// A program's versions, the latest first: the notice behind each and what it changed.
export async function listVersions(programId: number) {
  const rows = await db
    .selectFrom("program_versions as v")
    .innerJoin("programs as p", "p.id", "v.program_id")
    .innerJoin("snapshots as sn", "sn.id", "v.snapshot_id")
    .innerJoin("notices as n", "n.id", "sn.notice_id")
    .select([
      "v.number",
      sql<Role>`v.role`.as("role"),
      "v.changes",
      "sn.id as snapshot_id",
      "sn.fetched_at",
      "n.title",
      "n.url",
      "n.published_on",
      "n.removed_at",
      attachmentsOf("sn.id").as("attachments"),
    ])
    .where("v.program_id", "=", programId)
    .where("p.deleted_at", "is", null)
    .orderBy("v.number", "desc")
    .execute();
  if (rows.length === 0) notFound();
  return {
    versions: rows.map((row) => ({
      number: row.number,
      role: row.role,
      changes: row.changes,
      notice: {
        title: row.title,
        url: row.url,
        published_on: row.published_on,
        removed: row.removed_at !== null,
      },
      snapshot: { id: row.snapshot_id, fetched_at: unix(row.fetched_at) },
      attachments: row.attachments,
    })),
  };
}

// A notice as it was fetched once, made safe to show (design §15).
export async function getSnapshot(id: number) {
  const row = await db
    .selectFrom("snapshots as sn")
    .innerJoin("notices as n", "n.id", "sn.notice_id")
    .select([
      "sn.id",
      "sn.fetched_at",
      "sn.html",
      "n.title",
      "n.url",
      "n.published_on",
      "n.removed_at",
      attachmentsOf("sn.id").as("attachments"),
    ])
    .where("sn.id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "快照不存在");
  return {
    id: row.id,
    fetched_at: unix(row.fetched_at),
    notice: {
      title: row.title,
      url: row.url,
      published_on: row.published_on,
      removed: row.removed_at !== null,
    },
    html: sanitizeSnapshot(row.html, row.url),
    attachments: row.attachments,
  };
}

export async function getAttachmentFile(snapshotId: number, position: number) {
  const row = await db
    .selectFrom("attachments")
    .select(["name", "content_type", "data"])
    .where("snapshot_id", "=", snapshotId)
    .where("position", "=", position)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "附件不存在");
  if (!row.data) throw new AppError(404, "not_uploaded", "附件的文件还没传上来");
  return { name: row.name, content_type: row.content_type, data: row.data };
}

// What the table's data is as of. It changes only with a new version, an edit or revert, or what
// admins do (reviews, deleting programs, editing schools and colleges), and each of those adds a
// row to one of these tables, which only grow. Counted rather than the highest id: transactions
// can commit in another order than they took their ids.
export async function tableVersion() {
  const { rows } = await sql<{ version: string }>`
    select concat(
      (select count(*) from program_versions), '-',
      (select count(*) from edits), '-',
      (select count(*) from audit_log)
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
