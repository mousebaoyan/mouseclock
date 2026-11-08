import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db, pageOf } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { unix } from "../../platform/http.ts";
import type { Evidence, ExtractedFields, Kind, Role, StoredValue } from "../programs/schemas.ts";
import { currentFields, deleteProgram, lockProgram, setFields } from "../programs/service.ts";
import { recordAudit } from "../review/service.ts";
import {
  docsOf,
  extractionContext,
  holdForReview,
  mergeProgram,
  type ExtractedProgram,
  type ReviewReason,
} from "./service.ts";

// What people decide on the review page about extractions (design §12.2).

type Reviewer = { user_id: number; via: "web" };

// How an item is accepted: for a program that couldn't be placed, the school's program to merge it
// into, or the college, cohort and kind of a new one; for a possible duplicate, the one it
// duplicates, or nothing to keep it. Other items take nothing.
export type Decision = { program_id?: number; college_id?: number; cohort?: number; kind?: Kind };

// In the order the review page lists them.
export const REASONS = [
  "no_deadline",
  "conflicts_edit",
  "implausible",
  "evidence_not_found",
  "low_confidence",
  "unknown_program",
  "unknown_college",
  "implausible_cohort",
  "possible_duplicate",
] as const satisfies ReviewReason[];

const FIELD_REASONS: ReviewReason[] = [
  "conflicts_edit",
  "implausible",
  "evidence_not_found",
  "low_confidence",
];
const PLACING_REASONS: ReviewReason[] = [
  "unknown_program",
  "unknown_college",
  "implausible_cohort",
];

type FieldPayload = { value: StoredValue; evidence: Evidence[]; confidence: number };

type ItemProgram = { id: number; name: string; college: string; school: string };

function itemsQuery(reason: ReviewReason) {
  return db
    .selectFrom("review_items")
    .innerJoin("snapshots", "snapshots.id", "review_items.snapshot_id")
    .innerJoin("notices", "notices.id", "snapshots.notice_id")
    .select([
      "review_items.id",
      "review_items.created_at",
      "snapshots.id as snapshot_id",
      "notices.title as notice_title",
      "notices.url as notice_url",
      // The program the item is about, if there is one yet.
      sql<ItemProgram | null>`(
        select jsonb_build_object('id', p.id, 'name', p.name, 'college', c.name, 'school', s.name)
        from programs as p
        join colleges as c on c.id = p.college_id
        join schools as s on s.id = c.school_id
        where p.id = review_items.program_id
      )`.as("program"),
    ])
    .where("review_items.status", "=", "pending")
    .where("review_items.reason", "=", reason)
    .orderBy("review_items.id");
}

// The pending items of one reason, the first one with any when none is asked for, and how many
// of each reason wait.
export async function listReviewItems(query: {
  reason?: ReviewReason;
  page: number;
  per_page: number;
}) {
  const counts = await db
    .selectFrom("review_items")
    .select([sql<ReviewReason>`reason`.as("reason"), (eb) => eb.fn.countAll<number>().as("count")])
    .where("status", "=", "pending")
    .groupBy("reason")
    .execute();
  const reason =
    query.reason ?? REASONS.find((r) => counts.some((row) => row.reason === r)) ?? REASONS[0];
  const paging = { page: query.page, per_page: query.per_page };
  const found = FIELD_REASONS.includes(reason)
    ? await fieldItems(reason, paging)
    : await programItems(reason, paging);
  return {
    reason,
    counts: Object.fromEntries(counts.map((row) => [row.reason, row.count])),
    ...found,
  };
}

// A field held back: what the version said, and what the field is now, to compare.
async function fieldItems(reason: ReviewReason, paging: { page: number; per_page: number }) {
  const page = await pageOf(
    itemsQuery(reason)
      .innerJoin("program_versions", "program_versions.id", "review_items.version_id")
      .leftJoin("program_fields", (join) =>
        join
          .onRef("program_fields.program_id", "=", "review_items.program_id")
          .onRef("program_fields.key", "=", "review_items.key"),
      )
      .select([
        sql<string>`review_items.key`.as("key"),
        sql<FieldPayload>`review_items.payload`.as("payload"),
        "program_versions.number as version",
        sql<StoredValue | null>`program_fields.value`.as("current_value"),
        sql<number | null>`(
          select number from program_versions where id = program_fields.version_id
        )`.as("current_version"),
        sql<boolean>`program_fields.key is not null`.as("stated"),
      ]),
    paging,
  );
  return {
    ...page,
    items: page.items.map((row) => ({
      ...common(row),
      field: {
        key: row.key,
        version: row.version,
        ...row.payload,
        current: row.stated ? { value: row.current_value, version: row.current_version } : null,
      },
      extracted: null,
    })),
  };
}

