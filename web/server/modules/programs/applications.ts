import type { z } from "@hono/zod-openapi";
import { sql } from "kysely";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { STAGES, type ApplicationInput, type Stage } from "./schemas.ts";
import { inDeadlineOrder, programCards } from "./service.ts";

// 我的报名 (design §9.4): one's own record of how far applying to a program went, seen by no one
// else and counted nowhere. A deleted program's record stays, unseen; a merge moves it along
// (deleteProgram).

export async function setApplication(
  userId: number,
  programId: number,
  { stage, note }: z.infer<typeof ApplicationInput>,
) {
  await db.transaction().execute(async (trx) => {
    // Locked so it can't be merged meanwhile, after its records were moved.
    const program = await trx
      .selectFrom("programs")
      .select("id")
      .where("id", "=", programId)
      .where("deleted_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!program) throw new AppError(404, "not_found", "项目不存在");
    await trx
      .insertInto("applications")
      .values({ user_id: userId, program_id: programId, stage, note, updated_at: new Date() })
      .onConflict((oc) =>
        oc.columns(["user_id", "program_id"]).doUpdateSet({ stage, note, updated_at: new Date() }),
      )
      .execute();
  });
}

export async function clearApplication(userId: number, programId: number) {
  await db
    .deleteFrom("applications")
    .where("user_id", "=", userId)
    .where("program_id", "=", programId)
    .execute();
}

// One's records, those at `stage` if given, the open programs by deadline first; and how many
// there are at each stage, whatever the filter.
export async function listApplications(userId: number, stage?: Stage) {
  const rows = await db
    .selectFrom("applications")
    .select(["program_id", sql<Stage>`stage`.as("stage"), "note", "updated_at"])
    .where("user_id", "=", userId)
    .execute();
  // Deleted programs have no card, and their records go unseen.
  const cards = new Map((await programCards(rows.map((r) => r.program_id))).map((p) => [p.id, p]));
  const seen = rows.flatMap((row) => {
    const program = cards.get(row.program_id);
    return program
      ? [{ program, stage: row.stage, note: row.note, updated_at: unix(row.updated_at) }]
      : [];
  });
  return {
    counts: STAGES.map((s) => ({ stage: s, count: seen.filter((a) => a.stage === s).length })),
    applications: inDeadlineOrder(
      stage ? seen.filter((a) => a.stage === stage) : seen,
      (a) => a.program,
    ),
  };
}
