import { sql, type Transaction } from "kysely";
import { DatabaseError } from "pg";
import type { z } from "zod";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { recordAudit } from "../review/service.ts";
import {
  PAGE_SIZE,
  type SchoolInput,
  type SchoolPatch,
  type CollegeInput,
  type CollegePatch,
  type SourceInput,
  type SourcePatch,
  type PageQuery,
  type CollegeQuery,
  type SourceQuery,
} from "./schemas.ts";

export type Actor = { user_id: number; via: "web" | "seed" };

// Keep constraint failures useful even if two admins save the same name concurrently.
async function write<T>(operation: (trx: Transaction<DB>) => Promise<T>) {
  try {
    return await db.transaction().execute(operation);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505") {
      throw new AppError(409, "duplicate", "名称或来源网址已存在", error);
    }
    if (error instanceof DatabaseError && error.code === "23503") {
      throw new AppError(404, "not_found", "所属学校、学院或操作人不存在", error);
    }
    throw error;
  }
}

function pageOf<T>(rows: T[], page: number) {
  return {
    items: rows.slice(0, PAGE_SIZE),
    page,
    next_page: rows.length > PAGE_SIZE ? page + 1 : null,
  };
}

export async function listSchools({ q, page }: z.infer<typeof PageQuery>) {
  let query = db.selectFrom("schools").select(["id", "name", "short_name", "tiers"]);
  if (q)
    query = query.where((eb) =>
      eb.or([eb("name", "ilike", `%${q}%`), eb("short_name", "ilike", `%${q}%`)]),
    );
  return pageOf(
    await query
      .orderBy("id")
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .execute(),
    page,
  );
}

export async function getSchool(id: number) {
  const row = await db
    .selectFrom("schools")
    .select(["id", "name", "short_name", "tiers"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "学校不存在");
  return row;
}

export async function createSchool(actor: Actor, values: z.infer<typeof SchoolInput>) {
  return write(async (trx) => {
    const row = await trx
      .insertInto("schools")
      .values(values)
      .returning(["id", "name", "short_name", "tiers"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "create",
      target_type: "school",
      target_id: row.id,
      detail: { via: actor.via, before: null, after: row },
    });
    return row;
  });
}

export async function updateSchool(actor: Actor, id: number, values: z.infer<typeof SchoolPatch>) {
  return write(async (trx) => {
    const before = await trx
      .selectFrom("schools")
      .select(["id", "name", "short_name", "tiers"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, "not_found", "学校不存在");
    const after = await trx
      .updateTable("schools")
      .set(values)
      .where("id", "=", id)
      .returning(["id", "name", "short_name", "tiers"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "school",
      target_id: id,
      detail: { via: actor.via, before, after },
    });
    return after;
  });
}

export async function listColleges({ q, page, school_id }: z.infer<typeof CollegeQuery>) {
  let query = db
    .selectFrom("colleges")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "colleges.id",
      "school_id",
      "schools.name as school_name",
      "colleges.name",
      "kind",
      "region",
      "directions",
    ]);
  if (school_id !== undefined) query = query.where("school_id", "=", school_id);
  if (q)
    query = query.where((eb) =>
      eb.or([
        eb("colleges.name", "ilike", `%${q}%`),
        eb("schools.name", "ilike", `%${q}%`),
        eb("schools.short_name", "ilike", `%${q}%`),
      ]),
    );
  return pageOf(
    await query
      .orderBy("colleges.id")
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .execute(),
    page,
  );
}

export async function getCollege(id: number) {
  const row = await db
    .selectFrom("colleges")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "colleges.id",
      "school_id",
      "schools.name as school_name",
      "colleges.name",
      "kind",
      "region",
      "directions",
    ])
    .where("colleges.id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "学院不存在");
  return row;
}

export async function createCollege(actor: Actor, values: z.infer<typeof CollegeInput>) {
  return write(async (trx) => {
    const row = await trx
      .insertInto("colleges")
      .values(values)
      .returning(["id", "school_id", "name", "kind", "region", "directions"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "create",
      target_type: "college",
      target_id: row.id,
      detail: { via: actor.via, before: null, after: row },
    });
    return row.id;
  });
}

export async function updateCollege(
  actor: Actor,
  id: number,
  values: z.infer<typeof CollegePatch>,
) {
  return write(async (trx) => {
    const before = await trx
      .selectFrom("colleges")
      .select(["id", "school_id", "name", "kind", "region", "directions"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, "not_found", "学院不存在");
    const after = await trx
      .updateTable("colleges")
      .set(values)
      .where("id", "=", id)
      .returning(["id", "school_id", "name", "kind", "region", "directions"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "college",
      target_id: id,
      detail: { via: actor.via, before, after },
    });
    return id;
  });
}

export async function listSources({
  q,
  page,
  college_id,
  availability,
}: z.infer<typeof SourceQuery>) {
  let query = db
    .selectFrom("sources")
    .innerJoin("colleges", "colleges.id", "sources.college_id")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "sources.id",
      "college_id",
      "schools.name as school_name",
      "colleges.name as college_name",
      "url",
      "section",
      "browser",
      "unavailable_reason",
      "crawled_at",
    ]);
  if (college_id !== undefined) query = query.where("college_id", "=", college_id);
  if (availability)
    query = query.where("unavailable_reason", availability === "available" ? "is" : "is not", null);
  if (q)
    query = query.where((eb) =>
      eb.or([
        eb("url", "ilike", `%${q}%`),
        eb("section", "ilike", `%${q}%`),
        eb("colleges.name", "ilike", `%${q}%`),
        eb("schools.name", "ilike", `%${q}%`),
      ]),
    );
  return pageOf(
    await query
      .orderBy("sources.id")
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .execute(),
    page,
  );
}

