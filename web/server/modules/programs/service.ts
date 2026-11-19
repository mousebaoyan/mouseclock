import { isDeepStrictEqual } from "node:util";
import { sql, type ExpressionBuilder, type Insertable, type Transaction } from "kysely";
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
import { closesAt, deadlineOf, startOf } from "./time.ts";

// The apply field put back together from its parts, null when the notice gave none or people
// cleared it. `program` is the column holding the program's id, such as "programs.id".
export function applyOf(program: string) {
  return sql<ApplyValue | null>`(
    select jsonb_object_agg(split_part(field.key, ':', 2), field.value)
    from program_fields as field
    where field.program_id = ${sql.ref(program)} and field.key like 'apply:%'
      and field.value <> 'null'
  )`;
}

// The event's last stated time, its end or else its start ("event:end" sorts first), null without
// either; `program` as for applyOf.
export function eventEndOf(program: string) {
  return sql<TimeValue | null>`(
    select field.value from program_fields as field
    where field.program_id = ${sql.ref(program)} and field.key in ('event:end', 'event:start')
      and field.value <> 'null'
    order by field.key
    limit 1
  )`;
}

// The address of the emblem of the school `school` refers to, or null without one. The emblems
// are the sources module's, but the programs show them too, and sources already builds on this
// module, so the address is put together here. When the emblem last changed is in the address,
// so browsers keep it until it changes.
export function logoOf(school: string) {
  return sql<
    string | null
  >`(SELECT '/api/v1/schools/' || school_id || '/logo?v=' || floor(extract(epoch FROM updated_at) * 1000)::bigint FROM school_logos WHERE school_id = ${sql.ref(school)})`;
}

// Guests and frozen accounts see a preview of the table (design §6.2).
const PREVIEW_SIZE = 5;

