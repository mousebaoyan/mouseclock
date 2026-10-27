import asyncio
import json
import re
from typing import Any

import httpx

from crawler.crawl.contract import (
    AttachmentInfo,
    ExtractedFields,
    ExtractedProgram,
    ExtractionContext,
    ListedItem,
    PendingNotice,
    ScreeningResult,
    Usage,
    WorkSource,
)
from crawler.crawl.fetch import Fetcher, FetchError
from crawler.crawl.rounds import Attachment, NoticePage, StepError, Steps, crawl_source
from crawler.crawl.website import Website

SOURCE = WorkSource(
    id=7, url="http://a/list.htm", section="通知公告", browser=False, config=None, backfill=False
)
ITEMS = [ListedItem(url=f"http://a/{n}.htm", title=f"通知 {n}") for n in range(1, 5)]
CONTEXT = ExtractionContext(published_on=None, colleges=[], programs=[])
USAGE = [Usage(model="m", input_tokens=10, output_tokens=1)]


def pending(notice_id: int, step: str) -> dict[str, Any]:
    url = f"http://a/{notice_id}.htm"
    return {"id": notice_id, "url": url, "title": "t", "published_on": None, "step": step}


class FakeWebsite:
    """The website's crawler API: answers `pending` to the listing, asks to extract snapshots of
    notices not in `extracted`, and records each call."""

    def __init__(self, pending: list[dict[str, Any]], extracted: frozenset[int]) -> None:
        self.pending = pending
        self.extracted = extracted
        self.calls: list[tuple[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1/crawler")
        sent_json = request.headers.get("content-type") == "application/json"
        body: Any = json.loads(request.content) if sent_json else request.content
        self.calls.append((f"{request.method} {path}", body))
        if path.endswith("/listing"):
            return httpx.Response(200, json={"new_count": 2, "pending": self.pending})
        if match := re.fullmatch(r"/notices/(\d+)/snapshot", path):
            notice = int(match[1])
            return httpx.Response(
                200,
                json={
                    "snapshot_id": notice * 10,
                    "missing_files": list(range(len(body["attachments"]))),
                    "extraction": None
                    if notice in self.extracted
                    else CONTEXT.model_dump(mode="json"),
                },
            )
        return httpx.Response(204)

    def run(self, steps: Steps) -> None:
        async def main() -> None:
            nowhere = httpx.MockTransport(lambda _: httpx.Response(500))
            async with (
                Fetcher(nowhere) as fetcher,
                Website("http://site", "token", httpx.MockTransport(self.handle)) as website,
            ):
                await crawl_source(SOURCE, fetcher, website, steps, clock=lambda: 1_800_000_000)

        asyncio.run(main())

    def called(self, prefix: str) -> list[Any]:
        return [body for call, body in self.calls if call.startswith(prefix)]


async def list_items(_fetcher: Fetcher, _source: WorkSource) -> list[ListedItem]:
    return ITEMS


async def screen(
    _source: WorkSource, notices: list[PendingNotice]
) -> tuple[list[ScreeningResult], list[Usage]]:
    results = [
        ScreeningResult(notice_id=n.id, score=0.9 if n.id == 1 else 0.1, screened_in=n.id == 1)
        for n in notices
    ]
    return results, USAGE


def page(text: str, files: int = 0) -> NoticePage:
    attachments = [
        Attachment(
            AttachmentInfo(name=f"{n}.pdf", url=f"http://a/{n}.pdf", content_type="pdf", text="表"),
            b"%PDF",
        )
        for n in range(files)
    ]
    return NoticePage(html=f"<p>{text}</p>", text=text, attachments=attachments)


async def extract(
    _page: NoticePage, _context: ExtractionContext
) -> tuple[list[ExtractedProgram], list[Usage]]:
    program = ExtractedProgram(
        college_id=1,
        cohort=2028,
        kind="winter_camp",
        name="冬令营",
        role="call",
        fields=ExtractedFields(),
    )
    return [program], USAGE


def test_a_round_screens_the_new_fetches_what_needs_it_and_reports() -> None:
    # 1 and 2 are new; 3 is a program still open, whose page hasn't changed; 4 has gone.
    site = FakeWebsite(
        [pending(1, "screen"), pending(2, "screen"), pending(3, "fetch"), pending(4, "fetch")],
        extracted=frozenset({3}),
    )

    async def read(_fetcher: Fetcher, _source: WorkSource, url: str) -> NoticePage | None:
        return {"http://a/1.htm": page("冬令营", files=1), "http://a/3.htm": page("夏令营")}.get(
            url
        )

    site.run(Steps(list_items, screen, read, extract))

    assert [call for call, _ in site.calls] == [
        "POST /sources/7/listing",
        "POST /sources/7/screening",
        "POST /notices/3/snapshot",
        "POST /notices/4/removed",
        "POST /notices/1/snapshot",
        "PUT /snapshots/10/attachments/0",
        "POST /snapshots/10/extraction",
        "POST /runs",
    ]
    [screening] = site.called("POST /sources/7/screening")
    assert [r["screened_in"] for r in screening["results"]] == [True, False]
    [snapshot] = site.called("POST /notices/1/snapshot")
    assert snapshot["fetched_at"] == 1_800_000_000
    assert snapshot["attachments"][0] == {
        "name": "0.pdf",
        "url": "http://a/0.pdf",
        "content_type": "pdf",
        "text": "表",
    }
    assert site.called("PUT /snapshots/10/attachments/0") == [b"%PDF"]
    [run] = site.called("POST /runs")
    assert run == {
        "source_id": 7,
        "started_at": 1_800_000_000,
        "finished_at": 1_800_000_000,
        "listed": 4,
        "new_count": 2,
        "useful_count": 1,
        "notice_failures": [],
    }


def test_notices_that_fail_are_reported_and_the_round_goes_on() -> None:
    site = FakeWebsite(
        [pending(1, "fetch"), pending(2, "fetch"), pending(3, "fetch")], extracted=frozenset()
    )

    async def read(_fetcher: Fetcher, _source: WorkSource, url: str) -> NoticePage | None:
        if url == "http://a/1.htm":
            raise FetchError("timeout", url)
        if url == "http://a/2.htm":
            raise StepError("http_status", "HTTP 403")
        return page("冬令营")

    site.run(Steps(list_items, screen, read, extract))

    assert len(site.called("POST /snapshots/30/extraction")) == 1
    [run] = site.called("POST /runs")
    assert run["notice_failures"] == [
        {"url": "http://a/1.htm", "failure": "timeout", "detail": "http://a/1.htm"},
        {"url": "http://a/2.htm", "failure": "http_status", "detail": "HTTP 403"},
    ]


def test_a_list_that_cant_be_read_ends_the_round_with_the_reason() -> None:
    async def unreachable(_fetcher: Fetcher, source: WorkSource) -> list[ListedItem]:
        raise FetchError("unreachable", source.url)

    async def empty(_fetcher: Fetcher, _source: WorkSource) -> list[ListedItem]:
        return []

    async def unused(*_: object) -> Any:
        raise AssertionError

    for list_step, failure in [(unreachable, "unreachable"), (empty, "no_items")]:
        site = FakeWebsite([], extracted=frozenset())
        site.run(Steps(list_step, unused, unused, unused))

        assert [call for call, _ in site.calls] == ["POST /runs"]
        [run] = site.called("POST /runs")
        assert run["failure"] == failure
        assert run["listed"] == 0
