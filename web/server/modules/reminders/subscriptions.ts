import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import type { TimeValue } from "../programs/schemas.ts";
import { applyOf, inDeadlineOrder, originalNotice, programCards } from "../programs/service.ts";
import { beijingDay, beijingYear, deadlineDay, formatTime } from "../programs/time.ts";
import { sendMessages, type Message } from "./messages.ts";

// Subscriptions and deadline reminders (design §11.3). Programs don't tell this module what
// changed: each minute it compares every program's deadline with the one its subscribers last
// heard of.

// How many programs a member subscribes to at once, closed ones too. The same for everyone now,
// but it may come to depend on the member, so it is worked out here only and pages take it from
// the API.
const SUBSCRIPTION_LIMIT = 10;

// The program's apply end as the notice wrote it, null without one.
const deadlineValue = sql<TimeValue | null>`(${applyOf("p.id")} -> 'end')`;

export async function subscribe(userId: number, programId: number) {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    // One at a time for a member, or two at once could both take the last place.
    await trx.selectFrom("users").select("id").where("id", "=", userId).forNoKeyUpdate().execute();
    // Locked so it can't be deleted or merged meanwhile, after its subscriptions were dealt with.
    const program = await trx
      .selectFrom("programs as p")
      .select(["p.apply_deadline", deadlineValue.as("end")])
      .where("p.id", "=", programId)
      .where("p.deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!program) throw new AppError(404, "not_found", "项目不存在");
    const mine = await trx
      .selectFrom("subscriptions")
      .select("program_id")
      .where("user_id", "=", userId)
      .execute();
    if (mine.some((s) => s.program_id === programId)) return;
    if (mine.length >= SUBSCRIPTION_LIMIT) {
      throw new AppError(409, "subscription_limit", `最多同时订阅 ${SUBSCRIPTION_LIMIT} 个项目`);
    }
    await trx
      .insertInto("subscriptions")
      .values({
        user_id: userId,
        program_id: programId,
        deadline: program.apply_deadline,
        deadline_value: program.end && JSON.stringify(program.end),
        // Closed already: nothing to remind of.
        remind_at:
          program.end && program.apply_deadline !== null && program.apply_deadline > now
            ? remindAt(program.end)
            : null,
      })
      .execute();
    // Past the time to remind of it and not closed yet: reminded now.
    await remind(trx, now, { user_id: userId, program_id: programId });
  });
}

export async function unsubscribe(userId: number, programId: number) {
  await db
    .deleteFrom("subscriptions")
    .where("user_id", "=", userId)
    .where("program_id", "=", programId)
    .execute();
}

// One's subscriptions as the table shows programs: the open ones by deadline first.
export async function listSubscriptions(userId: number) {
  const mine = await db
    .selectFrom("subscriptions")
    .select("program_id")
    .where("user_id", "=", userId)
    .execute();
  const programs = await programCards(mine.map((s) => s.program_id));
  return { limit: SUBSCRIPTION_LIMIT, programs: inDeadlineOrder(programs, (p) => p) };
}

export async function clearClosed(userId: number) {
  const now = unix(new Date());
  const closed = (await listSubscriptions(userId)).programs.filter((p) => p.closes_at <= now);
  if (closed.length === 0) return;
  await db
    .deleteFrom("subscriptions")
    .where("user_id", "=", userId)
    .where(
      "program_id",
      "in",
      closed.map((p) => p.id),
    )
    .execute();
}

// A program deleted, or merged into `keptId` (design §12.2), in the transaction that does it: its
// subscriptions go, or move to the one kept, where one subscribed to both keeps theirs. A moved
// one keeps the deadline its member heard of, so a different one on the kept program is news.
export async function programGone(trx: Transaction<DB>, id: number, keptId: number | null) {
  if (keptId !== null) {
    await trx
      .insertInto("subscriptions")
      .columns(["user_id", "program_id", "deadline", "deadline_value", "remind_at", "created_at"])
      .expression((eb) =>
        eb
          .selectFrom("subscriptions")
          .select([
            "user_id",
            eb.val(keptId).as("program_id"),
            "deadline",
            "deadline_value",
            "remind_at",
            "created_at",
          ])
          .where("program_id", "=", id),
      )
      .onConflict((oc) => oc.columns(["user_id", "program_id"]).doNothing())
      .execute();
  }
  await trx.deleteFrom("subscriptions").where("program_id", "=", id).execute();
}

const DISPUTED = "；有争议，请以原文为准";

// Each minute: deadlines changed since their subscribers heard of them, then the reminders due.
export async function sendDeadlineMessages() {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    await tellChanges(trx, now);
    await remind(trx, now);
  });
}

// Subscriptions, locked, with what messages about their programs say.
function subscriptionsWithPrograms(trx: Transaction<DB>) {
  return trx
    .selectFrom("subscriptions as s")
    .innerJoin("programs as p", "p.id", "s.program_id")
    .innerJoin("colleges as c", "c.id", "p.college_id")
    .innerJoin("schools as sc", "sc.id", "c.school_id")
    .innerJoinLateral(originalNotice, (join) => join.onTrue())
    .select([
      "s.user_id",
      "s.program_id",
      sql<string>`sc.name || ' ' || c.name || '「' || p.name || '」'`.as("program"),
      "notice.url as notice_url",
      sql<string | null>`(
        select value #>> '{}' from program_fields
        where program_id = p.id and key = 'apply_url' and value <> 'null'
      )`.as("apply_url"),
      sql<boolean>`exists(
        select from program_fields
        where program_id = p.id and key = 'apply:rolling' and value = 'true'
      )`.as("rolling"),
      // Reminders still go: the deadline may be right, and missing it costs more (design §12.3).
      sql<boolean>`exists(
        select from disputes where program_id = p.id and resolved_at is null
      )`.as("disputed"),
    ])
    .forUpdate("s");
}

