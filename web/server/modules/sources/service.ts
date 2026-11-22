import { sql, type Transaction } from "kysely";
import type { Actor } from "../../platform/access.ts";
import type { z } from "zod";
import type { DB } from "../../../db/types.ts";
import { db, pageOf, explainConflict } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import { recordAudit } from "../../platform/audit.ts";
import type { Kind } from "../programs/schemas.ts";
import { collegeTagCounts, TAG_THRESHOLD, tagsOf } from "../programs/college-tags.ts";
import { applyOf, eventEndOf, logoOf } from "../programs/service.ts";
import { closesAt } from "../programs/time.ts";
import {
  type SchoolInput,
  type SchoolPatch,
  type CollegeInput,
  type CollegePatch,
  type SourceInput,
  type SourcePatch,
  type PageQuery,
  type CollegeQuery,
  type SourceQuery,
  type ProbeInput,
  type Failure,
  type PublicSchool,
  type PublicProgramCohort,
} from "./schemas.ts";
import type { LogoType } from "./logo-files.ts";
import { includeCollege } from "./inclusion-requests.ts";

// Keep constraint failures useful even if two admins save the same name concurrently.
async function write<T>(operation: (trx: Transaction<DB>) => Promise<T>) {
  try {
    return await db.transaction().execute(operation);
  } catch (error) {
    throw explainConflict(error, {
      schools_name_key: [409, "duplicate", "已有同名的学校"],
      colleges_school_id_name_key: [409, "duplicate", "这所学校已有同名的学院"],
      sources_url_key: [409, "duplicate", "已有这个来源网址"],
      school_logos_school_id_fkey: [404, "not_found", "学校不存在"],
      colleges_school_id_fkey: [404, "not_found", "所属学校不存在"],
      sources_college_id_fkey: [404, "not_found", "所属学院不存在"],
    });
  }
}

// A school as admins see it, from a query on `schools`.
const SCHOOL = ["id", "name", "short_names", "tier", logoOf("schools.id").as("logo")] as const;

// Whether the school's name or one of its short names has `q` in it.
function schoolNamed(q: string) {
  const pattern = `%${q}%`;
  return sql<boolean>`(schools.name ILIKE ${pattern} OR EXISTS (SELECT FROM unnest(schools.short_names) AS short_name WHERE short_name ILIKE ${pattern}))`;
}

export async function getLogo(schoolId: number) {
  const row = await db
    .selectFrom("school_logos")
    .select(["content_type", "data"])
    .where("school_id", "=", schoolId)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "该学校没有校徽");
  return row;
}

export async function setLogo(
  actor: Actor,
  schoolId: number,
  logo: { content_type: LogoType; data: Buffer },
) {
  await write(async (trx) => {
    await trx
      .insertInto("school_logos")
      .values({ school_id: schoolId, ...logo })
      .onConflict((conflict) =>
        conflict.column("school_id").doUpdateSet({ ...logo, updated_at: new Date() }),
      )
      .execute();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "school",
      target_id: schoolId,
      detail: { via: actor.via, logo: logo.content_type },
    });
  });
}

export async function removeLogo(actor: Actor, schoolId: number) {
  await write(async (trx) => {
    const result = await trx
      .deleteFrom("school_logos")
      .where("school_id", "=", schoolId)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) throw new AppError(404, "not_found", "该学校没有校徽");
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "school",
      target_id: schoolId,
      detail: { via: actor.via, logo: null },
    });
  });
}

export async function listSchools({ q, ...paging }: z.infer<typeof PageQuery>) {
  let query = db.selectFrom("schools").select(SCHOOL);
  if (q) query = query.where(schoolNamed(q));
  return pageOf(query.orderBy("id"), paging);
}

export async function getSchool(id: number) {
  const row = await db.selectFrom("schools").select(SCHOOL).where("id", "=", id).executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "学校不存在");
  return row;
}

