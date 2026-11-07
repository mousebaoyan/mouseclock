import { sql, type Transaction } from "kysely";
import type { DB, Json } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import type { ApplyValue, ExtractedFields, Kind, Role } from "../programs/schemas.ts";
import {
  applyStored,
  createProgram,
  toStoredFields,
  type StoredField,
} from "../programs/service.ts";
import { deadlineOf, startOf } from "../programs/time.ts";
import { finishProbe, finishSourceCrawl, leaseProbes, leaseSources } from "../sources/service.ts";

// How long the crawler has to report on work before it is handed out again (api.md §6).
const LEASE_MS = 2 * 3600_000;
// Design §7.3: twice a day, every four hours in the busy months.
const INTERVAL_MS = 12 * 3600_000;
const BUSY_INTERVAL_MS = 4 * 3600_000;
const BUSY_MONTHS = new Set([3, 4, 5, 6, 7, 8, 9, 12, 1]);
// Notices of programs still open are fetched again once a day to catch changes (design §7.4),
// in their source's round; those without a deadline, for this long after the program appeared.
const RECHECK_MS = 24 * 3600_000;
const UNDATED_RECHECK_MS = 90 * 24 * 3600_000;
const MAX_SOURCES = 50;
const MAX_PROBES = 5;

export type Failure =
  "timeout" | "unreachable" | "too_many_redirects" | "http_status" | "no_items" | "error";
export type Usage = { model: string; input_tokens: number; output_tokens: number };
export type ListedItem = { url: string; title: string; published_on?: string };

export async function createCrawlerToken(name: string) {
  const token = newToken();
  await db
    .insertInto("crawler_tokens")
    .values({ name, token_hash: hashToken(token) })
    .execute();
  return token;
}

export async function crawlerTokenId(token: string) {
  const row = await db
    .selectFrom("crawler_tokens")
    .select("id")
    .where("token_hash", "=", hashToken(token))
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row?.id ?? null;
}

function beijingMonth(now: Date) {
  return new Date(now.getTime() + 8 * 3600_000).getUTCMonth() + 1;
}

export async function takeWork(tokenId: number, now: Date) {
  const leaseEnd = new Date(now.getTime() + LEASE_MS);
  const interval = BUSY_MONTHS.has(beijingMonth(now)) ? BUSY_INTERVAL_MS : INTERVAL_MS;
  return db.transaction().execute(async (trx) => {
    await trx
      .updateTable("crawler_tokens")
      .set({ last_seen_at: now })
      .where("id", "=", tokenId)
      .execute();

    const sources = await leaseSources(
      trx,
      now,
      new Date(now.getTime() - interval),
      leaseEnd,
      MAX_SOURCES,
    );
    const probes = await leaseProbes(trx, now, leaseEnd, MAX_PROBES);

    return {
      sources: sources.map(({ crawled_at, ...source }) => ({
        ...source,
        backfill: crawled_at === null,
      })),
      probes,
    };
  });
}

async function assertSource(trx: Transaction<DB>, sourceId: number) {
  const source = await trx
    .selectFrom("sources")
    .select("id")
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!source) throw new AppError(404, "not_found", "来源不存在");
}

async function recordUsage(
  trx: Transaction<DB>,
  purpose: "screening" | "extraction" | "probe",
  refs: { source_id?: number; snapshot_id?: number; probe_id?: number },
  usage: Usage[],
) {
  if (usage.length === 0) return;
  await trx
    .insertInto("model_calls")
    .values(usage.map((u) => ({ purpose, ...refs, ...u })))
    .execute();
}