// The deadlines that moved: 「截止变了」 to each subscriber, with the new deadline and how long is
// left if it is past the time to remind of it, which then counts as the reminder. Written another
// way for the same moment isn't news (design §11.3); only how it reads changes.
async function tellChanges(trx: Transaction<DB>, now: Date) {
  const changed = await subscriptionsWithPrograms(trx)
    // The notice whose version gave the deadline; none when a person set or cleared it.
    .leftJoin("program_fields as f", (join) =>
      join.onRef("f.program_id", "=", "p.id").on("f.key", "=", "apply:end"),
    )
    .leftJoin("program_versions as v", "v.id", "f.version_id")
    .leftJoin("snapshots as sn", "sn.id", "v.snapshot_id")
    .leftJoin("notices as n", "n.id", "sn.notice_id")
    .select([
      "s.deadline",
      "s.remind_at",
      sql<TimeValue | null>`s.deadline_value`.as("was"),
      "p.apply_deadline",
      deadlineValue.as("end"),
      "n.title as by_notice",
    ])
    .where(
      sql<boolean>`s.deadline is distinct from p.apply_deadline
        or s.deadline_value is distinct from ${deadlineValue}`,
    )
    .execute();
  const year = beijingYear(now);
  const messages: Message[] = [];
  for (const row of changed) {
    const at = row.end && remindAt(row.end);
    const moved = row.deadline?.getTime() !== row.apply_deadline?.getTime();
    const due =
      moved && at !== null && at <= now && row.apply_deadline !== null && row.apply_deadline > now;
    await trx
      .updateTable("subscriptions")
      .set({
        deadline: row.apply_deadline,
        deadline_value: row.end && JSON.stringify(row.end),
        // A new deadline is reminded of at its own time, or in this message once that has passed;
        // one only written another way stays reminded of or not.
        remind_at: moved ? (at && at > now ? at : null) : row.remind_at && at,
      })
      .where("user_id", "=", row.user_id)
      .where("program_id", "=", row.program_id)
      .execute();
    if (!moved) continue;
    const after = row.end
      ? `改为 ${formatTime(row.end, year)}${due ? `（${left(row.end, now)}）` : ""}`
      : "已清空";
    const before = row.was ? `原为 ${formatTime(row.was, year)}` : "原来未注明";
    const by = row.by_notice ? `依据通知「${row.by_notice}」` : "人工修改";
    messages.push({
      user_id: row.user_id,
      title: `${row.program}报名截止变了`,
      body: `${after}，${before}；${by}${due && row.rolling ? "；额满即止，尽早报名" : ""}${row.disputed ? DISPUTED : ""}`,
      link: `/programs/${row.program_id}`,
    });
  }
  await sendMessages(trx, "deadline_changed", messages);
}

// 「快截止了」 for the reminders due by `now` of deadlines still ahead, each once; `only` for a
// subscription just made.
async function remind(
  trx: Transaction<DB>,
  now: Date,
  only?: { user_id: number; program_id: number },
) {
  let query = subscriptionsWithPrograms(trx)
    .select(sql<TimeValue>`s.deadline_value`.as("deadline"))
    .where("s.remind_at", "<=", now)
    .where("s.deadline", ">", now)
    // As the program has it: one changed since tellChanges looked is told of next minute.
    .whereRef("s.deadline", "=", "p.apply_deadline");
  if (only) {
    query = query.where("s.user_id", "=", only.user_id).where("s.program_id", "=", only.program_id);
  }
  const due = await query.execute();
  if (due.length === 0) return;
  await trx
    .updateTable("subscriptions")
    .set({ remind_at: null })
    .where((eb) => eb.or(due.map((s) => eb.and({ user_id: s.user_id, program_id: s.program_id }))))
    .execute();
  await sendMessages(
    trx,
    "deadline_soon",
    due.map((s) => ({
      user_id: s.user_id,
      title: `${s.program}快截止了`,
      body: `${formatTime(s.deadline, beijingYear(now))} 截止，${left(s.deadline, now)}${s.rolling ? "，额满即止，尽早报名" : ""}${s.disputed ? DISPUTED : ""}`,
      link: `/programs/${s.program_id}`,
      links: [
        { label: "通知原文", url: s.notice_url },
        ...(s.apply_url ? [{ label: "报名入口", url: s.apply_url }] : []),
      ],
    })),
  );
}

// The day the deadline falls on, three days before, at 9 in the morning Beijing time.
function remindAt(value: TimeValue) {
  const [year, month, day] = deadlineDay(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 3, 9 - 8));
}

// How long until the day the deadline falls on, counted in days in Beijing.
function left(value: TimeValue, now: Date) {
  const today = beijingDay(now);
  const days = (Date.parse(deadlineDay(value)) - Date.parse(today)) / 86_400_000;
  return days === 0 ? "就在今天" : `还剩 ${days} 天`;
}
