import { sql } from "kysely";
import { db, pageOf } from "../../platform/db.ts";
import { unix } from "../../platform/http.ts";
import { beijingDay } from "../programs/time.ts";
import type { Failure } from "../sources/schemas.ts";
import type { AttachmentFailure, NoticeFailure } from "./schemas.ts";
import { BUSY_MONTHS, type Purpose } from "./service.ts";

// The crawl dashboard (design §7.5): how each source's rounds went on a day, Beijing time.

const DAY_MS = 24 * 3600_000;
// A site that keeps failing, or that gives nothing new for this long in the busy months, has
// likely changed and needs its config looked at (design §7.5).
const FAILING_ROUNDS = 2;
const STALE_MS = 30 * DAY_MS;
// A round can report thousands of notices or attachments it couldn't fetch, mostly for one reason;
// the first few show it.
const FAILURES_SHOWN = 20;
const firstFailures = (column: "notice_failures" | "attachment_failures") =>
  sql`jsonb_path_query_array(${sql.ref(column)}, ${`$[0 to ${FAILURES_SHOWN - 1}]`}::jsonpath)`;
// A source's first round can find hundreds of notices; the ones with programs come first.
const NEW_SHOWN = 20;
const CLOCKS_APART = "1 minute";

export async function crawlDay(query: {
  date?: string;
  source_id?: number;
  page: number;
  per_page: number;
}) {
  const date = query.date ?? beijingDay(new Date());
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
        firstFailures("notice_failures").$castTo<NoticeFailure[]>().as("notice_failures"),
        sql<number>`jsonb_array_length(notice_failures)`.as("notice_failure_count"),
        firstFailures("attachment_failures")
          .$castTo<AttachmentFailure[]>()
          .as("attachment_failures"),
        "attachment_failure_count",
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

  // What each round saw first: the list it sent came in while it ran. Its times are the crawler's
  // to the second, the notices' the website's, so a minute either side, short of the rounds
  // before and after: one can start right after another at 18:00 (service.ts). A round still
  // running, not yet reported, claims nothing.
  const runIds = runs.map((run) => run.id);
  const [found, titles] = await Promise.all([
    sql<{ run_id: number; title: string; url: string; programs: { id: number; name: string }[] }>`
      select r.id as run_id, seen.title, seen.url, seen.programs
      from crawl_runs r
      cross join lateral (
        select * from (
          select n.id, n.title, n.url, n.published_on, coalesce((
            select jsonb_agg(distinct jsonb_build_object('id', p.id, 'name', p.name))
            from snapshots s
            join program_versions v on v.snapshot_id = s.id
            join programs p on p.id = v.program_id
            where s.notice_id = n.id and p.deleted_at is null
          ), '[]') as programs
          from notices n
          where n.source_id = r.source_id
            and n.first_seen_at >= greatest(
              r.started_at - ${CLOCKS_APART}::interval,
              least(
                coalesce((
                  select max(earlier.finished_at) from crawl_runs earlier
                  where earlier.source_id = r.source_id and earlier.started_at < r.started_at
                ), '-infinity') + ${CLOCKS_APART}::interval,
                r.started_at
              )
            )
            and n.first_seen_at < least(
              r.finished_at + ${CLOCKS_APART}::interval,
              coalesce((
                select min(later.started_at) from crawl_runs later
                where later.source_id = r.source_id and later.started_at > r.started_at
              ), 'infinity')
            )
        ) as notice
        order by programs = '[]', published_on desc nulls last, id
        limit least(r.new_count, ${NEW_SHOWN})
      ) as seen
      where r.id = any(${runIds})
    `
      .execute(db)
      .then((result) => result.rows),
    // The failures name their notices by address; their titles read better.
    db
      .selectFrom("notices")
      .select(["source_id", "url", "title"])
      .where(sql<boolean>`source_id = any(${ids})`)
      .where(
        sql<boolean>`url = any(${[
          ...new Set(
            runs.flatMap((run) => [
              ...run.notice_failures.map((failure) => failure.url),
              ...run.attachment_failures.map((failure) => failure.notice_url),
            ]),
          ),
        ]})`,
      )
      .execute(),
  ]);
  const titleOf = (sourceId: number, url: string) =>
    titles.find((notice) => notice.source_id === sourceId && notice.url === url)?.title ?? null;

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
          new_notices: found
            .filter((notice) => notice.run_id === run.id)
            .map(({ title, url, programs }) => ({ title, url, programs })),
          notice_failures: run.notice_failures.map((failure) => ({
            ...failure,
            title: titleOf(source.id, failure.url),
          })),
          attachment_failures: run.attachment_failures.map((failure) => ({
            ...failure,
            notice_title: titleOf(source.id, failure.notice_url),
          })),
        })),
      usage: {
        input_tokens: used(source.id)?.input_tokens ?? 0,
        output_tokens: used(source.id)?.output_tokens ?? 0,
      },
    })),
  };
}
