"""Every request to a source site goes through here, so the crawl keeps its manners in one place
(design §7.3): it says who it is and sends one request at a time to a site with a pause between
them."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, Self
from urllib.parse import urlsplit

import httpx

USER_AGENT = "mouseclock/0.1 (+https://github.com/mousebaoyan/mouseclock)"
# Seconds from the end of one request to a site to the start of the next.
INTERVAL = 5.0
MAX_REDIRECTS = 5
TIMEOUT = 30.0

type Failure = Literal["timeout", "unreachable", "too_many_redirects"]


class FetchError(Exception):
    def __init__(self, failure: Failure, url: str) -> None:
        super().__init__(f"{failure}: {url}")
        self.failure: Failure = failure
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

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self._client.aclose()

    async def get(self, url: str) -> Response:
        # Each hop on its own, so a redirect to another site waits its turn there too.
        for _ in range(MAX_REDIRECTS + 1):
            response = await self._send(url)
            if response.next_request is None:
                return Response(
                    str(response.url),
                    response.status_code,
                    response.headers.get("content-type"),
                    response.content,
                )
            url = str(response.next_request.url)
        raise FetchError("too_many_redirects", url)

    async def _send(self, url: str) -> httpx.Response:
        site = self._sites.setdefault(urlsplit(url).netloc, _Site())
        async with site.lock:
            wait = site.finished_at + INTERVAL - self._clock()
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
