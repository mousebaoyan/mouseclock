"""Every request to a source site goes through here, so the crawl keeps its manners in one place
(design §7.3): it says who it is, obeys robots.txt, and sends one request at a time to a site with
a pause between them."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, Self
from urllib.parse import urlsplit

import httpx
from protego import Protego

AGENT = "mouseclock"
USER_AGENT = f"{AGENT}/0.1 (+https://github.com/mousebaoyan/mouseclock)"
# Seconds from the end of one request to a site to the start of the next; a longer Crawl-delay in
# the site's robots.txt wins.
INTERVAL = 5.0
ROBOTS_TTL = 24 * 3600.0
# RFC 9309 asks crawlers to follow at least five redirects for robots.txt; pages get as many.
MAX_REDIRECTS = 5
TIMEOUT = 30.0

type Failure = Literal["timeout", "unreachable", "disallowed", "too_many_redirects"]


class FetchError(Exception):
    def __init__(self, failure: Failure, url: str) -> None:
        super().__init__(f"{failure}: {url}")
        self.failure = failure
        self.url = url


@dataclass(frozen=True)
class Response:
    url: str  # After redirects.
    status: int
    content_type: str | None
    body: bytes


@dataclass
class _Site:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    finished_at: float = float("-inf")
    interval: float = INTERVAL


@dataclass
class _Origin:
    # Held while robots.txt is fetched, so requests arriving together fetch it once.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    rules: Protego | None = None  # None when there is no robots.txt: everything is allowed.
    fetched_at: float = float("-inf")


class Fetcher:
    """One per crawler process, shared by everything that crawls, so the rules hold across tasks."""

    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._client = httpx.AsyncClient(
            transport=transport, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT
        )
        self._clock = clock
        self._sleep = sleep
        self._sites: dict[str, _Site] = {}
        self._origins: dict[str, _Origin] = {}

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self._client.aclose()

    async def get(self, url: str) -> Response:
        response = await self._follow(url, obey_robots=True)
        return Response(
            str(response.url),
            response.status_code,
            response.headers.get("content-type"),
            response.content,
        )

    async def _follow(self, url: str, *, obey_robots: bool) -> httpx.Response:
        # Each hop on its own, so a redirect to another site meets that site's rules.
        for _ in range(MAX_REDIRECTS + 1):
            if obey_robots and not await self._allowed(url):
                raise FetchError("disallowed", url)
            response = await self._send(url)
            if response.next_request is None:
                return response
            url = str(response.next_request.url)
        raise FetchError("too_many_redirects", url)

    async def _send(self, url: str) -> httpx.Response:
        site = self._sites.setdefault(urlsplit(url).netloc, _Site())
        async with site.lock:
            wait = site.finished_at + site.interval - self._clock()
            if wait > 0:
                await self._sleep(wait)
            try:
                return await self._client.get(url)
            except httpx.TimeoutException as error:
                raise FetchError("timeout", url) from error
            except httpx.TransportError as error:
                raise FetchError("unreachable", url) from error
            finally:
                site.finished_at = self._clock()

    async def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = self._origins.setdefault(f"{parts.scheme}://{parts.netloc}", _Origin())
        async with origin.lock:
            if self._clock() - origin.fetched_at > ROBOTS_TTL:
                origin.rules = await self._fetch_robots(parts.scheme, parts.netloc)
                origin.fetched_at = self._clock()
        return origin.rules is None or origin.rules.can_fetch(url, AGENT)

    async def _fetch_robots(self, scheme: str, netloc: str) -> Protego | None:
        response = await self._follow(f"{scheme}://{netloc}/robots.txt", obey_robots=False)
        # RFC 9309 §2.3.1: a 4xx means there are no rules; a 5xx means the site may not be crawled
        # for now, so this request fails and the next one asks again.
        if response.is_client_error:
            return None
        if not response.is_success:
            raise FetchError("unreachable", str(response.url))
        rules = Protego.parse(response.text)
        self._sites[netloc].interval = max(INTERVAL, rules.crawl_delay(AGENT) or 0)
        return rules