// A program from an extraction, with the school's colleges and programs to place it among.
async function programItems(reason: ReviewReason, paging: { page: number; per_page: number }) {
  const page = await pageOf(
    itemsQuery(reason).select([
      sql<ExtractedProgram>`review_items.payload`.as("payload"),
      "notices.source_id",
      "notices.published_on",
    ]),
    paging,
  );
  return {
    ...page,
    items: await Promise.all(
      page.items.map(async (row) => {
        const { colleges, programs } = await extractionContext(db, row.source_id, row.published_on);
        return {
          ...common(row),
          field: null,
          extracted: { program: row.payload, colleges, programs },
        };
      }),
    ),
  };
}

function common(row: {
  id: number;
  created_at: Date;
  snapshot_id: number;
  notice_title: string;
  notice_url: string;
  program: ItemProgram | null;
}) {
  return {
    id: row.id,
    created_at: unix(row.created_at),
    notice: { title: row.notice_title, url: row.notice_url, snapshot_id: row.snapshot_id },
    program: row.program,
  };
}

// The item to decide on, locked; one already decided isn't decided again.
async function pendingItem(trx: Transaction<DB>, id: number) {
  const item = await trx
    .selectFrom("review_items")
    .select([
      "id",
      sql<ReviewReason>`reason`.as("reason"),
      "snapshot_id",
      "program_id",
      "version_id",
      "key",
      "status",
    ])
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
  if (!item) throw new AppError(404, "not_found", "待审的条目不存在");
  if (item.status !== "pending") throw new AppError(409, "already_resolved", "这一条已经处理过了");
  return item;
}

type Item = Awaited<ReturnType<typeof pendingItem>>;

async function resolve(
  trx: Transaction<DB>,
  reviewer: Reviewer,
  item: Item,
  status: "accepted" | "rejected",
  decision: Decision,
) {
  await trx
    .updateTable("review_items")
    .set({ status, resolved_by: reviewer.user_id, resolved_at: new Date() })
    .where("id", "=", item.id)
    .execute();
  await recordAudit(trx, {
    user_id: reviewer.user_id,
    action: status === "accepted" ? "accept" : "reject",
    target_type: "review_item",
    target_id: item.id,
    detail: { via: reviewer.via, reason: item.reason, ...decision },
  });
}

// Rejecting closes the item and changes nothing else (design §12.2).
export async function rejectReviewItem(reviewer: Reviewer, id: number) {
  await db.transaction().execute(async (trx) => {
    await resolve(trx, reviewer, await pendingItem(trx, id), "rejected", {});
  });
}

// What accepting does depends on why the item waits (design §12.2). A decision the item has no
// use for is refused, not ignored, as the audit log keeps it.
export async function acceptReviewItem(reviewer: Reviewer, id: number, decision: Decision) {
  await db.transaction().execute(async (trx) => {
    const item = await pendingItem(trx, id);
    const { program_id: programId, ...created } = decision;
    if (programId !== undefined && Object.keys(created).length > 0) {
      throw new AppError(400, "invalid_request", "选了项目就不用再选学院和届");
    }
    if (PLACING_REASONS.includes(item.reason)) await placeProgram(trx, item, decision);
    else if (item.reason === "possible_duplicate" && programId !== undefined) {
      await mergeDuplicate(trx, reviewer, item, programId);
    } else if (Object.keys(decision).length > 0) {
      throw new AppError(400, "invalid_request", "这一条通过时不用选项目或学院");
    } else if (FIELD_REASONS.includes(item.reason)) await acceptField(trx, item);
    await resolve(trx, reviewer, item, "accepted", decision);
  });
}

// The field goes on the table from its version, which later notices go on updating; the version
// counts it among its changes if it changed the value.
async function acceptField(trx: Transaction<DB>, item: Item) {
  const { program_id: programId, version_id: versionId, key } = item;
  if (programId === null || versionId === null || key === null) {
    throw new Error(`Review item ${item.id} has no field`);
  }
  await lockProgram(trx, programId);
  const now = (await currentFields(trx, programId)).get(key);
  if (now?.version_id === versionId) return;
  const { payload } = await trx
    .selectFrom("review_items")
    .select(sql<FieldPayload>`payload`.as("payload"))
    .where("id", "=", item.id)
    .executeTakeFirstOrThrow();
  await setFields(trx, programId, [[key, { version_id: versionId }]]);
  if (isDeepStrictEqual(now?.value ?? null, payload.value)) return;
  await trx
    .updateTable("program_versions")
    .set({ changes: sql`array_append(changes, ${key})` })
    .where("id", "=", versionId)
    .where(sql<boolean>`not (${key} = any(changes))`)
    .execute();
}

// The notice an item came from and what the extraction made of it, with the school's colleges and
// programs, which are what it can be placed among.
async function noticeOf(trx: Transaction<DB>, item: Item) {
  const notice = await trx
    .selectFrom("review_items")
    .innerJoin("snapshots", "snapshots.id", "review_items.snapshot_id")
    .innerJoin("notices", "notices.id", "snapshots.notice_id")
    .select([
      sql<ExtractedProgram>`review_items.payload`.as("payload"),
      "notices.source_id",
      "notices.published_on",
    ])
    .where("review_items.id", "=", item.id)
    .executeTakeFirstOrThrow();
  return {
    ...notice,
    ...(await extractionContext(trx, notice.source_id, notice.published_on)),
  };
}

