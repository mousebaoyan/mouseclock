import { sql, type Kysely, type Transaction } from "kysely";
import { DatabaseError } from "pg";
import type { z } from "zod";
import type { DB } from "../../../db/types.ts";
import type { Viewer } from "../../platform/access.ts";
import { recordAudit } from "../../platform/audit.ts";
import { db, pageOf } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { mutedNow } from "../accounts/service.ts";
import { sendMessages } from "../reminders/messages.ts";
import {
  REQUEST_STATUSES,
  type InclusionRequestInput,
  type InclusionRequestPatch,
  type RequestQuery,
  type RequestStatus,
} from "./schemas.ts";

// 求收录 (design §10.1): members ask for colleges to be crawled and vote for others' asks; admins
// move them along. A college is included once it has a source that is crawled.

type Actor = { user_id: number; via: "web" };

// Each ask with its school's and college's names: from the list once matched, or as asked.
function named(executor: Kysely<DB>) {
  return executor
    .selectFrom("inclusion_requests")
    .leftJoin("colleges", "colleges.id", "inclusion_requests.college_id")
    .leftJoin("schools", (join) =>
      join.on(
        "schools.id",
        "=",
        sql<number>`coalesce(colleges.school_id, inclusion_requests.school_id)`,
      ),
    )
    .select([
      "inclusion_requests.id",
      "inclusion_requests.college_id",
      "schools.id as school_id",
      // One or the other is there (the table's checks).
      sql<string>`coalesce(schools.name, inclusion_requests.school_name)`.as("school_name"),
      sql<string>`coalesce(colleges.name, inclusion_requests.college_name)`.as("college_name"),
      sql<RequestStatus>`inclusion_requests.status`.as("status"),
      "inclusion_requests.reason",
    ]);
}

// One column of the list; queued ones by votes, the most first, then the earliest asked.
export async function listRequests(
  viewer: Viewer,
  { status, ...paging }: z.infer<typeof RequestQuery>,
) {
  let query = named(db)
    .select([
      "inclusion_requests.url_hint",
      "inclusion_requests.note",
      "inclusion_requests.created_at",
      // Following the college counts as a vote (design §10.1), each person once.
      sql<number>`(
        select count(*) from (
          select user_id from inclusion_votes where request_id = inclusion_requests.id
          union
          select follows.user_id from follows join users on users.id = follows.user_id
          where follows.college_id = inclusion_requests.college_id and not ${mutedNow}
        ) as voters
      )`.as("votes"),
      sql<boolean>`exists (
        select from inclusion_votes as v
        where v.request_id = inclusion_requests.id and v.user_id = ${viewer.id}
      )`.as("voted"),
      sql<boolean>`exists (
        select from follows as f
        where f.college_id = inclusion_requests.college_id and f.user_id = ${viewer.id}
      )`.as("following"),
    ])
    .where("inclusion_requests.status", "=", status);
  query =
    status === "queued"
      ? query.orderBy("votes", "desc").orderBy("inclusion_requests.created_at")
      : status === "onboarding"
        ? query.orderBy("inclusion_requests.created_at")
        : query.orderBy("inclusion_requests.resolved_at", "desc");
  const [page, counted] = await Promise.all([
    pageOf(query.orderBy("inclusion_requests.id"), paging),
    db
      .selectFrom("inclusion_requests")
      .select(["status", (eb) => eb.fn.countAll<number>().as("count")])
      .groupBy("status")
      .execute(),
  ]);
  return {
    ...page,
    items: page.items.map((row) => ({
      id: row.id,
      school: { id: row.school_id, name: row.school_name },
      college: { id: row.college_id, name: row.college_name },
      url_hint: row.url_hint,
      note: row.note,
      status: row.status,
      reason: row.reason,
      votes: row.votes,
      mine: row.voted || (row.following && !viewer.muted),
      following: row.following,
      created_at: unix(row.created_at),
    })),
    counts: REQUEST_STATUSES.map((s) => ({
      status: s,
      count: counted.find((c) => c.status === s)?.count ?? 0,
    })),
  };
}

async function writeRequests<T>(operation: (trx: Transaction<DB>) => Promise<T>) {
  try {
    return await db.transaction().execute(operation);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23503") {
      throw new AppError(404, "not_found", "学校、学院或求收录不存在", error);
    }
    if (error instanceof DatabaseError && error.code === "23505") {
      throw new AppError(409, "duplicate", "这个学院已经有人提过了，把这条并进那一条", error);
    }
    throw error;
  }
}

