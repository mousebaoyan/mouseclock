import { sql } from "kysely";
import { db, pageOf } from "../../platform/db.ts";
import { unix } from "../../platform/http.ts";
import type { Failure } from "../sources/schemas.ts";
import { BUSY_MONTHS, type Purpose } from "./service.ts";

// The crawl dashboard (design §7.5): how each source's rounds went on a day, Beijing time.

const DAY_MS = 24 * 3600_000;
// A site that keeps failing, or that gives nothing new for this long in the busy months, has
// likely changed and needs its config looked at (design §7.5).
const FAILING_ROUNDS = 2;
const STALE_MS = 30 * DAY_MS;
// A round can report thousands of notices it couldn't fetch, mostly for one reason; the first
// few show it.
const NOTICE_FAILURES_SHOWN = 20;

type NoticeFailure = { url: string; failure: Failure; detail?: string };

function beijingToday(now: Date) {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export async function crawlDay(query: {
  date?: string;
  source_id?: number;
  page: number;
  per_page: number;
}) {
  const date = query.date ?? beijingToday(new Date());
  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(start.getTime() + DAY_MS);

  // The latest rounds up to the day's end all failed to read the list.
  const failing = sql<boolean>`(
    select count(*) filter (where failure is not null) = ${FAILING_ROUNDS}
    from (
      select failure from crawl_runs
      where source_id = sources.id and started_at < ${end}
      order by started_at desc
      limit ${FAILING_ROUNDS}
    ) as latest
  )`;
  const stale = BUSY_MONTHS.has(Number(date.slice(5, 7)))
    ? sql<boolean>`not exists (
        select from notices
        where source_id = sources.id
          and first_seen_at >= ${new Date(end.getTime() - STALE_MS)}
          and first_seen_at < ${end}
      )`
    : sql<boolean>`false`;

  let crawled = db
    .selectFrom("sources")
    .innerJoin("colleges", "colleges.id", "sources.college_id")
    .innerJoin("schools", "schools.id", "colleges.school_id")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("crawl_runs")
          .select("crawl_runs.id")
          .whereRef("crawl_runs.source_id", "=", "sources.id")
          .where("crawl_runs.started_at", ">=", start)
          .where("crawl_runs.started_at", "<", end),
      ),
    );
  if (query.source_id !== undefined) crawled = crawled.where("sources.id", "=", query.source_id);

  const [page, counts, usage, crawler] = await Promise.all([
    pageOf(
      crawled
        .select([
          "sources.id",
          "sources.url",
          "sources.section",
          "colleges.name as college",
          "schools.name as school",
          failing.as("failing"),
          stale.as("stale"),
        ])
        .orderBy("failing", "desc")
        .orderBy("stale", "desc")
        .orderBy("sources.id"),
      query,
    ),
    db
      .selectFrom(crawled.select([failing.as("failing"), stale.as("stale")]).as("flagged"))
      .select([
        sql<number>`count(*) filter (where failing)`.as("failing"),
        sql<number>`count(*) filter (where stale)`.as("stale"),
      ])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("model_calls")
      .select([
        sql<Purpose>`purpose`.as("purpose"),
        "model",
        (eb) => eb.fn.countAll<number>().as("calls"),
        sql<number>`sum(input_tokens)`.as("input_tokens"),
        sql<number>`sum(output_tokens)`.as("output_tokens"),
      ])
      .where("created_at", ">=", start)
      .where("created_at", "<", end)
      .groupBy(["purpose", "model"])
      .orderBy("purpose")
      .orderBy("model")
      .execute(),
    db
      .selectFrom("crawler_tokens")
      .select((eb) => eb.fn.max("last_seen_at").as("seen_at"))
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow(),
  ]);

  const ids = page.items.map((source) => source.id);
  const [runs, sourceUsage] = await Promise.all([
    db
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
        sql<NoticeFailure[]>`jsonb_path_query_array(
          notice_failures, ${`$[0 to ${NOTICE_FAILURES_SHOWN - 1}]`}::jsonpath
        )`.as("notice_failures"),
        sql<number>`jsonb_array_length(notice_failures)`.as("notice_failure_count"),
      ])
      .where(sql<boolean>`source_id = any(${ids})`)
      .where("started_at", ">=", start)
      .where("started_at", "<", end)
      .orderBy("started_at")
      .execute(),
    db
      .selectFrom("model_calls")
      .select([
        "source_id",
        sql<number>`sum(input_tokens)`.as("input_tokens"),
        sql<number>`sum(output_tokens)`.as("output_tokens"),
      ])
      .where(sql<boolean>`source_id = any(${ids})`)
      .where("created_at", ">=", start)
      .where("created_at", "<", end)
      .groupBy("source_id")
      .execute(),
  ]);

  const used = (id: number) => sourceUsage.find((row) => row.source_id === id);
  return {
    date,
    crawler_seen_at: crawler.seen_at ? unix(crawler.seen_at) : null,
    usage,
    ...counts,
    ...page,
    items: page.items.map((source) => ({
      ...source,
      runs: runs
        .filter((run) => run.source_id === source.id)
        .map(({ started_at, finished_at, ...run }) => ({
          ...run,
          started_at: unix(started_at),
          finished_at: unix(finished_at),
        })),
      usage: {
        input_tokens: used(source.id)?.input_tokens ?? 0,
        output_tokens: used(source.id)?.output_tokens ?? 0,
      },
    })),
  };
}
