import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { db, pageOf } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { holdEditing } from "../accounts/service.ts";
import { currentFields, lockProgram } from "../programs/service.ts";
import type { StoredValue } from "../programs/schemas.ts";
import { sendMessages } from "../reminders/messages.ts";
import type { FEEDBACK_STATUSES, FeedbackInput } from "./schemas.ts";
import { ProgramColumns } from "./schemas.ts";
import { changedColumns, changedFields, writeEdit, type Actor } from "./service.ts";

// Feedback and edit requests (design §12.1, §12.2) and disputes (§12.3).

type Status = (typeof FEEDBACK_STATUSES)[number];

// How many people finding a program wrong make it disputed.
export const DISPUTE_PEOPLE = 3;

function isColumn(field: string): field is keyof typeof ProgramColumns.shape {
  return Object.hasOwn(ProgramColumns.shape, field);
}

// Giving it again for the same part, while the first still waits, replaces the first under a new
// id: a reviewer deciding the first never passes what they didn't see.
export async function giveFeedback(actor: Actor, programId: number, input: FeedbackInput) {
  return db.transaction().execute(async (trx) => {
    const program = await lockProgram(trx, programId);
    const { field } = input;
    // What the part is now, a column or a row of program_fields.
    const old =
      field === null
        ? null
        : isColumn(field)
          ? program[field]
          : ((
              await trx
                .selectFrom("program_fields")
                .select("value")
                .where("program_id", "=", programId)
                .where("key", "=", field)
                .executeTakeFirst()
            )?.value ?? null);
    if (input.kind === "edit" && isDeepStrictEqual(old, input.value)) {
      throw new AppError(400, "no_change", "改后的值和现在的一样");
    }
    await trx
      .deleteFrom("feedback")
      .where("program_id", "=", programId)
      .where("user_id", "=", actor.user_id)
      .where("field", "is not distinct from", field)
      .where("status", "=", "pending")
      .execute();
    const { id } = await trx
      .insertInto("feedback")
      .values({
        program_id: programId,
        user_id: actor.user_id,
        kind: input.kind,
        field,
        old_value: json(old),
        proposed_value: input.kind === "edit" ? json(input.value) : null,
        reason: input.reason,
        basis: input.basis,
        via: actor.via,
        // When it is written, not when its transaction began: a review that held the program's
        // lock till now came before it, and it counts afresh after that review.
        created_at: sql<Date>`clock_timestamp()`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await openDispute(trx, programId);
    return { id };
  });
}

// For a jsonb column, where SQL's NULL is "none".
function json(value: Json | null) {
  return value === null ? null : JSON.stringify(value);
}

// Its own, while it still waits.
export async function withdrawFeedback(userId: number, id: number) {
  const row = await db
    .updateTable("feedback")
    .set({ status: "withdrawn" })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .returning("id")
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "没有这条待处理的反馈");
}

// When the last review of a program was, to count afresh from.
function sinceReview(program: string) {
  return sql<Date>`coalesce(
    (select max(d.resolved_at) from disputes as d where d.program_id = ${sql.ref(program)}),
    '-infinity'
  )`;
}

// DISPUTE_PEOPLE people saying a program is wrong since its last review make it disputed; those
// still waiting and those rejected count, as being rejected and still said is what an admin is to
// look at (design §12.3).
async function openDispute(trx: Transaction<DB>, programId: number) {
  const { people } = await trx
    .selectFrom("feedback")
    .select((eb) => eb.fn.count<number>("user_id").distinct().as("people"))
    .where("program_id", "=", programId)
    .where("status", "in", ["pending", "rejected"])
    .where("created_at", ">", sinceReview("feedback.program_id"))
    .executeTakeFirstOrThrow();
  if (people < DISPUTE_PEOPLE) return;
  await trx
    .insertInto("disputes")
    .values({ program_id: programId })
    .onConflict((oc) => oc.column("program_id").where("resolved_at", "is", null).doNothing())
    .execute();
}

// Unaliased, as pageOf takes the tables by name.
function feedbackQuery() {
  return db
    .selectFrom("feedback")
    .innerJoin("programs", "programs.id", "feedback.program_id")
    .innerJoin("colleges", "colleges.id", "programs.college_id")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .innerJoin("users", "users.id", "feedback.user_id")
    .select([
      "feedback.id",
      "programs.id as program_id",
      "programs.name as program_name",
      "schools.name as school",
      "colleges.name as college",
      sql<"problem" | "edit">`feedback.kind`.as("kind"),
      "feedback.field",
      sql<StoredValue | null>`feedback.old_value`.as("old_value"),
      sql<StoredValue | null>`feedback.proposed_value`.as("proposed_value"),
      "feedback.reason",
      "feedback.basis",
      sql<Status>`feedback.status`.as("status"),
      sql<"web" | "agent">`feedback.via`.as("via"),
      "users.id as user_id",
      "users.display_name",
      "feedback.created_at",
      sql<string | null>`(
        select r.display_name from users as r where r.id = feedback.reviewed_by
      )`.as("reviewer"),
      "feedback.reviewed_at",
      "feedback.review_note",
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof feedbackQuery>["executeTakeFirstOrThrow"]>>;

function toFeedback(row: Row) {
  return {
    id: row.id,
    program: {
      id: row.program_id,
      name: row.program_name,
      school: row.school,
      college: row.college,
    },
    kind: row.kind,
    field: row.field,
    old_value: row.old_value,
    proposed_value: row.proposed_value,
    reason: row.reason,
    basis: row.basis,
    status: row.status,
    via: row.via,
    user: { id: row.user_id, display_name: row.display_name },
    created_at: unix(row.created_at),
    review:
      row.reviewed_at && row.reviewer
        ? { by: row.reviewer, at: unix(row.reviewed_at), note: row.review_note }
        : null,
  };
}

// A program's feedback still waiting, so no one gives the same again (design §12.1).
export async function listProgramFeedback(programId: number) {
  const rows = await feedbackQuery()
    .where("feedback.program_id", "=", programId)
    .where("programs.deleted_at", "is", null)
    .where("feedback.status", "=", "pending")
    .orderBy("feedback.id")
    .execute();
  return { feedback: rows.map(toFeedback) };
}

export async function getFeedback(id: number) {
  const row = await feedbackQuery().where("feedback.id", "=", id).executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "反馈不存在");
  return toFeedback(row);
}

export async function listMyFeedback(userId: number, paging: { page: number; per_page: number }) {
  const page = await pageOf(
    feedbackQuery().where("feedback.user_id", "=", userId).orderBy("feedback.id", "desc"),
    paging,
  );
  return { ...page, items: page.items.map(toFeedback) };
}

// What a part of the program is now, for the review page to set beside what it was.
const currentValue = sql<StoredValue | null>`case feedback.field
  when 'name' then to_jsonb(programs.name)
  when 'cohort' then to_jsonb(programs.cohort)
  when 'kind' then to_jsonb(programs.kind)
  else program_fields.value
end`;

// The review page's: those still waiting, the earliest first, with what the part is now and
// where that came from (design §12.2).
export async function listFeedbackQueue(paging: { page: number; per_page: number }) {
  const page = await pageOf(
    feedbackQuery()
      .leftJoin("program_fields", (join) =>
        join
          .onRef("program_fields.program_id", "=", "feedback.program_id")
          .onRef("program_fields.key", "=", "feedback.field"),
      )
      .select([
        currentValue.as("current_value"),
        sql<number | null>`(
          select number from program_versions where id = program_fields.version_id
        )`.as("current_version"),
      ])
      .where("feedback.status", "=", "pending")
      .where("programs.deleted_at", "is", null)
      .orderBy("feedback.created_at")
      .orderBy("feedback.id"),
    paging,
  );
  return {
    ...page,
    items: page.items.map((row) => ({
      ...toFeedback(row),
      current_value: row.current_value,
      current_version: row.current_version,
      // Whether the part changed since; for the whole program, there is nothing to compare.
      changed: row.field !== null && !isDeepStrictEqual(row.old_value, row.current_value),
    })),
  };
}

function notWaiting() {
  return new AppError(404, "not_found", "没有这条待处理的反馈");
}

// One still waiting that its reviewer didn't give, and its program. The program is locked before
// the feedback, the order giving it, reviewing a dispute and merging programs take.
async function pending(trx: Transaction<DB>, reviewer: Actor, id: number) {
  const found = await trx
    .selectFrom("feedback")
    .select("program_id")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!found) throw notWaiting();
  const program = await lockProgram(trx, found.program_id);
  const row = await trx
    .selectFrom("feedback")
    .select([
      "id",
      "program_id",
      "user_id",
      sql<"problem" | "edit">`kind`.as("kind"),
      "field",
      sql<StoredValue | null>`proposed_value`.as("proposed_value"),
      "reason",
      "basis",
    ])
    .where("id", "=", id)
    // Unless a merge moved it before the lock.
    .where("program_id", "=", found.program_id)
    .where("status", "=", "pending")
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notWaiting();
  if (row.user_id === reviewer.user_id) {
    throw new AppError(403, "own_feedback", "不能处理自己提的反馈");
  }
  return { ...row, program };
}

// An edit request goes on as asked, as an edit of the reviewer's that links to it; a problem was
// corrected on the program's page (design §12.2). Either way, its giver hears.
export async function acceptFeedback(reviewer: Actor, id: number) {
  await db.transaction().execute(async (trx) => {
    // Before the program's lock, as a direct edit takes it.
    await holdEditing(trx, reviewer.user_id);
    const item = await pending(trx, reviewer, id);
    // The table's CHECK keeps an edit request's field and basis; this only tells TypeScript.
    if (item.kind === "edit" && item.field !== null && item.basis !== null) {
      const current = await currentFields(trx, item.program_id);
      // Typed again from the JSON it is kept as.
      const columns = isColumn(item.field)
        ? changedColumns(item.program, ProgramColumns.parse({ [item.field]: item.proposed_value }))
        : {};
      const changes = isColumn(item.field)
        ? []
        : changedFields(current, [{ key: item.field, value: item.proposed_value }]);
      // Nothing to write when someone changed it to that since.
      await writeEdit(
        trx,
        reviewer,
        { id: item.program_id, ...item.program },
        current,
        columns,
        changes,
        {
          reason: item.reason,
          basis: item.basis,
          feedback_id: id,
        },
      );
    }
    await closeFeedback(trx, reviewer, [id], "accepted", null);
  });
}

export async function rejectFeedback(reviewer: Actor, id: number, note: string) {
  await db.transaction().execute(async (trx) => {
    await pending(trx, reviewer, id);
    await closeFeedback(trx, reviewer, [id], "rejected", note);
  });
}

const RESULTS = {
  edit: { noun: "修改申请", accepted: "已通过", rejected: "未通过" },
  problem: { noun: "反馈", accepted: "已改正", rejected: "已处理" },
};

// Decided, those still waiting, and those who gave them hear how (design §11.1).
async function closeFeedback(
  trx: Transaction<DB>,
  reviewer: Actor,
  ids: number[],
  status: "accepted" | "rejected",
  note: string | null,
) {
  if (ids.length === 0) return;
  const closed = await trx
    .updateTable("feedback")
    .set({ status, reviewed_by: reviewer.user_id, reviewed_at: new Date(), review_note: note })
    .from("programs")
    .whereRef("programs.id", "=", "feedback.program_id")
    .where("feedback.id", "in", ids)
    // Withdrawn or decided meanwhile, it stays so.
    .where("feedback.status", "=", "pending")
    .returning([
      "feedback.user_id",
      sql<"problem" | "edit">`feedback.kind`.as("kind"),
      "programs.name",
    ])
    .execute();
  await sendMessages(
    trx,
    "feedback_result",
    closed.map((f) => ({
      user_id: f.user_id,
      title: `你对「${f.name}」的${RESULTS[f.kind].noun}${RESULTS[f.kind][status]}`,
      body: note ?? "",
      link: "/me/feedback",
    })),
  );
}

// A deleted program's feedback waiting has nothing left to decide; a merged one's goes to the
// program kept, and where one person waits on the same part of both, the later stands and the
// earlier counts as withdrawn (design §12.1).
export async function feedbackGone(
  trx: Transaction<DB>,
  reviewer: Actor,
  id: number,
  keptId: number | null,
) {
  if (keptId === null) {
    const waiting = await trx
      .selectFrom("feedback")
      .select("id")
      .where("program_id", "=", id)
      .where("status", "=", "pending")
      .execute();
    await closeFeedback(
      trx,
      reviewer,
      waiting.map((f) => f.id),
      "rejected",
      "项目已删除",
    );
    return;
  }
  await sql`
    update feedback as earlier set status = 'withdrawn'
    from feedback as later
    where earlier.program_id in (${id}, ${keptId}) and later.program_id in (${id}, ${keptId})
      and earlier.program_id <> later.program_id
      and earlier.user_id = later.user_id and earlier.field is not distinct from later.field
      and earlier.status = 'pending' and later.status = 'pending'
      and (earlier.created_at, earlier.id) < (later.created_at, later.id)
  `.execute(trx);
  await trx
    .updateTable("feedback")
    .set({ program_id: keptId })
    .where("program_id", "=", id)
    .execute();
  await openDispute(trx, keptId);
}

// The disputed programs, for an admin, with all the feedback since their last review, each as it
// stands now: what was withdrawn since still shows why it was disputed (design §12.3).
export async function listDisputes() {
  const open = await db
    .selectFrom("disputes")
    .innerJoin("programs", "programs.id", "disputes.program_id")
    .innerJoin("colleges", "colleges.id", "programs.college_id")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "disputes.id",
      "programs.id as program_id",
      "programs.name",
      "schools.name as school",
      "colleges.name as college",
      "disputes.opened_at",
    ])
    .where("disputes.resolved_at", "is", null)
    .where("programs.deleted_at", "is", null)
    .orderBy("disputes.opened_at")
    .execute();
  if (open.length === 0) return { disputes: [] };
  const rows = await feedbackQuery()
    .where(
      "feedback.program_id",
      "in",
      open.map((d) => d.program_id),
    )
    .where("feedback.created_at", ">", sinceReview("feedback.program_id"))
    .orderBy("feedback.id")
    .execute();
  const feedback = Map.groupBy(rows.map(toFeedback), (f) => f.program.id);
  return {
    disputes: open.map(({ id, program_id, opened_at, ...program }) => ({
      id,
      program: { id: program_id, ...program },
      opened_at: unix(opened_at),
      feedback: feedback.get(program_id) ?? [],
    })),
  };
}

// An admin's review of a dispute (design §12.3): corrected or confirmed, which the feedback
// waiting closes as, with the note as its result. Feedback counts afresh after it.
export async function resolveDispute(
  admin: Actor,
  id: number,
  { result, note }: { result: "corrected" | "confirmed"; note: string },
) {
  await db.transaction().execute(async (trx) => {
    const found = await trx
      .selectFrom("disputes")
      .select("program_id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!found) throw new AppError(404, "not_found", "没有这条争议");
    const programId = found.program_id;
    await lockProgram(trx, programId);
    const resolved = await trx
      .updateTable("disputes")
      // The database's clock, as feedback given after it is timed by.
      .set({ resolved_by: admin.user_id, resolved_at: sql<Date>`clock_timestamp()`, result, note })
      .where("id", "=", id)
      .where("resolved_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!resolved) throw new AppError(409, "already_resolved", "这条争议已经复核过了");
    const waiting = await trx
      .selectFrom("feedback")
      .select("id")
      .where("program_id", "=", programId)
      .where("status", "=", "pending")
      .execute();
    await closeFeedback(
      trx,
      admin,
      waiting.map((f) => f.id),
      result === "corrected" ? "accepted" : "rejected",
      note,
    );
  });
}
