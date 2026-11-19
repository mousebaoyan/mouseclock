import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Role } from "../programs/schemas.ts";
import { sendMessages } from "./messages.ts";

// 关注学院 (design §11.4): a college's followers hear of its new notices. Following one goes
// through sources/follows.ts, which also counts it as asking for a college not crawled yet.

export async function follow(trx: Transaction<DB>, userId: number, collegeId: number) {
  await trx
    .insertInto("follows")
    .values({ user_id: userId, college_id: collegeId })
    .onConflict((oc) => oc.columns(["user_id", "college_id"]).doNothing())
    .execute();
}

export async function unfollow(trx: Transaction<DB>, userId: number, collegeId: number) {
  await trx
    .deleteFrom("follows")
    .where("user_id", "=", userId)
    .where("college_id", "=", collegeId)
    .execute();
}

const ROLE_WORDS: Record<Role, string> = { call: "报名", update: "补充", result: "名单" };

// What a source brought that its colleges' followers haven't heard of: each notice with programs
// in it, once for each of their colleges, after a round (ingest's recordRun), or the one notice a
// held program of was just accepted from. One a round failed to screen or extract is told of when
// a later one does. Not those a source's first round read reaches back for, mostly past years',
// nor one seen first under another source: a college and its graduate school often post the same.
export async function announceNews(
  trx: Transaction<DB>,
  of: { source_id: number } | { notice_id: number },
) {
  const found = await trx
    .selectFrom("notices")
    .innerJoin("snapshots", "snapshots.notice_id", "notices.id")
    .innerJoin("program_versions", "program_versions.snapshot_id", "snapshots.id")
    .innerJoin("programs", "programs.id", "program_versions.program_id")
    .select([
      "notices.id as notice_id",
      "notices.title",
      "programs.id as program_id",
      "programs.college_id",
      sql<Role>`program_versions.role`.as("role"),
    ])
    .where((eb) =>
      "source_id" in of
        ? eb("notices.source_id", "=", of.source_id)
        : eb("notices.id", "=", of.notice_id),
    )
    .where("programs.deleted_at", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("announced_notices")
            .select("announced_notices.notice_id")
            .whereRef("announced_notices.notice_id", "=", "notices.id")
            .whereRef("announced_notices.college_id", "=", "programs.college_id"),
        ),
      ),
    )
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("crawl_runs")
          .select("crawl_runs.id")
          .whereRef("crawl_runs.source_id", "=", "notices.source_id")
          .where("crawl_runs.failure", "is", null)
          // The crawler gives whole seconds: one seen in a round's last one is that round's.
          .where(
            sql<boolean>`crawl_runs.finished_at < date_trunc('second', notices.first_seen_at)`,
          ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("notices as seen")
            .select("seen.id")
            .whereRef("seen.url", "=", "notices.url")
            .whereRef("seen.first_seen_at", "<", "notices.first_seen_at"),
        ),
      ),
    )
    .orderBy("notices.id")
    .orderBy("program_versions.id")
    .execute();
  if (found.length === 0) return;
  // Each (notice, college) once here, and once only though two transactions find it.
  const told = await trx
    .insertInto("announced_notices")
    .values(found.map((f) => ({ notice_id: f.notice_id, college_id: f.college_id })))
    .onConflict((oc) => oc.doNothing())
    .returning(["notice_id", "college_id"])
    .execute();
  const colleges = [...new Set(told.map((t) => t.college_id))];
  if (colleges.length === 0) return;
  const [names, followers] = await Promise.all([
    trx
      .selectFrom("colleges")
      .innerJoin("schools", "schools.id", "colleges.school_id")
      .select(["colleges.id", "colleges.name", "schools.name as school_name"])
      .where("colleges.id", "in", colleges)
      .execute(),
    trx
      .selectFrom("follows")
      .select(["user_id", "college_id"])
      .where("college_id", "in", colleges)
      .execute(),
  ]);
  await sendMessages(
    trx,
    "college_news",
    names.flatMap((college) => {
      const notices = told
        .filter((t) => t.college_id === college.id)
        .map((t) => {
          const versions = found.filter(
            (f) => f.notice_id === t.notice_id && f.college_id === college.id,
          );
          const roles = [...new Set(versions.map((v) => ROLE_WORDS[v.role]))];
          return { title: versions[0].title, roles, program: versions[0].program_id };
        });
      const message = {
        title: `${college.school_name} ${college.name}发了 ${notices.length} 条新通知`,
        body: notices.map((n) => `「${n.title}」（${n.roles.join("、")}）`).join("；"),
        // One goes to its program; more to the college.
        link:
          notices.length === 1
            ? (`/programs/${notices[0].program}` as const)
            : (`/colleges/${college.id}` as const),
      };
      return followers
        .filter((f) => f.college_id === college.id)
        .map((f) => ({ user_id: f.user_id, ...message }));
    }),
  );
}
