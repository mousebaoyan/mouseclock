import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable
from itertools import pairwise
from urllib.parse import urlsplit

import httpx
import pytest

from crawler.crawl.fetch import INTERVAL, USER_AGENT, Fetcher, FetchError


class FakeSites:
    """Serves `pages` (URL to response) and records each request with the fake time it began."""

    def __init__(self, pages: dict[str, httpx.Response]) -> None:
        self.pages = pages
        self.now = 0.0
        self.requests: list[tuple[float, str]] = []
        self.in_flight: Counter[str] = Counter()
        self.most_in_flight: Counter[str] = Counter()
        self.most_hosts_in_flight = 0

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds
        await asyncio.sleep(0)

    async def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["user-agent"] == USER_AGENT
        url = str(request.url)
        host = urlsplit(url).netloc
        self.requests.append((self.now, url))
        self.in_flight[host] += 1
        self.most_in_flight[host] = max(self.most_in_flight[host], self.in_flight[host])
        busy = sum(1 for n in self.in_flight.values() if n)
        self.most_hosts_in_flight = max(self.most_hosts_in_flight, busy)
        await asyncio.sleep(0)
        self.in_flight[host] -= 1
        return self.pages.get(url, httpx.Response(404))

    def times(self, host: str) -> list[float]:
        return [t for t, url in self.requests if urlsplit(url).netloc == host]

    def run[T](self, use: Callable[[Fetcher], Awaitable[T]]) -> T:
        async def main() -> T:
            async with Fetcher(httpx.MockTransport(self.handle), self.clock, self.sleep) as fetcher:
                return await use(fetcher)

        return asyncio.run(main())


def gaps(times: list[float]) -> list[float]:
    return [b - a for a, b in pairwise(times)]


def test_one_request_at_a_time_per_site_with_a_pause() -> None:
    sites = FakeSites(
        {url: httpx.Response(200) for url in ("http://a/1", "http://a/2", "http://b/1")}
    )

    sites.run(
        lambda f: asyncio.gather(f.get("http://a/1"), f.get("http://a/2"), f.get("http://b/1"))
    )

    # b doesn't wait for a.
    assert len(sites.times("a")) == 2
    assert all(gap >= INTERVAL for gap in gaps(sites.times("a")))
    assert sites.most_in_flight["a"] == 1
    assert sites.most_hosts_in_flight == 2


def test_a_redirect_to_another_site_waits_its_turn_there() -> None:
    sites = FakeSites(
        {
            "http://a/old": httpx.Response(301, headers={"location": "http://b/new"}),
            "http://b/1": httpx.Response(200),
            "http://b/new": httpx.Response(200),
        }
    )

    moved = sites.run(lambda f: asyncio.gather(f.get("http://b/1"), f.get("http://a/old")))[1]

    assert moved.url == "http://b/new"
    assert len(sites.times("b")) == 2
    assert all(gap >= INTERVAL for gap in gaps(sites.times("b")))


def test_cancelling_the_interval_wait_does_not_mark_a_request_finished() -> None:
    async def run() -> None:
        sites = FakeSites({})
        waiting = asyncio.Event()
        waits: list[float] = []
        block = True

        async def sleep(seconds: float) -> None:
            waits.append(seconds)
            if block:
                waiting.set()
                await asyncio.Future[None]()
            sites.now += seconds

        async with Fetcher(clock=sites.clock, sleep=sleep) as fetcher:
            first = await fetcher.permit("http://a/first")
            first.release()
            queued = asyncio.create_task(fetcher.permit("http://a/cancelled"))
            await waiting.wait()
            queued.cancel()
            with pytest.raises(asyncio.CancelledError):
                await queued
            block = False
            async with asyncio.timeout(1):
                next_request = await fetcher.permit("http://a/next")
            next_request.release()
        assert waits == [INTERVAL, INTERVAL]

    asyncio.run(run())


@pytest.mark.parametrize("failure", ["timeout", "unreachable", "cancelled"])
def test_failed_or_cancelled_http_requests_release_the_shared_permission(failure: str) -> None:
    async def run() -> None:
        sites = FakeSites({})
        started = asyncio.Event()
        requests = 0

        async def handle(request: httpx.Request) -> httpx.Response:
            nonlocal requests
            requests += 1
            if requests == 1:
                started.set()
                if failure == "cancelled":
                    await asyncio.Future[None]()
                if failure == "timeout":
                    raise httpx.ReadTimeout("Timed out", request=request)
                raise httpx.ConnectError("Connection failed", request=request)
            return httpx.Response(200)

        async with Fetcher(httpx.MockTransport(handle), sites.clock, sites.sleep) as fetcher:
            task = asyncio.create_task(fetcher.get("http://a/first"))
            await started.wait()
            if failure == "cancelled":
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                with pytest.raises(FetchError) as caught:
                    await task
                assert caught.value.failure == failure
            async with asyncio.timeout(1):
                response = await fetcher.get("http://a/next")
            assert response.status == 200
            assert sites.now == INTERVAL

    asyncio.run(run())