export async function createSchool(actor: Actor, values: z.infer<typeof SchoolInput>) {
  return write(async (trx) => {
    const row = await trx
      .insertInto("schools")
      .values(values)
      .returning(SCHOOL)
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
      .select(SCHOOL)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, "not_found", "学校不存在");
    const after = await trx
      .updateTable("schools")
      .set(values)
      .where("id", "=", id)
      .returning(SCHOOL)
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

export async function listColleges({ q, school_id, ...paging }: z.infer<typeof CollegeQuery>) {
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
    query = query.where((eb) => eb.or([eb("colleges.name", "ilike", `%${q}%`), schoolNamed(q)]));
  return pageOf(query.orderBy("colleges.id"), paging);
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

export async function listPublicColleges() {
  const rows = await db
    .selectFrom("colleges")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "schools.id as school_id",
      "schools.name as school_name",
      "schools.short_names as school_short_names",
      "schools.tier as school_tier",
      logoOf("schools.id").as("school_logo"),
      "colleges.id",
      "colleges.name",
      "colleges.kind",
      "colleges.region",
      "colleges.directions",
      tagsOf("colleges.id").as("tags"),
    ])
    .orderBy("schools.name")
    .orderBy("colleges.name")
    .orderBy("colleges.id")
    .execute();

  const schools = new Map<number, z.infer<typeof PublicSchool>>();
  for (const row of rows) {
    let school = schools.get(row.school_id);
    if (!school) {
      school = {
        id: row.school_id,
        name: row.school_name,
        short_names: row.school_short_names,
        tier: row.school_tier,
        logo: row.school_logo,
        colleges: [],
      };
      schools.set(row.school_id, school);
    }
    school.colleges.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      region: row.region,
      directions: row.directions,
      tags: row.tags,
    });
  }
  return { schools: [...schools.values()] };
}

// A college's page as `userId` sees it: their own tags are marked.
export async function getPublicCollege(id: number, userId: number) {
  const college = await db
    .selectFrom("colleges")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .select([
      "colleges.id",
      "colleges.name",
      "colleges.kind",
      "colleges.region",
      "colleges.directions",
      "schools.id as school_id",
      "schools.name as school_name",
      "schools.tier as school_tier",
      logoOf("schools.id").as("school_logo"),
      (eb) =>
        eb
          .selectFrom("follows")
          .select((f) => f.fn.countAll<number>().as("count"))
          .whereRef("follows.college_id", "=", "colleges.id")
          .as("followers"),
      sql<boolean>`exists (
        select from follows where college_id = colleges.id and user_id = ${userId}
      )`.as("following"),
    ])
    .where("colleges.id", "=", id)
    .executeTakeFirst();
  if (!college) throw new AppError(404, "not_found", "学院不存在");

  const [tagCounts, sources, programs] = await Promise.all([
    collegeTagCounts(id, userId),
    db
      .selectFrom("sources")
      .select(["id", "url", "section", "unavailable_reason"])
      .where("college_id", "=", id)
      .orderBy("id")
      .execute(),
    db
      .selectFrom("programs")
      .select(["id", "cohort", "name", "apply_start", "apply_deadline"])
      .select(sql<Kind>`programs.kind`.as("kind"))
      .select(applyOf("programs.id").as("apply"))
      .select(eventEndOf("programs.id").as("event_end"))
      .where("college_id", "=", id)
      .where("deleted_at", "is", null)
      .orderBy("cohort", "desc")
      .orderBy("apply_deadline", (order) => order.asc().nullsLast())
      .orderBy("id")
      .execute(),
  ]);
  const grouped = new Map<number, z.infer<typeof PublicProgramCohort>["programs"]>();
  for (const { cohort, apply_start, apply_deadline, event_end, ...program } of programs) {
    const current = grouped.get(cohort) ?? [];
    current.push({
      ...program,
      apply_start: apply_start ? unix(apply_start) : null,
      apply_deadline: apply_deadline ? unix(apply_deadline) : null,
      closes_at: unix(closesAt(apply_deadline, event_end, cohort)),
    });
    grouped.set(cohort, current);
  }

  return {
    id: college.id,
    school: {
      id: college.school_id,
      name: college.school_name,
      tier: college.school_tier,
      logo: college.school_logo,
    },
    name: college.name,
    kind: college.kind,
    region: college.region,
    directions: college.directions,
    // From the same counts, so the two agree.
    tags: tagCounts.filter((tag) => tag.count >= TAG_THRESHOLD).map((tag) => tag.name),
    tag_counts: tagCounts,
    followers: college.followers ?? 0,
    following: college.following,
    sources,
    programs: [...grouped].map(([cohort, cohortPrograms]) => ({
      cohort,
      programs: cohortPrograms,
    })),
  };
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
  college_id,
  availability,
  ...paging
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
      "keep_all",
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
  return pageOf(query.orderBy("sources.id"), paging);
}

