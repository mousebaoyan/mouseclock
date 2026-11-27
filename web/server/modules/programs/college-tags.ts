import type { z } from "@hono/zod-openapi";
import type { Actor } from "../../platform/access.ts";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { recordAudit } from "../../platform/audit.ts";
import { db, explainConflict } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import type { ShownTags, TagColor, TagInput, TagPatch } from "./schemas.ts";
import { TAG_THRESHOLD } from "./tag-rules.ts";

// 学院标签 (design §9.3): members put the admins' presets on colleges, one vote each; a tag counts
// as the college's once enough of them did.

// The tags that count as the college's, in the presets' order, which the table filters by.
export function tagsOf(college: string) {
  return sql<string[]>`array(
    select t.name from college_tags as t
    where (
      select count(*) from college_tag_votes as v
      where v.college_id = ${sql.ref(college)} and v.tag_id = t.id
    ) >= ${TAG_THRESHOLD}
    order by t.sort
  )`;
}

// The column holds only these: a check in the table.
function colorOf(column: string) {
  return sql<z.infer<typeof TagColor>>`${sql.ref(column)}`.as("color");
}

// Every tag someone put on the college, with how many did, in the presets' order: 院校清单 shows
// them all, and filters by those that count.
export function shownTagsOf(college: string) {
  return sql<z.infer<typeof ShownTags>>`coalesce((
    select json_agg(
      json_build_object('name', t.name, 'color', t.color, 'count', v.count) order by t.sort
    )
    from college_tags as t
    cross join lateral (
      select count(*)::int as count from college_tag_votes as v
      where v.college_id = ${sql.ref(college)} and v.tag_id = t.id
    ) as v
    where v.count > 0
  ), '[]')`;
}

// Every preset on a college's page: how many put it on, and whether `userId` did.
export async function collegeTagCounts(collegeId: number, userId: number) {
  return db
    .selectFrom("college_tags as t")
    .leftJoin("college_tag_votes as v", (join) =>
      join.onRef("v.tag_id", "=", "t.id").on("v.college_id", "=", collegeId),
    )
    .select(["t.id", "t.name", "t.description", colorOf("t.color")])
    .select((eb) => [
      eb.fn.count<number>("v.id").as("count"),
      sql<boolean>`coalesce(bool_or(v.user_id = ${userId}), false)`.as("mine"),
    ])
    .groupBy("t.id")
    .orderBy("t.sort")
    .execute();
}

export async function tagCollege(userId: number, collegeId: number, tagId: number) {
  try {
    await db
      .insertInto("college_tag_votes")
      .values({ college_id: collegeId, tag_id: tagId, user_id: userId })
      .onConflict((oc) => oc.columns(["college_id", "tag_id", "user_id"]).doNothing())
      .execute();
  } catch (error) {
    throw explainConflict(error, {
      college_tag_votes_college_id_fkey: [404, "not_found", "学院不存在"],
      college_tag_votes_tag_id_fkey: [404, "not_found", "标签不存在"],
    });
  }
}

export async function untagCollege(userId: number, collegeId: number, tagId: number) {
  await db
    .deleteFrom("college_tag_votes")
    .where("college_id", "=", collegeId)
    .where("tag_id", "=", tagId)
    .where("user_id", "=", userId)
    .execute();
}

// Who put a tag on a college and when, the latest first, for admins to remove what was put on
// at random.
export async function tagVotes(collegeId: number, tagId: number) {
  const rows = await db
    .selectFrom("college_tag_votes as v")
    .innerJoin("users as u", "u.id", "v.user_id")
    .select(["v.id", "u.id as user_id", "u.display_name", "u.avatar_url", "v.created_at"])
    .where("v.college_id", "=", collegeId)
    .where("v.tag_id", "=", tagId)
    .orderBy("v.created_at", "desc")
    .orderBy("v.id", "desc")
    .execute();
  return rows.map((v) => ({
    id: v.id,
    user: { id: v.user_id, display_name: v.display_name, avatar_url: v.avatar_url },
    created_at: unix(v.created_at),
  }));
}

export async function removeVote(actor: Actor, voteId: number) {
  await db.transaction().execute(async (trx) => {
    const vote = await trx
      .deleteFrom("college_tag_votes")
      .where("id", "=", voteId)
      .returning(["tag_id", "college_id", "user_id", "created_at"])
      .executeTakeFirst();
    if (!vote) throw new AppError(404, "not_found", "这一票不存在");
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "remove_vote",
      target_type: "college_tag",
      target_id: vote.tag_id,
      detail: { via: actor.via, vote },
    });
  });
}

