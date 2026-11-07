import asyncio
import json

import httpx
import pytest

from crawler.crawl.contract import PendingNotice, ScreeningResult, Usage, WorkSource
from crawler.screening.screen import THRESHOLD, Screen, ScreeningError
from crawler.screening.system_one import SystemOne


def source() -> WorkSource:
    return WorkSource(
        id=7,
        url="https://example.edu.cn",
        section="招生",
        browser=False,
        config=None,
        backfill=False,
    )


def response(score: float) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": "SemIf",
            "answers": {"relevant": {"type": "noul", "noul": score}},
            "usage": {"input_tokens": 20, "output_tokens": 1},
        },
    )


def test_batch_preserves_notice_mapping_threshold_boundary_and_usage() -> None:
    async def run() -> tuple[list[ScreeningResult], list[Usage]]:
        first_started = asyncio.Event()

        def handle(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            assert "section" not in body["state"]
            assert body["model"] == "SemIf"
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
            return await Screen(provider)(source(), notices)
        finally:
            await provider.close()

    results, usage = asyncio.run(run())
    assert [(r.notice_id, r.screened_in) for r in results] == [(11, True), (12, False)]
    assert sum(u.input_tokens for u in usage) == 40
    assert sum(u.output_tokens for u in usage) == 2
    assert {u.model for u in usage} == {"SemIf"}


def test_provider_failure_raises_screening_error() -> None:
    async def run() -> None:
        provider = SystemOne(
            "local-test", httpx.MockTransport(lambda _: httpx.Response(503, text="private body"))
        )
        try:
            await Screen(provider)(
                source(),
                [
                    PendingNotice(
                        id=1,
                        url="https://example.edu.cn/1",
                        title="Example",
                        published_on=None,
                        step="screen",
                    )
                ],
            )
        finally:
            await provider.close()

    with pytest.raises(ScreeningError, match="http_503"):
        asyncio.run(run())