// Saves what the list showed and returns the source's notices that still need work: new ones
// to screen; screened-in ones not yet extracted, which a round cut short leaves behind; and
// those of programs still open, not fetched for a day (design §7.4).
export async function recordListing(sourceId: number, items: ListedItem[]) {
  const now = new Date();
  return db.transaction().execute(async (trx) => {
    await assertSource(trx, sourceId);
    const inserted =
      items.length === 0
        ? []
        : await trx
            .insertInto("notices")
            .values(
              items.map((item) => ({
                source_id: sourceId,
                url: item.url,
                title: item.title,
                published_on: item.published_on ?? null,
              })),
            )
            .onConflict((oc) => oc.columns(["source_id", "url"]).doNothing())
            .returning("id")
            .execute();
    const pending = await trx
      .selectFrom("notices as n")
      .select(["n.id", "n.url", "n.title", "n.published_on", "n.screening_score"])
      .where("n.source_id", "=", sourceId)
      .where("n.removed_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("n.screening_score", "is", null),
          eb.and([
            eb("n.screened_in", "=", true),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("snapshots as s")
                  .select("s.id")
                  .whereRef("s.notice_id", "=", "n.id")
                  .where("s.extracted_at", "is not", null),
              ),
            ),
          ]),
          eb.and([
            eb("n.checked_at", "<", new Date(now.getTime() - RECHECK_MS)),
            eb.exists(
              eb
                .selectFrom("snapshots as s")
                .innerJoin("program_versions as v", "v.snapshot_id", "s.id")
                .innerJoin("programs as p", "p.id", "v.program_id")
                .select("p.id")
                .whereRef("s.notice_id", "=", "n.id")
                .where("p.deleted_at", "is", null)
                .where((qb) =>
                  qb.or([
                    qb("p.apply_deadline", ">", now),
                    qb.and([
                      qb("p.apply_deadline", "is", null),
                      qb("p.created_at", ">", new Date(now.getTime() - UNDATED_RECHECK_MS)),
                    ]),
                  ]),
                ),
            ),
          ]),
        ]),
      )
      .orderBy("n.id")
      .execute();
    return {
      new_count: inserted.length,
      pending: pending.map(({ screening_score, ...notice }) => ({
        ...notice,
        step: screening_score === null ? ("screen" as const) : ("fetch" as const),
      })),
    };
  });
}

export async function recordScreening(
  sourceId: number,
  results: { notice_id: number; score: number; screened_in: boolean }[],
  usage: Usage[],
) {
  await db.transaction().execute(async (trx) => {
    await assertSource(trx, sourceId);
    const rows = results.map(
      (r) => sql`(${r.notice_id}::integer, ${r.score}::real, ${r.screened_in}::boolean)`,
    );
    await sql`
      UPDATE notices SET screening_score = v.score, screened_in = v.screened_in
      FROM (VALUES ${sql.join(rows)}) AS v (id, score, screened_in)
      WHERE notices.id = v.id AND notices.source_id = ${sourceId}
    `.execute(trx);
    await recordUsage(trx, "screening", { source_id: sourceId }, usage);
  });
}

type AttachmentSubmission = { name: string; url: string; content_type: string; text: string };

// A new snapshot only when the words changed, the attachments' included (design §7.4).
export async function recordSnapshot(
  noticeId: number,
  submission: { fetched_at: Date; html: string; text: string; attachments: AttachmentSubmission[] },
) {
  return db.transaction().execute(async (trx) => {
    const notice = await trx
      .selectFrom("notices")
      .select(["id", "source_id", "published_on"])
      .where("id", "=", noticeId)
      .forUpdate()
      .executeTakeFirst();
    if (!notice) throw new AppError(404, "not_found", "通知不存在");

    const latest = await trx
      .selectFrom("snapshots")
      .select(["id", "text", "extracted_at"])
      .where("notice_id", "=", noticeId)
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const latestTexts =
      latest &&
      (
        await trx
          .selectFrom("attachments")
          .select("text")
          .where("snapshot_id", "=", latest.id)
          .orderBy("position")
          .execute()
      ).map((a) => a.text);
    const unchanged =
      latest !== undefined &&
      latest.text === submission.text &&
      latestTexts?.length === submission.attachments.length &&
      latestTexts.every((text, i) => text === submission.attachments[i].text);

    const snapshot = unchanged
      ? latest
      : await trx
          .insertInto("snapshots")
          .values({
            notice_id: noticeId,
            fetched_at: submission.fetched_at,
            html: submission.html,
            text: submission.text,
          })
          .returning(["id", "extracted_at"])
          .executeTakeFirstOrThrow();
    if (!unchanged && submission.attachments.length > 0) {
      await trx
        .insertInto("attachments")
        .values(
          submission.attachments.map((a, position) => ({
            snapshot_id: snapshot.id,
            position,
            ...a,
          })),
        )
        .execute();
    }
    await trx
      .updateTable("notices")
      .set({ checked_at: new Date(), removed_at: null })
      .where("id", "=", noticeId)
      .execute();

    const missing = await trx
      .selectFrom("attachments")
      .select("position")
      .where("snapshot_id", "=", snapshot.id)
      .where("data", "is", null)
      .orderBy("position")
      .execute();
    return {
      snapshot_id: snapshot.id,
      missing_files: missing.map((a) => a.position),
      extraction:
        snapshot.extracted_at === null
          ? await extractionContext(trx, notice.source_id, notice.published_on)
          : null,
    };
  });
}

