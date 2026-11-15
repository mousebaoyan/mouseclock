import asyncio
import json

import httpx
import pytest

from crawler.crawl.contract import PendingNotice, ScreeningResult, Usage, WorkSource
from crawler.crawl.rounds import StepError
from crawler.screening.screen import CONCURRENCY, THRESHOLD, Screen
from crawler.screening.system_one import SystemOne


def source() -> WorkSource:
    return WorkSource(
        id=7,
        url="https://example.edu.cn",
        browser=False,
        config=None,
        backfill=False,
    )


def response(score: float) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": "ecnu-decision",
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
            assert body["model"] == "ecnu-decision"
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
        usage: list[Usage] = []
        try:
            return await Screen(provider)(source(), notices, usage), usage
        finally:
            await provider.close()

    results, usage = asyncio.run(run())
    assert [(r.notice_id, r.screened_in) for r in results] == [(11, True), (12, False)]
    assert sum(u.input_tokens for u in usage) == 40
    assert sum(u.output_tokens for u in usage) == 2
    assert {u.model for u in usage} == {"ecnu-decision"}


def test_provider_failure_fails_the_screening_and_keeps_what_it_cost_so_far() -> None:
    # What the round has to report when the screening fails.
    spent: list[Usage] = []
    titles: list[str] = []

    async def run() -> None:
        failed = asyncio.Event()

        async def handle(request: httpx.Request) -> httpx.Response:
            title = json.loads(request.content)["state"]["title"]
            titles.append(title)
            if title == "fails":
                failed.set()
                # It answered, and costs what it says, but the answer is no good.
                return httpx.Response(
                    200,
                    json={
                        "model": "ecnu-decision",
                        "answers": {},
                        "usage": {"input_tokens": 20, "output_tokens": 1},
                    },
                )
            # The other call in its chunk comes back after the failure.
            await failed.wait()
            for _ in range(20):
                await asyncio.sleep(0)
            return response(0.5)

        provider = SystemOne("local-test", httpx.MockTransport(handle))
        notices = [
            PendingNotice(
                id=n,
                url=f"https://example.edu.cn/{n}",
                title=title,
                published_on=None,
                step="screen",
            )
            for n, title in enumerate(["fails", "late", "next chunk"])
        ]
        usage: list[Usage] = []
        try:
            with pytest.raises(StepError, match="invalid_response"):
                await Screen(provider)(source(), notices, usage)
            spent.extend(usage)
        finally:
            await provider.close()

    asyncio.run(run())
    assert [u.input_tokens for u in spent] == [20, 20]
    assert "next chunk" not in titles


def test_rounds_sharing_a_screen_share_its_limit() -> None:
    in_flight = 0
    most = 0

    async def handle(_request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, most
        in_flight += 1
        most = max(most, in_flight)
        # Lets every other call that can start get as far as here first.
        for _ in range(20):
            await asyncio.sleep(0)
        in_flight -= 1
        return response(0.5)

    async def run() -> None:
        provider = SystemOne("local-test", httpx.MockTransport(handle))
        screen = Screen(provider)
        notices = [
            PendingNotice(
                id=n, url=f"https://example.edu.cn/{n}", title="t", published_on=None, step="screen"
            )
            for n in range(4)
        ]
        try:
            await asyncio.gather(
                screen(source(), notices[:2], []), screen(source(), notices[2:], [])
            )
        finally:
            await provider.close()

    asyncio.run(run())
    assert most == CONCURRENCY
