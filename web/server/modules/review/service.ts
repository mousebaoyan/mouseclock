import { isDeepStrictEqual } from "node:util";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DB, Edits, Json } from "../../../db/types.ts";
import { db, pageOf } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { holdEditing, revokeEditing } from "../accounts/service.ts";
import {
  currentFields,
  lockProgram,
  setFields,
  updateProgram,
  type FieldSource,
} from "../programs/service.ts";
import type { StoredValue } from "../programs/schemas.ts";
import { ProgramColumns, type ProgramEdit } from "./schemas.ts";

type Actor = { user_id: number; via: "web" };

export async function recordAudit(
  trx: Transaction<DB>,
  entry: {
    user_id: number;
    action: string;
    target_type: "school" | "college" | "source" | "user" | "review_item" | "crawler_token";
    target_id: number;
    detail: Record<string, unknown>;
  },
) {
  await trx
    .insertInto("audit_log")
    .values({ ...entry, detail: JSON.stringify(entry.detail) })
    .execute();
}

const COLUMNS = ProgramColumns.keyof().options;
type FieldEdits = Omit<ProgramEdit, (typeof COLUMNS)[number] | "reason" | "basis">;

// For a jsonb column of edits, where SQL's NULL is "none".
function json(value: Json | null) {
  return value === null ? null : JSON.stringify(value);
}

// What a field or column has its value from (data-model.md): a version, an edit, or neither, for a
// field no notice stated or a column as the program was made.
type Source = { version_id: number } | { edit_id: number } | null;

function sourceOf(row: { version_id: number | null; edit_id: number | null } | undefined): Source {
  if (!row) return null;
  if (row.edit_id !== null) return { edit_id: row.edit_id };
  return row.version_id === null ? null : { version_id: row.version_id };
}

function sourceBefore(edit: { old_version_id: number | null; old_edit_id: number | null }) {
  return sourceOf({ version_id: edit.old_version_id, edit_id: edit.old_edit_id });
}

// The columns of edits that keep the source an edit replaced.
function replacing(source: Source) {
  return {
    old_version_id: source && "version_id" in source ? source.version_id : null,
    old_edit_id: source && "edit_id" in source ? source.edit_id : null,
  };
}

// The source an edit left: itself, or for a revert the source the reverted edit had replaced.
async function resultOf(trx: Transaction<DB>, edit: Selectable<Edits>): Promise<Source> {
  if (edit.reverts_id === null) return { edit_id: edit.id };
  return sourceBefore(
    await trx
      .selectFrom("edits")
      .select(["old_version_id", "old_edit_id"])
      .where("id", "=", edit.reverts_id)
      .executeTakeFirstOrThrow(),
  );
}

// A column has no row to say which edit set it, as program_fields does: its latest edit tells.
async function columnSource(
  trx: Transaction<DB>,
  programId: number,
  column: (typeof COLUMNS)[number],
): Promise<Source> {
  const latest = await trx
    .selectFrom("edits")
    .selectAll()
    .where("program_id", "=", programId)
    .where("field", "=", column)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return latest ? resultOf(trx, latest) : null;
}

// The program_fields rows an edit sets, null for those it clears (data-model.md): a field made of
// parts sets each part it has and clears the ones it no longer has.
function fieldChanges({ apply, event, dates, ...rest }: FieldEdits, keys: string[]) {
  const byLabel = dates && Object.fromEntries(dates.map(({ label, ...time }) => [label, time]));
  return [
    ...partChanges("apply", apply, keys),
    ...partChanges("event", event, keys),
    ...partChanges("dates", byLabel, keys),
    ...Object.entries(rest).map(([key, value]) => ({ key, value })),
  ];
}

function partChanges(
  field: string,
  value: Record<string, Json> | null | undefined,
  keys: string[],
): { key: string; value: Json | null }[] {
  if (value === undefined) return [];
  const set = Object.entries(value ?? {}).map(([part, v]) => ({
    key: `${field}:${part}`,
    value: v,
  }));
  const cleared = keys
    .filter((key) => key.startsWith(`${field}:`) && !set.some((row) => row.key === key))
    .map((key) => ({ key, value: null }));
  return [...set, ...cleared];
}

