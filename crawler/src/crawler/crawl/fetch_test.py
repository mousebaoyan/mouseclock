import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable
from itertools import pairwise
from urllib.parse import urlsplit

import httpx

from crawler.crawl.fetch import INTERVAL, USER_AGENT, Fetcher


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