export function crawled(executor: Kysely<DB>, collegeId: number) {
  return executor
    .selectFrom("sources")
    .select("id")
    .where("college_id", "=", collegeId)
    .where("unavailable_reason", "is", null)
    .executeTakeFirst();
}

// Asking for a college someone already asked for counts as a vote for theirs.
export async function askForCollege(userId: number, input: z.infer<typeof InclusionRequestInput>) {
  const { url_hint, note, ...college } = input;
  return writeRequests(async (trx) => {
    if ("college_id" in college && (await crawled(trx, college.college_id))) {
      throw new AppError(409, "already_included", "这个学院已经收录了");
    }
    const created = await trx
      .insertInto("inclusion_requests")
      .values({ ...college, url_hint, note, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    let id = created?.id;
    if (id === undefined) {
      const asked = await trx
        .selectFrom("inclusion_requests")
        .select(["id", "status"])
        .where((eb) =>
          eb.and(Object.entries(college).map(([column, value]) => eb(sql.ref(column), "=", value))),
        )
        .executeTakeFirstOrThrow();
      if (asked.status === "included") {
        throw new AppError(409, "already_included", "这个学院已经收录了");
      }
      id = asked.id;
    }
    await vote(trx, userId, id);
    return { id, created: created !== undefined };
  });
}

async function vote(trx: Transaction<DB>, userId: number, requestId: number) {
  await trx
    .insertInto("inclusion_votes")
    .values({ request_id: requestId, user_id: userId })
    .onConflict((oc) => oc.columns(["request_id", "user_id"]).doNothing())
    .execute();
}

export async function voteFor(userId: number, requestId: number) {
  await writeRequests(async (trx) => {
    const request = await trx
      .selectFrom("inclusion_requests")
      .select("status")
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (!request) throw new AppError(404, "not_found", "求收录不存在");
    if (request.status === "included") {
      throw new AppError(409, "already_included", "这个学院已经收录了");
    }
    await vote(trx, userId, requestId);
  });
}

export async function withdrawVote(userId: number, requestId: number) {
  await db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom("inclusion_requests")
      .select("id")
      .where("id", "=", requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!request) return;
    await trx
      .deleteFrom("inclusion_votes")
      .where("request_id", "=", requestId)
      .where("user_id", "=", userId)
      .execute();
    await dropUnwanted(trx, requestId);
  });
}

// A queued ask no one votes for or follows the college of any more leaves the list; the others
// stay (design §10.1). The muted's follows don't count.
export async function dropUnwanted(trx: Transaction<DB>, requestId: number) {
  await trx
    .deleteFrom("inclusion_requests")
    .where("id", "=", requestId)
    .where("status", "=", "queued")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("inclusion_votes")
            .whereRef("request_id", "=", "inclusion_requests.id")
            .select("user_id"),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("follows")
            .innerJoin("users", "users.id", "follows.user_id")
            .whereRef("follows.college_id", "=", "inclusion_requests.college_id")
            .where(sql<boolean>`not ${mutedNow}`)
            .select("follows.user_id"),
        ),
      ),
    )
    .execute();
}

const COLUMNS = [
  "id",
  "college_id",
  "school_id",
  "school_name",
  "college_name",
  "status",
  "reason",
  "resolved_at",
] as const;

// How it ended, for those who asked.
function resolved(status: string) {
  return status === "included" || status === "unavailable";
}