// The notice a program links to as its original, on the table and its page: the latest call's,
// or the latest version's if no call was found. Every program is made with its first version.
export function originalNotice(eb: ExpressionBuilder<DB & { p: DB["programs"] }, "p">) {
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

// How many members subscribe to a program (design §11.3); `program` as for applyOf.
function subscribersOf(program: string) {
  return sql<number>`(select count(*)::int from subscriptions where program_id = ${sql.ref(program)})`;
}

// The programs as the table lists them (design §10).
function tableQuery() {
  return db
    .selectFrom("programs as p")
    .innerJoin("colleges as c", "c.id", "p.college_id")
    .innerJoin("schools as s", "s.id", "c.school_id")
    .innerJoinLateral(originalNotice, (join) => join.onTrue())
    .select([
      "p.id",
      "p.cohort",
      "p.name",
      "p.apply_start",
      "p.apply_deadline",
      eventEndOf("p.id").as("event_end"),
      sql<Kind>`p.kind`.as("kind"),
      applyOf("p.id").as("apply"),
      subscribersOf("p.id").as("subscribers"),
      "s.name as school_name",
      "s.short_names as school_short_names",
      "s.tier as school_tier",
      logoOf("s.id").as("school_logo"),
      "c.id as college_id",
      "c.name as college_name",
      "c.region as college_region",
      "c.directions as college_directions",
      "notice.url as notice_url",
      "notice.published_on as notice_published_on",
    ])
    .where("p.deleted_at", "is", null);
}

function tableProgram(row: Awaited<ReturnType<ReturnType<typeof tableQuery>["execute"]>>[number]) {
  return {
    id: row.id,
    school: {
      name: row.school_name,
      short_names: row.school_short_names,
      tier: row.school_tier,
      logo: row.school_logo,
    },
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
    closes_at: unix(closesAt(row.apply_deadline, row.event_end, row.cohort)),
    subscribers: row.subscribers,
    notice: { url: row.notice_url, published_on: row.notice_published_on },
  };
}

// One cohort's programs for the table, by deadline.
export async function listPrograms(cohort: number, preview: boolean) {
  let query = tableQuery()
    .where("p.cohort", "=", cohort)
    .orderBy("p.apply_deadline", (order) => order.asc().nullsLast())
    .orderBy("p.id");
  if (preview) query = query.where("p.apply_deadline", ">", new Date()).limit(PREVIEW_SIZE);
  return { preview, programs: (await query.execute()).map(tableProgram) };
}

// These programs as the table lists them, for one's own lists such as one's subscriptions.
export async function programCards(ids: number[]) {
  if (ids.length === 0) return [];
  return (await tableQuery().where("p.id", "in", ids).execute()).map(tableProgram);
}

// One's own lists' order: the open ones by deadline, then the closed ones, the latest to close
// first.
export function inDeadlineOrder<T>(
  items: T[],
  card: (item: T) => { id: number; closes_at: number },
) {
  const now = unix(new Date());
  const open = items.filter((item) => card(item).closes_at > now);
  const closed = items.filter((item) => card(item).closes_at <= now);
  return [
    ...open.toSorted((a, b) => card(a).closes_at - card(b).closes_at || card(a).id - card(b).id),
    ...closed.toSorted((a, b) => card(b).closes_at - card(a).closes_at || card(a).id - card(b).id),
  ];
}

// A program's fields put back together (design §8.2), the parts of a field under it. Each part
// keeps its own evidence and the version it came from. Fields people cleared are left out.
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
        where f.program_id = ${sql.ref(program)} and f.value <> 'null'
      ) as part
      group by field
    ) as field
  )`;
}

function notFound(): never {
  throw new AppError(404, "not_found", "项目不存在");
}

// Where a merged program's links lead (design §12.2). Asked only once the program isn't found:
// a merge marks it deleted and where it went in one go, so this sees both or neither.
async function mergedInto(id: number) {
  const row = await db
    .selectFrom("programs")
    .select("merged_into")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || row.merged_into === null) notFound();
  return { merged_into: row.merged_into };
}

// A program's page (design §10): its fields with their evidence, and the original to check
// them against. A merged program has none of its own and leads to the one it went into.
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
      eventEndOf("p.id").as("event_end"),
      "p.verified_at",
      sql<Kind>`p.kind`.as("kind"),
      fieldsOf("p.id").as("fields"),
      "s.name as school_name",
      "s.tier as school_tier",
      logoOf("s.id").as("school_logo"),
      "c.id as college_id",
      "c.name as college_name",
      "c.region as college_region",
      subscribersOf("p.id").as("subscribers"),
      "u.display_name as verified_by",
      "notice.title as notice_title",
      "notice.url as notice_url",
      "notice.published_on as notice_published_on",
      "notice.removed_at as notice_removed_at",
    ])
    .where("p.id", "=", id)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return mergedInto(id);
  return {
    id: row.id,
    school: { name: row.school_name, tier: row.school_tier, logo: row.school_logo },
    college: { id: row.college_id, name: row.college_name, region: row.college_region },
    cohort: row.cohort,
    kind: row.kind,
    name: row.name,
    apply_start: row.apply_start ? unix(row.apply_start) : null,
    apply_deadline: row.apply_deadline ? unix(row.apply_deadline) : null,
    closes_at: unix(closesAt(row.apply_deadline, row.event_end, row.cohort)),
    subscribers: row.subscribers,
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

// What the table's data is as of. It changes only with a new version, an edit or revert, what
// admins do (reviews, deleting programs, editing schools and colleges), each of which adds a row to
// a table that only grows, or a subscription. Counted rather than the highest id: transactions can
// commit in another order than they took their ids. Subscriptions come and go, so the latest one
// made counts too: subscribing makes a later one, unsubscribing lowers the count, and a merge, which
// moves them, is a review.
export async function tableVersion() {
  const { rows } = await sql<{ version: string }>`
    select concat(
      (select count(*) from program_versions), '-',
      (select count(*) from edits), '-',
      (select count(*) from audit_log), '-',
      (select count(*) from subscriptions), '-',
      (select floor(extract(epoch from max(created_at)) * 1000)::bigint from subscriptions)
    ) as version
  `.execute(db);
  return rows[0].version;
}

// A field as program_fields keeps it. The fields made of parts are kept a row per part, keyed by
// the field and the part: `apply:end`, `event:mode`, and `dates:` with the label of each other
// date. Each part then carries the evidence of the version it came from, and a later notice that
// states only some parts, such as a new deadline, replaces those and keeps the rest (design §8.4).
export type StoredField = {
  key: string;
  value: Json;
  evidence: Evidence[];
  confidence: number;
  checked?: true;
};

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
  entry:
    | { value: Record<string, Json>; evidence: Evidence[]; confidence: number; checked?: true }
    | undefined,
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
// conflicts for the review page (design §8.4). A value the field has already is from this version
// now, the latest to state it, so an earlier notice read after doesn't change it. Returns the
// keys whose value changed.
export async function applyStored(
  trx: Transaction<DB>,
  programId: number,
  versionId: number,
  rows: StoredField[],
) {
  const current = await currentFields(trx, programId);
  const changed: string[] = [];
  const conflicts: StoredField[] = [];
  for (const row of rows) {
    const now = current.get(row.key);
    const same = now !== undefined && isDeepStrictEqual(now.value, row.value);
    if (now?.edit_id) {
      if (!same) conflicts.push(row);
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
    await upsertField(trx, programId, row.key, values);
    if (!same) changed.push(row.key);
  }
  await afterChange(trx, programId, changed);
  return { changed, conflicts };
}

type FieldRow = Omit<Insertable<DB["program_fields"]>, "program_id" | "key">;

async function upsertField(trx: Transaction<DB>, programId: number, key: string, row: FieldRow) {
  await trx
    .insertInto("program_fields")
    .values({ program_id: programId, key, ...row })
    .onConflict((oc) => oc.columns(["program_id", "key"]).doUpdateSet(row))
    .execute();
}

// A program people are changing, locked until the change is in.
export async function lockProgram(trx: Transaction<DB>, id: number) {
  const row = await trx
    .selectFrom("programs")
    .select(["name", "cohort", sql<Kind>`kind`.as("kind")])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  if (!row) notFound();
  return row;
}

// A program's fields as they stand, locked, and where each value came from.
export async function currentFields(trx: Transaction<DB>, programId: number) {
  const rows = await trx
    .selectFrom("program_fields")
    .select(["key", "value", "version_id", "edit_id"])
    .where("program_id", "=", programId)
    .forUpdate()
    .execute();
  return new Map(rows.map((row) => [row.key, row]));
}

// Where a field's value is to come from (design §12.4): a person, whose null clears it and keeps
// later notices from adding it back; a version, which later notices go on updating; or nowhere,
// as before any notice stated it.
export type FieldSource = { value: Json; edit_id: number } | { version_id: number } | null;

export async function setFields(
  trx: Transaction<DB>,
  programId: number,
  fields: [key: string, source: FieldSource][],
) {
  for (const [key, source] of fields) {
    if (source === null) {
      await trx
        .deleteFrom("program_fields")
        .where("program_id", "=", programId)
        .where("key", "=", key)
        .execute();
    } else if ("edit_id" in source) {
      await upsertField(trx, programId, key, {
        value: JSON.stringify(source.value),
        evidence: "[]",
        confidence: null,
        version_id: null,
        edit_id: source.edit_id,
        updated_at: new Date(),
      });
    } else {
      await upsertField(trx, programId, key, {
        ...(await versionField(trx, source.version_id, key)),
        version_id: source.version_id,
        edit_id: null,
        updated_at: new Date(),
      });
    }
  }
  await afterChange(
    trx,
    programId,
    fields.map(([key]) => key),
  );
}

// A field as a version gave it, with its evidence.
async function versionField(trx: Transaction<DB>, versionId: number, key: string) {
  const { fields } = await trx
    .selectFrom("program_versions")
    .select(sql<ExtractedFields>`fields`.as("fields"))
    .where("id", "=", versionId)
    .executeTakeFirstOrThrow();
  const field = toStoredFields(fields).find((row) => row.key === key);
  // Only asked for the version a value came from, which has the field.
  if (!field) throw new Error(`Version ${versionId} has no field ${key}`);
  return {
    value: JSON.stringify(field.value),
    evidence: JSON.stringify(field.evidence),
    confidence: field.confidence,
  };
}

export async function updateProgram(
  trx: Transaction<DB>,
  id: number,
  values: { name?: string; cohort?: number; kind?: Kind },
) {
  await trx
    .updateTable("programs")
    .set({ ...values, verified_by: null, verified_at: null })
    .where("id", "=", id)
    .execute();
}

const APPLY_TIMES = ["apply:start", "apply:end"];

// After a version or a person changed some fields: the instants the table sorts and reminds by
// follow the apply field (design §8.2), and the program waits to be verified again (§9.2).
async function afterChange(trx: Transaction<DB>, programId: number, keys: string[]) {
  if (keys.length === 0) return;
  const times = keys.some((key) => APPLY_TIMES.includes(key))
    ? await applyTimes(trx, programId)
    : {};
  await trx
    .updateTable("programs")
    .set({ ...times, verified_by: null, verified_at: null })
    .where("id", "=", programId)
    .execute();
}

async function applyTimes(trx: Transaction<DB>, programId: number) {
  const times = new Map(
    (
      await trx
        .selectFrom("program_fields")
        .select(["key", sql<TimeValue | null>`value`.as("value")])
        .where("program_id", "=", programId)
        .where("key", "in", APPLY_TIMES)
        .execute()
    ).map((field) => [field.key, field.value]),
  );
  const start = times.get("apply:start");
  const end = times.get("apply:end");
  return {
    apply_start: start ? startOf(start) : null,
    apply_deadline: end ? deadlineOf(end) : null,
  };
}

// A program an admin deleted, or one merged into another on the review page (design §12.2); it
// stays for the record. A merged one's links lead to where it went, and so do those of the ones
// merged into it before, so a link never has to be followed twice.
export async function deleteProgram(trx: Transaction<DB>, id: number, keptId: number | null) {
  await trx
    .updateTable("programs")
    .set({ deleted_at: new Date(), merged_into: keptId })
    .where("id", "=", id)
    .execute();
  if (keptId !== null) {
    await trx
      .updateTable("programs")
      .set({ merged_into: keptId })
      .where("merged_into", "=", id)
      .execute();
    // Records of applying go along; one who kept a record on both keeps the later one (§9.4).
    await trx
      .insertInto("applications")
      .columns(["user_id", "program_id", "stage", "note", "updated_at"])
      .expression((eb) =>
        eb
          .selectFrom("applications")
          .select(["user_id", eb.val(keptId).as("program_id"), "stage", "note", "updated_at"])
          .where("program_id", "=", id),
      )
      .onConflict((oc) =>
        oc
          .columns(["user_id", "program_id"])
          .doUpdateSet((eb) => ({
            stage: eb.ref("excluded.stage"),
            note: eb.ref("excluded.note"),
            updated_at: eb.ref("excluded.updated_at"),
          }))
          .whereRef("applications.updated_at", "<", "excluded.updated_at"),
      )
      .execute();
    await trx.deleteFrom("applications").where("program_id", "=", id).execute();
  }
}

// Someone checked all of a program's fields against the original (design §9.2).
export async function verifyProgram(id: number, userId: number) {
  const row = await db
    .updateTable("programs")
    .set({ verified_by: userId, verified_at: new Date() })
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!row) notFound();
}