// What extraction checks a notice against (design §8.2): the colleges of the school, and the
// school's programs for the cohorts a notice published that year can be about (§8.3).
// The cohorts a notice can be about run from the year it was published to two years on
// (design §8.3); a notice listed without a date counts as published today.
function noticeYear(publishedOn: string | null) {
  return Number((publishedOn ?? new Date(Date.now() + 8 * 3600_000).toISOString()).slice(0, 4));
}

async function extractionContext(
  trx: Transaction<DB>,
  sourceId: number,
  publishedOn: string | null,
) {
  const { school_id } = await trx
    .selectFrom("sources")
    .innerJoin("colleges", "colleges.id", "sources.college_id")
    .select("colleges.school_id")
    .where("sources.id", "=", sourceId)
    .executeTakeFirstOrThrow();
  const year = noticeYear(publishedOn);
  const colleges = await trx
    .selectFrom("colleges")
    .select(["id", "name"])
    .where("school_id", "=", school_id)
    .orderBy("id")
    .execute();
  const programs = await trx
    .selectFrom("programs as p")
    .innerJoin("colleges as c", "c.id", "p.college_id")
    .select(["p.id", "p.college_id", "p.cohort", "p.name", sql<Kind>`p.kind`.as("kind")])
    .select((eb) =>
      eb
        .selectFrom("program_fields as f")
        .select(sql<ApplyValue>`jsonb_object_agg(split_part(f.key, ':', 2), f.value)`.as("apply"))
        .whereRef("f.program_id", "=", "p.id")
        .where("f.key", "like", "apply:%")
        .as("apply"),
    )
    .where("c.school_id", "=", school_id)
    .where("p.deleted_at", "is", null)
    .where("p.cohort", ">=", year)
    .where("p.cohort", "<=", year + 2)
    .orderBy("p.id")
    .execute();
  return { published_on: publishedOn, colleges, programs };
}

export async function storeAttachmentFile(snapshotId: number, position: number, data: Buffer) {
  const result = await db
    .updateTable("attachments")
    .set({ data })
    .where("snapshot_id", "=", snapshotId)
    .where("position", "=", position)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw new AppError(404, "not_found", "附件不存在");
}