export async function updateRequest(
  actor: Actor,
  id: number,
  patch: z.infer<typeof InclusionRequestPatch>,
) {
  await writeRequests(async (trx) => {
    const before = await trx
      .selectFrom("inclusion_requests")
      .select(COLUMNS)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, "not_found", "求收录不存在");
    if ("school_id" in patch && before.college_id !== null) {
      throw new AppError(409, "already_matched", "已经对上清单里的学院了");
    }
    if ("status" in patch && patch.status === "included" && before.college_id === null) {
      throw new AppError(409, "not_matched", "先对上清单里的学院才能算已收录");
    }
    const after = await trx
      .updateTable("inclusion_requests")
      .set(
        "status" in patch
          ? {
              status: patch.status,
              reason: "reason" in patch ? patch.reason : null,
              resolved_at: !resolved(patch.status)
                ? null
                : patch.status === before.status
                  ? before.resolved_at
                  : new Date(),
            }
          : "college_id" in patch
            ? {
                college_id: patch.college_id,
                school_id: null,
                school_name: null,
                college_name: null,
              }
            : { school_id: patch.school_id, school_name: null },
      )
      .where("id", "=", id)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "inclusion_request",
      target_id: id,
      detail: { via: actor.via, before, after },
    });
    // Back in the queue with no one wanting it any more.
    if (after.status === "queued") await dropUnwanted(trx, id);
    if (resolved(after.status) && after.status !== before.status) await tell(trx, [id]);
    // Matched to a college already crawled: that's what was asked for.
    if (after.college_id !== null && after.college_id !== before.college_id) {
      if (await crawled(trx, after.college_id)) await includeCollege(trx, after.college_id);
    }
  });
}

// Its votes go to the other one, each person still once.
export async function mergeRequest(actor: Actor, id: number, into: number) {
  if (id === into) throw new AppError(400, "invalid_request", "不能并进自己");
  await writeRequests(async (trx) => {
    const rows = await trx
      .selectFrom("inclusion_requests")
      .select(COLUMNS)
      .where("id", "in", [id, into])
      .orderBy("id")
      .forUpdate()
      .execute();
    const before = rows.find((r) => r.id === id);
    const target = rows.find((r) => r.id === into);
    if (!before || !target) throw new AppError(404, "not_found", "求收录不存在");
    // The college it is matched to is what its followers count by and what being crawled includes.
    if (before.college_id !== null && target.college_id === null) {
      throw new AppError(409, "merge_into_matched", "这条对上了学院，要把另一条并进这一条");
    }
    const moved = await trx
      .insertInto("inclusion_votes")
      .columns(["request_id", "user_id", "created_at"])
      .expression((eb) =>
        eb
          .selectFrom("inclusion_votes")
          .select([eb.val(into).as("request_id"), "user_id", "created_at"])
          .where("request_id", "=", id),
      )
      .onConflict((oc) => oc.columns(["request_id", "user_id"]).doNothing())
      .returning("user_id")
      .execute();
    await trx.deleteFrom("inclusion_requests").where("id", "=", id).execute();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "merge",
      target_type: "inclusion_request",
      target_id: id,
      detail: { via: actor.via, before, into, moved: moved.map((v) => v.user_id) },
    });
  });
}

// The college has a source crawled now (createSource, updateSource), or an ask was matched to one
// that has: what was asked for it is done.
export async function includeCollege(trx: Transaction<DB>, collegeId: number) {
  const included = await trx
    .updateTable("inclusion_requests")
    .set({ status: "included", reason: null, resolved_at: new Date() })
    .where("college_id", "=", collegeId)
    .where("status", "!=", "included")
    .returning("id")
    .execute();
  await tell(
    trx,
    included.map((r) => r.id),
  );
}

// Those who asked and voted hear how it ended.
async function tell(trx: Transaction<DB>, ids: number[]) {
  if (ids.length === 0) return;
  const rows = await named(trx).where("inclusion_requests.id", "in", ids).execute();
  // Those who voted and those following the college, each once.
  const voters = await trx
    .selectFrom("inclusion_votes")
    .select(["request_id", "user_id"])
    .where("request_id", "in", ids)
    .union((eb) =>
      eb
        .selectFrom("follows")
        .innerJoin("inclusion_requests", "inclusion_requests.college_id", "follows.college_id")
        .select(["inclusion_requests.id as request_id", "follows.user_id"])
        .where("inclusion_requests.id", "in", ids),
    )
    .execute();
  await sendMessages(
    trx,
    "inclusion_result",
    rows.flatMap((row) => {
      const name = `${row.school_name} ${row.college_name}`;
      const message =
        row.status === "included"
          ? {
              title: `${name}已收录`,
              body: "鼠钟开始抓它的通知了",
              link: `/colleges/${row.college_id}` as const,
            }
          : {
              title: `${name}暂时抓不了`,
              body: `原因：${row.reason}`,
              link: "/requests?status=unavailable" as const,
            };
      return voters
        .filter((v) => v.request_id === row.id)
        .map((v) => ({ user_id: v.user_id, ...message }));
    }),
  );
}
