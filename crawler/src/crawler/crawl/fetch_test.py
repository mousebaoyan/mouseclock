import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable
from itertools import pairwise
from urllib.parse import urlsplit

import httpx
import pytest

from crawler.crawl.fetch import INTERVAL, USER_AGENT, Fetcher, FetchError, Response


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

    # robots.txt and two pages on a; robots.txt and a page on b, which doesn't wait for a.
    assert len(sites.times("a")) == 3
    assert all(gap >= INTERVAL for gap in gaps(sites.times("a")))
    assert sites.most_in_flight["a"] == 1
    assert sites.most_hosts_in_flight == 2


def test_robots_txt_is_obeyed_wildcards_and_all() -> None:
    sites = FakeSites(
        {
            "http://a/robots.txt": httpx.Response(
                200, text="User-agent: *\nDisallow: /private/\nDisallow: /*.pdf$\n"
            ),
            "http://a/news/1.htm": httpx.Response(200),
        }
    )

    async def fetch_all(f: Fetcher) -> list[Response | BaseException]:
        urls = ["http://a/news/1.htm", "http://a/private/1.htm", "http://a/files/form.pdf"]
        return await asyncio.gather(*(f.get(url) for url in urls), return_exceptions=True)

    ok, private, pdf = sites.run(fetch_all)

    assert isinstance(ok, Response)
    for result in (private, pdf):
        assert isinstance(result, FetchError)
        assert result.failure == "disallowed"
    assert [url for _, url in sites.requests] == ["http://a/robots.txt", "http://a/news/1.htm"]


def test_robots_txt_server_error_means_not_now() -> None:
    sites = FakeSites({"http://a/robots.txt": httpx.Response(503)})

    with pytest.raises(FetchError) as caught:
        sites.run(lambda f: f.get("http://a/1"))

    assert caught.value.failure == "unreachable"
    assert [url for _, url in sites.requests] == ["http://a/robots.txt"]


def test_a_redirect_to_another_site_meets_that_sites_rules() -> None:
    sites = FakeSites(
        {
            "http://a/old": httpx.Response(301, headers={"location": "http://b/new"}),
            "http://b/robots.txt": httpx.Response(200, text="User-agent: *\nDisallow: /new\n"),
        }
    )

    with pytest.raises(FetchError) as caught:
        sites.run(lambda f: f.get("http://a/old"))

    assert caught.value.failure == "disallowed"
    assert "http://b/new" not in [url for _, url in sites.requests]


def test_a_longer_crawl_delay_wins() -> None:
    sites = FakeSites(
        {"http://a/robots.txt": httpx.Response(200, text="User-agent: *\nCrawl-delay: 20\n")}
    )

    sites.run(lambda f: asyncio.gather(f.get("http://a/1"), f.get("http://a/2")))

    assert gaps(sites.times("a")) == [20, 20]
