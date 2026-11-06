import asyncio
import json

import httpx
import pytest

from crawler.crawl.contract import PendingNotice, ScreeningResult, Usage
from crawler.crawl.fetch import Fetcher
from crawler.crawl.rounds import NoticePage, Steps, crawl_source
from crawler.crawl.rounds_test import ITEMS, SOURCE, FakeWebsite, extract, list_items
from crawler.crawl.website import Website
from crawler.screening.screen import THRESHOLD, Screen, ScreeningError
from crawler.screening.system_one import SystemOne


def response(score: float) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": "Kev-4b",
            "answers": {"relevant": {"type": "noul", "noul": score}},
            "usage": {"input_tokens": 20, "output_tokens": 1},
        },
    )


def test_batch_preserves_notice_mapping_threshold_boundary_and_usage() -> None:
    async def run() -> tuple[list[ScreeningResult], list[Usage]]:
        first_started = asyncio.Event()

        def handle(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert body["state"]["section"] == SOURCE.section
            title = body["state"]["title"]
            return response(THRESHOLD if title == "At threshold" else THRESHOLD - 0.0001)

        async def out_of_order(request: httpx.Request) -> httpx.Response:
            if json.loads(request.content)["state"]["title"] == "At threshold":
                await first_started.wait()
            else:
                first_started.set()
            return handle(request)

        provider = SystemOne("local-test", httpx.MockTransport(out_of_order))
        notices = [
            PendingNotice(
                id=n,
                url=f"https://example.edu.cn/{n}",
                title=title,
                published_on=None,
                step="screen",
            )
            for n, title in [(11, "At threshold"), (12, "Below threshold")]
        ]
        try:
            return await Screen(provider)(SOURCE, notices)
        finally:
            await provider.close()

    results, usage = asyncio.run(run())
    assert [(r.notice_id, r.screened_in) for r in results] == [(11, True), (12, False)]
    assert sum(u.input_tokens for u in usage) == 40
    assert sum(u.output_tokens for u in usage) == 2
    assert {u.model for u in usage} == {"Kev-4b"}


@pytest.mark.parametrize("fails", [False, True])
def test_real_screen_in_round_fetches_only_passed_and_never_submits_partial_results(
    fails: bool,
) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["state"]["title"] == ITEMS[1].title:
            return httpx.Response(503, text="do-not-log-provider-body") if fails else response(0.1)
        return response(0.9)

    site = FakeWebsite(
        [
            {"id": i, "url": item.url, "title": item.title, "published_on": None, "step": "screen"}
            for i, item in enumerate(ITEMS[:2], 1)
        ],
        extracted=frozenset(),
    )
    read_urls: list[str] = []

    async def read(_fetcher: Fetcher, _source: object, url: str) -> NoticePage:
        read_urls.append(url)
        return NoticePage(html="<p>Text</p>", text="Text", attachments=[])

    async def run() -> None:
        provider = SystemOne("local-test", httpx.MockTransport(handle))
        try:
            screen = Screen(provider)
            async with (
                Fetcher(httpx.MockTransport(lambda _: httpx.Response(500))) as fetcher,
                Website("http://site", "local-test", httpx.MockTransport(site.handle)) as website,
            ):
                await crawl_source(
                    SOURCE, fetcher, website, Steps(list_items, screen, read, extract)
                )
        finally:
            await provider.close()

    if fails:
        with pytest.raises(ScreeningError, match="http_503"):
            asyncio.run(run())
        assert site.called("POST /sources/7/screening") == []
        assert site.called("POST /runs") == []
        assert read_urls == []
    else:
        asyncio.run(run())
        assert read_urls == [ITEMS[0].url]
        [sent] = site.called("POST /sources/7/screening")
        assert [r["screened_in"] for r in sent["results"]] == [True, False]
        assert sum(u["input_tokens"] for u in sent["usage"]) == 40
        assert len(site.called("POST /runs")) == 1
