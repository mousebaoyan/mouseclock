import { sql } from "kysely";
import type { Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { logoOf } from "../programs/service.ts";
import { follow, unfollow } from "../reminders/follows.ts";
import { crawled, dropUnwanted } from "./inclusion-requests.ts";
import type { RequestStatus } from "./schemas.ts";

// 关注学院 (design §11.4) as a college's page and 院校清单 see it. The follows are reminders',
// which tells followers of new notices; following a college not crawled yet also asks for it
// (design §10.1): someone who follows counts as voting, unless muted.

export async function followCollege(viewer: Viewer, collegeId: number) {
  await db.transaction().execute(async (trx) => {
    const college = await trx
      .selectFrom("colleges")
      .select("id")
      .where("id", "=", collegeId)
      .executeTakeFirst();
    if (!college) throw new AppError(404, "not_found", "学院不存在");
    await follow(trx, viewer.id, collegeId);
    // The muted follow, but may not ask.
    if (viewer.muted) return;
    // Locked, so the last vote withdrawn meanwhile can't drop the ask without seeing this follow.
    const asked = await trx
      .selectFrom("inclusion_requests")
      .select("id")
      .where("college_id", "=", collegeId)
      .forUpdate()
      .executeTakeFirst();
    if (asked || (await crawled(trx, collegeId))) return;
    // No one asked yet: this one does.
    await trx
      .insertInto("inclusion_requests")
      .values({ college_id: collegeId, user_id: viewer.id, note: "" })
      .onConflict((oc) => oc.column("college_id").doNothing())
      .execute();
  });
}

export async function unfollowCollege(userId: number, collegeId: number) {
  await db.transaction().execute(async (trx) => {
    await unfollow(trx, userId, collegeId);
    const request = await trx
      .selectFrom("inclusion_requests")
      .select("id")
      .where("college_id", "=", collegeId)
      .forUpdate()
      .executeTakeFirst();
    if (request) await dropUnwanted(trx, request.id);
  });
}

// One's colleges by school, each with how many programs of `cohort` it has and when its latest
// notice was; one not crawled yet with how far asking for it went.
export async function listFollows(userId: number, cohort: number) {
  const rows = await db
    .selectFrom("follows")
    .innerJoin("colleges", "colleges.id", "follows.college_id")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .leftJoin("inclusion_requests", "inclusion_requests.college_id", "colleges.id")
    .select((eb) => [
      "colleges.id",
      "colleges.name",
      "schools.id as school_id",
      "schools.name as school_name",
      logoOf("schools.id").as("school_logo"),
      eb
        .selectFrom("programs")
        .select((p) => p.fn.countAll<number>().as("count"))
        .whereRef("programs.college_id", "=", "colleges.id")
        .where("programs.cohort", "=", cohort)
        .where("programs.deleted_at", "is", null)
        .as("programs"),
      eb
        .selectFrom("programs")
        .innerJoin("program_versions", "program_versions.program_id", "programs.id")
        .innerJoin("snapshots", "snapshots.id", "program_versions.snapshot_id")
        .innerJoin("notices", "notices.id", "snapshots.notice_id")
        .select(
          sql<string>`max(coalesce(
            notices.published_on, (notices.first_seen_at at time zone 'Asia/Shanghai')::date
          ))::text`.as("on"),
        )
        .whereRef("programs.college_id", "=", "colleges.id")
        .where("programs.deleted_at", "is", null)
        .as("latest_notice"),
      sql<boolean>`exists (
        select from sources
        where sources.college_id = colleges.id and sources.unavailable_reason is null
      )`.as("crawled"),
      sql<{ id: number; status: RequestStatus } | null>`case
        when inclusion_requests.id is not null
        then json_build_object('id', inclusion_requests.id, 'status', inclusion_requests.status)
      end`.as("request"),
    ])
    .where("follows.user_id", "=", userId)
    .orderBy("schools.name")
    .orderBy("colleges.name")
    .execute();
  return rows.map((row) => ({
    college: { id: row.id, name: row.name },
    school: { id: row.school_id, name: row.school_name, logo: row.school_logo },
    programs: row.programs ?? 0,
    latest_notice: row.latest_notice,
    crawled: row.crawled,
    request: row.crawled ? null : row.request,
  }));
}