// Each source's latest round, for the sources page (design §7.5).
export async function latestRuns(sourceIds: number[]) {
  if (sourceIds.length === 0) return [];
  const rows = await db
    .selectFrom("crawl_runs")
    .select([
      "id",
      "source_id",
      "started_at",
      "finished_at",
      sql<Failure | null>`failure`.as("failure"),
      "detail",
      "listed",
      "new_count",
      "useful_count",
      "attachment_failure_count",
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
      "keep_all",
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
      .returning([
        "id",
        "college_id",
        "url",
        "section",
        "browser",
        "keep_all",
        "config",
        "unavailable_reason",
      ])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "create",
      target_type: "source",
      target_id: row.id,
      detail: { via: actor.via, before: null, after: row },
    });
    if (row.unavailable_reason === null) await includeCollege(trx, row.college_id);
    return row.id;
  });
}

export async function updateSource(actor: Actor, id: number, values: z.infer<typeof SourcePatch>) {
  return write(async (trx) => {
    const before = await trx
      .selectFrom("sources")
      .select([
        "id",
        "college_id",
        "url",
        "section",
        "browser",
        "keep_all",
        "config",
        "unavailable_reason",
      ])
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
      .returning([
        "id",
        "college_id",
        "url",
        "section",
        "browser",
        "keep_all",
        "config",
        "unavailable_reason",
      ])
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "update",
      target_type: "source",
      target_id: id,
      detail: { via: actor.via, before, after },
    });
    // A college with a source crawled is included (design §10.1).
    const crawled = after.unavailable_reason === null;
    if (crawled && (after.college_id !== before.college_id || before.unavailable_reason !== null)) {
      await includeCollege(trx, after.college_id);
    }
    return id;
  });
}

// The crawler picks it up the next time it asks for work (leaseProbes) and reports back
// (finishProbe); adopting what it suggests is saving a source with it (design §7.2).
export async function createProbe(actor: Actor, values: z.infer<typeof ProbeInput>) {
  return db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto("source_probes")
      .values({
        ...values,
        config: values.config === null ? null : JSON.stringify(values.config),
        requested_by: actor.user_id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, {
      user_id: actor.user_id,
      action: "create",
      target_type: "source_probe",
      target_id: id,
      detail: { via: actor.via, ...values },
    });
    return id;
  });
}

export async function getProbe(id: number) {
  const row = await db
    .selectFrom("source_probes")
    .select(["id", "url", "browser", "created_at", "finished_at", "detail"])
    .select([
      sql<Record<string, unknown> | null>`config`.as("config"),
      sql<{ url: string; title: string; published_on?: string }[]>`items`.as("items"),
      sql<Record<string, unknown> | null>`suggested_config`.as("suggested_config"),
      sql<Failure | null>`failure`.as("failure"),
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError(404, "not_found", "试抓不存在");
  return {
    ...row,
    created_at: unix(row.created_at),
    finished_at: row.finished_at && unix(row.finished_at),
  };
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
    .returning(["id", "url", "browser", "keep_all", "crawled_at"])
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
    failure?: Failure;
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