export async function markRemoved(noticeId: number) {
  const result = await db
    .updateTable("notices")
    .set((eb) => ({
      removed_at: eb.fn.coalesce("removed_at", sql<Date>`now()`),
      checked_at: new Date(),
    }))
    .where("id", "=", noticeId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw new AppError(404, "not_found", "通知不存在");
}

export async function recordRun(run: {
  source_id: number;
  started_at: Date;
  finished_at: Date;
  failure?: Failure;
  detail?: string;
  listed: number;
  new_count: number;
  useful_count: number;
  notice_failures: { url: string; failure: Failure; detail?: string }[];
}) {
  await db.transaction().execute(async (trx) => {
    await assertSource(trx, run.source_id);
    // Sent again after a lost response, the same round is the same row.
    await trx
      .insertInto("crawl_runs")
      .values({
        ...run,
        failure: run.failure ?? null,
        notice_failures: JSON.stringify(run.notice_failures),
      })
      .onConflict((oc) => oc.columns(["source_id", "started_at"]).doNothing())
      .execute();
    await finishSourceCrawl(trx, run.source_id, run.finished_at);
  });
}

export async function recordProbe(
  probeId: number,
  {
    usage,
    ...result
  }: {
    items: ListedItem[];
    suggested_config?: Record<string, unknown>;
    failure?: Failure;
    detail?: string;
    usage: Usage[];
  },
) {
  await db.transaction().execute(async (trx) => {
    if (await finishProbe(trx, probeId, result)) {
      await recordUsage(trx, "probe", { probe_id: probeId }, usage);
    }
  });
}

// Fields less sure than this wait on the review page (design §8.3); the extraction experiments
// will settle the number (design §8.5).
const CONFIDENT = 0.7;

export type ExtractedProgram = {
  program_id?: number;
  college_id: number;
  cohort: number;
  kind: Kind;
  name: string;
  role: Role;
  fields: ExtractedFields;
};

// Why something waits on the review page instead of going on the table (design §8.3, §8.4).
// Deciding on it means merging and versioning, so the items belong here rather than to review.
type ReviewReason =
  // a field held back from a version
  | "evidence_not_found"
  | "low_confidence"
  | "implausible"
  | "conflicts_edit"
  // a program from an extraction
  | "unknown_program"
  | "unknown_college"
  | "implausible_cohort"
  | "possible_duplicate"
  | "no_deadline";

type ReviewItem = {
  reason: ReviewReason;
  snapshot_id: number;
  program_id?: number;
  version_id?: number;
  key?: string;
  payload: Json;
};

async function holdForReview(trx: Transaction<DB>, items: ReviewItem[]) {
  if (items.length === 0) return;
  await trx
    .insertInto("review_items")
    .values(items.map((item) => ({ ...item, payload: JSON.stringify(item.payload) })))
    .execute();
}

// Quotes are looked up ignoring whitespace: extracted text and the model's copy of it break
// lines differently (design §8.3).
function squash(text: string) {
  return text.replace(/\s+/g, "");
}

export function evidenceFound(
  docs: { body: string; attachments: string[] },
  evidence: { quote: string; attachment?: number }[],
) {
  return evidence.every((e) => {
    const doc = e.attachment === undefined ? docs.body : docs.attachments.at(e.attachment);
    return doc !== undefined && squash(doc).includes(squash(e.quote));
  });
}

// Checks an extraction and merges each of its programs into versions (design §8.3, §8.4).
// Whatever can't go on the table as it is waits on the review page.
export async function recordExtraction(
  snapshotId: number,
  programs: ExtractedProgram[],
  usage: Usage[],
) {
  await db.transaction().execute(async (trx) => {
    const snapshot = await trx
      .selectFrom("snapshots as s")
      .innerJoin("notices as n", "n.id", "s.notice_id")
      .select(["s.text", "s.extracted_at", "n.source_id", "n.published_on"])
      .where("s.id", "=", snapshotId)
      .forUpdate("s")
      .executeTakeFirst();
    if (!snapshot) throw new AppError(404, "not_found", "快照不存在");
    // Sent again after a lost response: the first one counted.
    if (snapshot.extracted_at) return;

    const attachments = await trx
      .selectFrom("attachments")
      .select("text")
      .where("snapshot_id", "=", snapshotId)
      .orderBy("position")
      .execute();
    const docs = { body: snapshot.text, attachments: attachments.map((a) => a.text) };
    const context = await extractionContext(trx, snapshot.source_id, snapshot.published_on);
    const year = noticeYear(snapshot.published_on);
    const held: ReviewItem[] = [];
    for (const program of programs) {
      const hold = (reason: ReviewItem["reason"]) =>
        held.push({ reason, snapshot_id: snapshotId, payload: program });
      if (!context.colleges.some((c) => c.id === program.college_id)) hold("unknown_college");
      else if (program.cohort < year || program.cohort > year + 2) hold("implausible_cohort");
      else if (
        program.program_id !== undefined &&
        !context.programs.some((p) => p.id === program.program_id)
      ) {
        hold("unknown_program");
      } else {
        held.push(
          ...(await mergeProgram(
            trx,
            snapshotId,
            snapshot.published_on,
            docs,
            context.programs,
            program,
          )),
        );
      }
    }
    await holdForReview(trx, held);
    await trx
      .updateTable("snapshots")
      .set({ extracted_at: new Date() })
      .where("id", "=", snapshotId)
      .execute();
    await recordUsage(
      trx,
      "extraction",
      { source_id: snapshot.source_id, snapshot_id: snapshotId },
      usage,
    );
  });
}

async function mergeProgram(
  trx: Transaction<DB>,
  snapshotId: number,
  publishedOn: string | null,
  docs: { body: string; attachments: string[] },
  candidates: { college_id: number; cohort: number; kind: Kind }[],
  program: ExtractedProgram,
) {
  const held: ReviewItem[] = [];
  let programId = program.program_id;
  if (programId === undefined) {
    programId = await createProgram(trx, program);
    // A second batch is a program of its own (design §8.2), but so is a program the model
    // failed to recognise; a person tells them apart.
    if (
      candidates.some(
        (c) =>
          c.college_id === program.college_id &&
          c.cohort === program.cohort &&
          c.kind === program.kind,
      )
    ) {
      held.push({
        reason: "possible_duplicate",
        snapshot_id: snapshotId,
        program_id: programId,
        payload: program,
      });
    }
  }
  // One version at a time per program, so their numbers don't collide.
  await trx.selectFrom("programs").select("id").where("id", "=", programId).forUpdate().execute();
  const { number } = await trx
    .selectFrom("program_versions")
    .select(sql<number>`coalesce(max(number), 0) + 1`.as("number"))
    .where("program_id", "=", programId)
    .executeTakeFirstOrThrow();
  const version = await trx
    .insertInto("program_versions")
    .values({
      program_id: programId,
      snapshot_id: snapshotId,
      number,
      role: program.role,
      fields: JSON.stringify(program.fields),
      changes: [],
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const end = program.fields.apply?.value.end;
  const implausible =
    end !== undefined && publishedOn !== null && deadlineOf(end) <= startOf({ date: publishedOn });
  const accepted = [];
  for (const row of toStoredFields(program.fields)) {
    const reason = !evidenceFound(docs, row.evidence)
      ? "evidence_not_found"
      : row.confidence < CONFIDENT
        ? "low_confidence"
        : row.key.startsWith("apply:") && implausible
          ? "implausible"
          : null;
    if (reason === null) accepted.push(row);
    else held.push(fieldItem(reason, snapshotId, programId, version.id, row));
  }
  const { changed, conflicts } = await applyStored(trx, programId, version.id, accepted);
  for (const row of conflicts) {
    held.push(fieldItem("conflicts_edit", snapshotId, programId, version.id, row));
  }
  await trx
    .updateTable("program_versions")
    .set({ changes: changed })
    .where("id", "=", version.id)
    .execute();

  if (program.role === "call") {
    const { apply_deadline } = await trx
      .selectFrom("programs")
      .select("apply_deadline")
      .where("id", "=", programId)
      .executeTakeFirstOrThrow();
    const asked = await trx
      .selectFrom("review_items")
      .select("id")
      .where("program_id", "=", programId)
      .where("reason", "=", "no_deadline")
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (apply_deadline === null && !asked) {
      held.push({
        reason: "no_deadline",
        snapshot_id: snapshotId,
        program_id: programId,
        version_id: version.id,
        payload: program,
      });
    }
  }
  return held;
}

function fieldItem(
  reason: ReviewItem["reason"],
  snapshotId: number,
  programId: number,
  versionId: number,
  { key, ...entry }: StoredField,
): ReviewItem {
  return {
    reason,
    snapshot_id: snapshotId,
    program_id: programId,
    version_id: versionId,
    key,
    payload: entry,
  };
}