async function hasVersion(trx: Transaction<DB>, programId: number, snapshotId: number) {
  const row = await trx
    .selectFrom("program_versions")
    .select("id")
    .where("program_id", "=", programId)
    .where("snapshot_id", "=", snapshotId)
    .executeTakeFirst();
  return row !== undefined;
}

// A program the extraction couldn't place goes where the reviewer says, merged as ingest does.
async function placeProgram(trx: Transaction<DB>, item: Item, decision: Decision) {
  const { payload, published_on, colleges, programs } = await noticeOf(trx, item);
  let program: ExtractedProgram;
  if (decision.program_id !== undefined) {
    if (!programs.some((p) => p.id === decision.program_id)) {
      throw new AppError(404, "not_found", "这所学校没有这个项目");
    }
    await lockProgram(trx, decision.program_id);
    if (await hasVersion(trx, decision.program_id, item.snapshot_id)) {
      throw new AppError(409, "already_merged", "这条通知已经是这个项目的一个版本了");
    }
    program = { ...payload, program_id: decision.program_id };
  } else {
    const { college_id, cohort, kind = payload.kind } = decision;
    if (college_id === undefined || cohort === undefined) {
      throw new AppError(400, "invalid_request", "要选一个项目，或者选好学院和届新建一个");
    }
    if (!colleges.some((c) => c.id === college_id)) {
      throw new AppError(404, "not_found", "这所学校没有这个学院");
    }
    program = { ...payload, program_id: undefined, college_id, cohort, kind };
  }
  const docs = await docsOf(trx, item.snapshot_id);
  await holdForReview(
    trx,
    await mergeProgram(trx, item.snapshot_id, published_on, docs, programs, program),
  );
}

// A duplicate's versions go on the original in their order, as if its notices had named it, and
// the duplicate is deleted. What else waited on it is merged anew, so its items close.
async function mergeDuplicate(
  trx: Transaction<DB>,
  reviewer: Reviewer,
  item: Item,
  targetId: number,
) {
  const duplicateId = item.program_id;
  if (duplicateId === null) throw new Error(`Review item ${item.id} has no program`);
  if (targetId === duplicateId) {
    throw new AppError(400, "invalid_request", "要选原来的那个项目，不能是它自己");
  }
  const { programs } = await noticeOf(trx, item);
  if (!programs.some((p) => p.id === targetId)) {
    throw new AppError(404, "not_found", "这所学校没有这个项目");
  }
  // Deciding an item locks it before its program; the duplicate's are locked first here too, or
  // deciding one of them meanwhile could deadlock with this.
  await trx
    .selectFrom("review_items")
    .select("id")
    .where("program_id", "=", duplicateId)
    .where("status", "=", "pending")
    .forUpdate()
    .execute();
  await lockProgram(trx, targetId);
  const duplicate = await trx
    .selectFrom("programs")
    .select(["college_id", "cohort", "name", sql<Kind>`kind`.as("kind")])
    .where("id", "=", duplicateId)
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  if (!duplicate) throw new AppError(404, "not_found", "项目不存在");
  // People's edits are on the duplicate's fields and would go with it.
  const edited = await trx
    .selectFrom("program_fields")
    .select("key")
    .where("program_id", "=", duplicateId)
    .where("edit_id", "is not", null)
    .executeTakeFirst();
  if (edited) {
    throw new AppError(
      409,
      "has_edits",
      "这个项目有人改过，先在它的详情页撤销那些修改，并进去以后再到原来的项目上改",
    );
  }
  const versions = await trx
    .selectFrom("program_versions")
    .innerJoin("snapshots", "snapshots.id", "program_versions.snapshot_id")
    .innerJoin("notices", "notices.id", "snapshots.notice_id")
    .select([
      "program_versions.snapshot_id",
      sql<Role>`program_versions.role`.as("role"),
      sql<ExtractedFields>`program_versions.fields`.as("fields"),
      "notices.published_on",
    ])
    .where("program_versions.program_id", "=", duplicateId)
    .orderBy("program_versions.number")
    .execute();
  for (const version of versions) {
    // One notice gave both, and a notice is one version of a program, not two.
    if (await hasVersion(trx, targetId, version.snapshot_id)) {
      throw new AppError(
        409,
        "already_merged",
        "原来的项目也有这条通知的版本，同一条通知没法在一个项目里算两个版本",
      );
    }
    await holdForReview(
      trx,
      await mergeProgram(
        trx,
        version.snapshot_id,
        version.published_on,
        await docsOf(trx, version.snapshot_id),
        [],
        { ...duplicate, program_id: targetId, role: version.role, fields: version.fields },
      ),
    );
  }
  await deleteProgram(trx, duplicateId);
  await trx
    .updateTable("review_items")
    .set({ status: "rejected", resolved_by: reviewer.user_id, resolved_at: new Date() })
    .where("program_id", "=", duplicateId)
    .where("status", "=", "pending")
    .where("id", "!=", item.id)
    .execute();
}
