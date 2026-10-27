"""One source's round, as docs/api.md §6 lays it out: list, screen the new notices, fetch the ones
that need it, extract, and report the round. The steps that read pages and ask models come in as
`Steps`, so each is written and tested on its own and the round stays the same."""

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from crawler.crawl.contract import (
    AttachmentInfo,
    ExtractedProgram,
    Extraction,
    ExtractionContext,
    Failure,
    ListedItem,
    Listing,
    NoticeFailure,
    PendingNotice,
    Run,
    Screening,
    ScreeningResult,
    Snapshot,
    Usage,
    WorkSource,
)
from crawler.crawl.fetch import Fetcher, FetchError
from crawler.crawl.website import Website

logger = logging.getLogger(__name__)


class StepError(Exception):
    """A step that couldn't do its part, in the terms of the crawl records (docs/api.md §6)."""

    def __init__(self, failure: Failure, detail: str | None = None) -> None:
        super().__init__(failure if detail is None else f"{failure}: {detail}")
        self.failure: Failure = failure
        self.detail = detail


@dataclass(frozen=True)
class Attachment:
    info: AttachmentInfo
    data: bytes


@dataclass(frozen=True)
class NoticePage:
    html: str
    # The words of the notice; extraction quotes them, so they are what the reader sees.
    text: str
    # In the order they appear; evidence refers to them by position.
    attachments: list[Attachment]


@dataclass(frozen=True)
class Steps:
    # The items on the source's list page, paging back two years when it is new (design §7.1).
    list_items: Callable[[Fetcher, WorkSource], Awaitable[list[ListedItem]]]
    # A score for each notice by its title and the list's section (design §8.1).
    screen: Callable[
        [WorkSource, list[PendingNotice]], Awaitable[tuple[list[ScreeningResult], list[Usage]]]
    ]
    # A notice's page with its attachments downloaded and read; None when the page answers
    # 404 or 410 (design §7.4).
    read: Callable[[Fetcher, WorkSource, str], Awaitable[NoticePage | None]]
    # The programs a notice is about (design §8.2).
    extract: Callable[
        [NoticePage, ExtractionContext], Awaitable[tuple[list[ExtractedProgram], list[Usage]]]
    ]


def _failure(error: FetchError | StepError) -> tuple[Failure, str | None]:
    if isinstance(error, StepError):
        return error.failure, error.detail
    return error.failure, error.url


async def crawl_source(
    source: WorkSource,
    fetcher: Fetcher,
    website: Website,
    steps: Steps,
    clock: Callable[[], float] = time.time,
) -> None:
    started_at = int(clock())
    try:
        items = await steps.list_items(fetcher, source)
        if not items:
            raise StepError("no_items")
    except (FetchError, StepError) as error:
        logger.warning("Listing failed: %s", error, extra={"source_id": source.id})
        failure, detail = _failure(error)
        await website.run(
            Run(
                source_id=source.id,
                started_at=started_at,
                finished_at=int(clock()),
                failure=failure,
                detail=detail,
                listed=0,
                new_count=0,
                useful_count=0,
                notice_failures=[],
            )
        )
        return

    listing = await website.listing(source.id, Listing(items=items))
    new = [notice for notice in listing.pending if notice.step == "screen"]
    to_fetch = [notice for notice in listing.pending if notice.step == "fetch"]
    if new:
        results, usage = await steps.screen(source, new)
        await website.screening(source.id, Screening(results=results, usage=usage))
        screened_in = {result.notice_id for result in results if result.screened_in}
        to_fetch += [notice for notice in new if notice.id in screened_in]

    useful = 0
    failures: list[NoticeFailure] = []
    for notice in to_fetch:
        try:
            programs = await _fetch_notice(notice, source, fetcher, website, steps, clock)
        except (FetchError, StepError) as error:
            logger.warning("Fetching a notice failed: %s", error, extra={"url": notice.url})
            failure, detail = _failure(error)
            failures.append(NoticeFailure(url=notice.url, failure=failure, detail=detail))
            continue
        if programs and notice.step == "screen":
            useful += 1

    await website.run(
        Run(
            source_id=source.id,
            started_at=started_at,
            finished_at=int(clock()),
            listed=len(items),
            new_count=listing.new_count,
            useful_count=useful,
            notice_failures=failures,
        )
    )


# Returns how many programs the notice turned out to be about; none when it was gone,
# unchanged, or about nothing.
async def _fetch_notice(
    notice: PendingNotice,
    source: WorkSource,
    fetcher: Fetcher,
    website: Website,
    steps: Steps,
    clock: Callable[[], float],
) -> int:
    page = await steps.read(fetcher, source, notice.url)
    if page is None:
        await website.removed(notice.id)
        return 0
    result = await website.snapshot(
        notice.id,
        Snapshot(
            fetched_at=int(clock()),
            html=page.html,
            text=page.text,
            attachments=[attachment.info for attachment in page.attachments],
        ),
    )
    for position in result.missing_files:
        await website.attachment(result.snapshot_id, position, page.attachments[position].data)
    if result.extraction is None:
        return 0
    programs, usage = await steps.extract(page, result.extraction)
    await website.extraction(result.snapshot_id, Extraction(programs=programs, usage=usage))
    return len(programs)