// Every vote for the tag on the college.
export async function clearTag(actor: Actor, collegeId: number, tagId: number) {
  await db.transaction().execute(async (trx) => {
    const removed = await trx
      .deleteFrom("college_tag_votes")
      .where("college_id", "=", collegeId)
      .where("tag_id", "=", tagId)
      .returning(["user_id", "created_at"])
      .execute();
    if (removed.length === 0) return;
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "clear",
      target_type: "college_tag",
      target_id: tagId,
      detail: { via: actor.via, college_id: collegeId, votes: removed },
    });
  });
}

// The presets in order, with how many members put each on anywhere, for 管理 · 学院标签.
export async function listTags() {
  return db
    .selectFrom("college_tags as t")
    .leftJoin("college_tag_votes as v", "v.tag_id", "t.id")
    .select(["t.id", "t.name", "t.description", colorOf("t.color"), "t.sort"])
    .select((eb) => eb.fn.count<number>("v.user_id").distinct().as("voters"))
    .groupBy("t.id")
    .orderBy("t.sort")
    .execute();
}

// Names are unique, so two presets can't be told apart only by their descriptions.
async function writeTags<T>(operation: (trx: Transaction<DB>) => Promise<T>) {
  try {
    return await db.transaction().execute(async (trx) => {
      // One change to the presets at a time: their order is rewritten whole.
      await sql`lock table college_tags in share row exclusive mode`.execute(trx);
      return await operation(trx);
    });
  } catch (error) {
    throw explainConflict(error, { college_tags_name_key: [409, "duplicate", "已经有这个标签了"] });
  }
}

export async function createTag(actor: Actor, values: z.infer<typeof TagInput>) {
  return writeTags(async (trx) => {
    const { last } = await trx
      .selectFrom("college_tags")
      .select((eb) => eb.fn.coalesce(eb.fn.max("sort"), eb.lit(0)).as("last"))
      .executeTakeFirstOrThrow();
    const tag = await trx
      .insertInto("college_tags")
      .values({ ...values, sort: last + 1 })
      .returning(["id", "name", "description", "color", "sort"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "create",
      target_type: "college_tag",
      target_id: tag.id,
      detail: { via: actor.via, before: null, after: tag },
    });
    return tag.id;
  });
}

// Renaming keeps the votes; a new place moves the others along.
export async function updateTag(
  actor: Actor,
  id: number,
  { sort, ...values }: z.infer<typeof TagPatch>,
) {
  await writeTags(async (trx) => {
    const tags = await trx
      .selectFrom("college_tags")
      .select(["id", "name", "description", "color", "sort"])
      .orderBy("sort")
      .execute();
    const before = tags.find((t) => t.id === id);
    if (!before) throw new AppError(404, "not_found", "标签不存在");
    if (Object.keys(values).length > 0) {
      await trx.updateTable("college_tags").set(values).where("id", "=", id).execute();
    }
    if (sort !== undefined) {
      const order = tags.filter((t) => t.id !== id);
      order.splice(Math.min(sort, tags.length) - 1, 0, before);
      for (const [i, tag] of order.entries()) {
        if (tag.sort !== i + 1) {
          await trx
            .updateTable("college_tags")
            .set({ sort: i + 1 })
            .where("id", "=", tag.id)
            .execute();
        }
      }
    }
    const after = await trx
      .selectFrom("college_tags")
      .select(["id", "name", "description", "color", "sort"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "college_tag",
      target_id: id,
      detail: { via: actor.via, before, after },
    });
  });
}

// The votes for it go too.
export async function deleteTag(actor: Actor, id: number) {
  await writeTags(async (trx) => {
    // Locked, so no one puts it on between counting the votes and deleting them.
    const before = await trx
      .selectFrom("college_tags")
      .select(["id", "name", "description", "color", "sort"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, "not_found", "标签不存在");
    const votes = await trx
      .deleteFrom("college_tag_votes")
      .where("tag_id", "=", id)
      .returning(["college_id", "user_id", "created_at"])
      .execute();
    await trx.deleteFrom("college_tags").where("id", "=", id).execute();
    // The ones after it close up.
    await trx
      .updateTable("college_tags")
      .set((eb) => ({ sort: eb("sort", "-", 1) }))
      .where("sort", ">", before.sort)
      .execute();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "delete",
      target_type: "college_tag",
      target_id: id,
      detail: { via: actor.via, before, votes },
    });
  });
}