// A direct edit (design §12.4): a row of edits for each field, part or column whose value it
// changes, and the fields set to the new values, held against later notices.
export async function editProgram(
  actor: Actor,
  programId: number,
  { reason, basis, name, cohort, kind, ...fields }: ProgramEdit,
) {
  const ids = await db.transaction().execute(async (trx) => {
    await holdEditing(trx, actor.user_id);
    const program = await lockProgram(trx, programId);
    const current = await currentFields(trx, programId);
    const values = { name, cohort, kind };
    const columns = COLUMNS.flatMap((column) => {
      const value = values[column];
      return value === undefined || value === program[column] ? [] : [{ column, value }];
    });
    const changes = fieldChanges(fields, [...current.keys()]).filter(
      ({ key, value }) => !isDeepStrictEqual(current.get(key)?.value ?? null, value),
    );
    if (columns.length + changes.length === 0) {
      throw new AppError(400, "no_change", "改后的值和现在的一样");
    }
    const recorded: number[] = [];
    const record = async (
      field: string,
      old_value: Json | null,
      new_value: Json | null,
      source: Source,
    ) => {
      const { id } = await trx
        .insertInto("edits")
        .values({
          field,
          old_value: json(old_value),
          new_value: json(new_value),
          ...replacing(source),
          program_id: programId,
          reason,
          basis,
          user_id: actor.user_id,
          via: actor.via,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      recorded.push(id);
      return id;
    };
    for (const { column, value } of columns) {
      await record(column, program[column], value, await columnSource(trx, programId, column));
    }
    if (columns.length > 0) await updateProgram(trx, programId, values);
    const sources: [string, FieldSource][] = [];
    for (const { key, value } of changes) {
      const now = current.get(key);
      const id = await record(key, now?.value ?? null, value, sourceOf(now));
      sources.push([key, { value, edit_id: id }]);
    }
    await setFields(trx, programId, sources);
    return recorded;
  });
  const rows = await editsQuery().where("edits.id", "in", ids).orderBy("edits.id").execute();
  return { edits: rows.map(toEdit) };
}

// The field back as it was before the edit, its source too (design §12.4). Null, changing
// nothing, once the field no longer has its value from the edit: someone changed it since, even
// back to the same value, or reverted it already.
async function revert(trx: Transaction<DB>, actor: Actor, edit: Selectable<Edits>) {
  await lockProgram(trx, edit.program_id);
  const column = COLUMNS.find((name) => name === edit.field);
  const source = column
    ? await columnSource(trx, edit.program_id, column)
    : sourceOf((await currentFields(trx, edit.program_id)).get(edit.field));
  if (!isDeepStrictEqual(source, await resultOf(trx, edit))) return null;
  const { id } = await trx
    .insertInto("edits")
    .values({
      program_id: edit.program_id,
      field: edit.field,
      old_value: json(edit.new_value),
      new_value: json(edit.old_value),
      ...replacing(source),
      user_id: actor.user_id,
      via: actor.via,
      reverts_id: edit.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const restored = sourceBefore(edit);
  if (column) {
    // Typed again from the JSON edits keep it as.
    await updateProgram(trx, edit.program_id, ProgramColumns.parse({ [column]: edit.old_value }));
  } else {
    const to: FieldSource =
      restored && "edit_id" in restored
        ? { value: edit.old_value, edit_id: restored.edit_id }
        : restored;
    await setFields(trx, edit.program_id, [[edit.field, to]]);
  }
  return id;
}

export async function revertEdit(actor: Actor, editId: number) {
  const id = await db.transaction().execute(async (trx) => {
    const edit = await trx
      .selectFrom("edits")
      .selectAll()
      .where("id", "=", editId)
      .executeTakeFirst();
    if (!edit) throw new AppError(404, "not_found", "修改记录不存在");
    await holdEditing(trx, actor.user_id);
    const reverted = await revert(trx, actor, edit);
    if (reverted === null) {
      throw new AppError(
        409,
        "edit_superseded",
        "这一项在这次修改之后又改过或撤销过，要先撤销后来的那次",
      );
    }
    return reverted;
  });
  return { edit: toEdit(await editsQuery().where("edits.id", "=", id).executeTakeFirstOrThrow()) };
}

// An admin undoes all someone's edits, the latest first, and takes back their editing (design
// §12.4). Edits others changed since are kept: theirs are the later word.
export async function revokeEdits(actor: Actor, userId: number) {
  return db.transaction().execute(async (trx) => {
    await revokeEditing(trx, userId);
    const edits = await trx
      .selectFrom("edits as e")
      .innerJoin("programs as p", "p.id", "e.program_id")
      .selectAll("e")
      .where("e.user_id", "=", userId)
      .where("p.deleted_at", "is", null)
      .orderBy("e.id", "desc")
      .execute();
    const reverted: number[] = [];
    for (const edit of edits) {
      if ((await revert(trx, actor, edit)) !== null) reverted.push(edit.id);
    }
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "revoke_edits",
      target_type: "user",
      target_id: userId,
      detail: { via: actor.via, reverted },
    });
    return { reverted: reverted.length, kept: edits.length - reverted.length };
  });
}

// Unaliased, as pageOf takes the tables by name.
function editsQuery() {
  return db
    .selectFrom("edits")
    .innerJoin("users", "users.id", "edits.user_id")
    .select((eb) => [
      "edits.id",
      "edits.field",
      sql<StoredValue | null>`edits.old_value`.as("old_value"),
      sql<StoredValue | null>`edits.new_value`.as("new_value"),
      "edits.reason",
      "edits.basis",
      "edits.user_id",
      "users.display_name",
      sql<"web" | "agent">`edits.via`.as("via"),
      "edits.reverts_id",
      // PostgreSQL answers exists with a boolean; Kysely types it for every database.
      eb
        .exists(
          eb.selectFrom("edits as r").select("r.id").whereRef("r.reverts_id", "=", "edits.id"),
        )
        .$castTo<boolean>()
        .as("reverted"),
      "edits.created_at",
    ]);
}

type EditRow = Awaited<ReturnType<ReturnType<typeof editsQuery>["executeTakeFirstOrThrow"]>>;

function toEdit({ user_id, display_name, created_at, ...edit }: EditRow) {
  return { ...edit, user: { id: user_id, display_name }, created_at: unix(created_at) };
}

export async function listProgramEdits(programId: number) {
  const [program, rows] = await Promise.all([
    db
      .selectFrom("programs")
      .select("id")
      .where("id", "=", programId)
      .where("deleted_at", "is", null)
      .executeTakeFirst(),
    editsQuery().where("edits.program_id", "=", programId).orderBy("edits.id", "desc").execute(),
  ]);
  if (!program) throw new AppError(404, "not_found", "项目不存在");
  return { edits: rows.map(toEdit) };
}

// The latest edits across the site, for the review page (design §12.4).
export async function listRecentEdits(paging: { page: number; per_page: number }) {
  const page = await pageOf(
    editsQuery()
      .innerJoin("programs", "programs.id", "edits.program_id")
      .innerJoin("colleges", "colleges.id", "programs.college_id")
      .innerJoin("schools", "schools.id", "colleges.school_id")
      .select([
        "programs.id as program_id",
        "programs.name as program_name",
        "schools.name as school",
        "colleges.name as college",
      ])
      .where("programs.deleted_at", "is", null)
      .orderBy("edits.id", "desc"),
    paging,
  );
  return {
    ...page,
    items: page.items.map(({ program_id, program_name, school, college, ...row }) => ({
      ...toEdit(row),
      program: { id: program_id, name: program_name, school, college },
    })),
  };
}