export async function latestRuns(sourceIds: number[]) {
  if (sourceIds.length === 0) return [];
  const rows = await db
    .selectFrom("crawl_runs")
    .select([
      "id",
      "source_id",
      "started_at",
      "finished_at",
      "failure",
      "detail",
      "listed",
      "new_count",
      "useful_count",
    ])
    .select(sql<number>`jsonb_array_length(notice_failures)`.as("notice_failure_count"))
    .where("source_id", "in", sourceIds)
    .distinctOn("source_id")
    .orderBy("source_id")
    .orderBy("finished_at", "desc")
    .orderBy("id", "desc")
    .execute();
  return rows.map(({ started_at, finished_at, ...run }) => ({
    ...run,
    started_at: unix(started_at),
    finished_at: unix(finished_at),
  }));
}

export async function getSource(id: number) {
  const row = await db
    .selectFrom("sources")
    .innerJoin("colleges", "colleges.id", "sources.college_id")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "sources.id",
      "college_id",
      "schools.name as school_name",
      "colleges.name as college_name",
      "url",
      "section",
      "browser",
      "unavailable_reason",
      "crawled_at",
    ])
    .select(sql<Record<string, unknown> | null>`config`.as("config"))
    .where("sources.id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "来源不存在");
  return row;
}

export async function createSource(actor: Actor, values: z.infer<typeof SourceInput>) {
  return write(async (trx) => {
    const row = await trx
      .insertInto("sources")
      .values({ ...values, config: values.config === null ? null : JSON.stringify(values.config) })
      .returning(["id", "college_id", "url", "section", "browser", "config", "unavailable_reason"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "create",
      target_type: "source",
      target_id: row.id,
      detail: { via: actor.via, before: null, after: row },
    });
    return row.id;
  });
}

export async function updateSource(actor: Actor, id: number, values: z.infer<typeof SourcePatch>) {
  return write(async (trx) => {
    const before = await trx
      .selectFrom("sources")
      .select(["id", "college_id", "url", "section", "browser", "config", "unavailable_reason"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, "not_found", "来源不存在");
    const after = await trx
      .updateTable("sources")
      .set({
        ...values,
        config:
          values.config === undefined
            ? undefined
            : values.config === null
              ? null
              : JSON.stringify(values.config),
      })
      .where("id", "=", id)
      .returning(["id", "college_id", "url", "section", "browser", "config", "unavailable_reason"])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "source",
      target_id: id,
      detail: { via: actor.via, before, after },
    });
    return id;
  });
}

// The sources module owns scheduling state too; ingest calls it inside its own transaction,
// for probes as well as sources.
export async function leaseSources(
  trx: Transaction<DB>,
  now: Date,
  dueBefore: Date,
  leaseEnd: Date,
  limit: number,
) {
  return trx
    .updateTable("sources")
    .set({ leased_until: leaseEnd })
    .where("id", "in", (qb) =>
      qb
        .selectFrom("sources")
        .select("id")
        .where("unavailable_reason", "is", null)
        .where((eb) => eb.or([eb("leased_until", "is", null), eb("leased_until", "<", now)]))
        .where((eb) => eb.or([eb("crawled_at", "is", null), eb("crawled_at", "<", dueBefore)]))
        .orderBy("crawled_at", (ob) => ob.asc().nullsFirst())
        .limit(limit)
        .forUpdate()
        .skipLocked(),
    )
    .returning(["id", "url", "section", "browser", "crawled_at"])
    .returning(sql<Record<string, unknown> | null>`config`.as("config"))
    .execute();
}

export async function finishSourceCrawl(trx: Transaction<DB>, id: number, finishedAt: Date) {
  await trx
    .updateTable("sources")
    .set({ crawled_at: finishedAt, leased_until: null })
    .where("id", "=", id)
    .execute();
}

export async function leaseProbes(trx: Transaction<DB>, now: Date, leaseEnd: Date, limit: number) {
  return trx
    .updateTable("source_probes")
    .set({ leased_until: leaseEnd })
    .where("id", "in", (qb) =>
      qb
        .selectFrom("source_probes")
        .select("id")
        .where("finished_at", "is", null)
        .where((eb) => eb.or([eb("leased_until", "is", null), eb("leased_until", "<", now)]))
        .orderBy("id")
        .limit(limit)
        .forUpdate()
        .skipLocked(),
    )
    .returning(["id", "url", "browser"])
    .returning(sql<Record<string, unknown> | null>`config`.as("config"))
    .execute();
}

// False when the probe was already finished: a resend after a lost response changes nothing.
export async function finishProbe(
  trx: Transaction<DB>,
  id: number,
  result: {
    items: { url: string; title: string; published_on?: string }[];
    suggested_config?: Record<string, unknown>;
    failure?: string;
    detail?: string;
  },
) {
  const probe = await trx
    .selectFrom("source_probes")
    .select("finished_at")
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!probe) throw new AppError(404, "not_found", "试抓不存在");
  if (probe.finished_at) return false;
  await trx
    .updateTable("source_probes")
    .set({
      finished_at: new Date(),
      leased_until: null,
      items: JSON.stringify(result.items),
      suggested_config: result.suggested_config ? JSON.stringify(result.suggested_config) : null,
      failure: result.failure ?? null,
      detail: result.detail ?? "",
    })
    .where("id", "=", id)
    .execute();
  return true;
}
