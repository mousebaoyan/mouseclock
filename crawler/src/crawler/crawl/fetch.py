"""Source access shares one policy here (design §7.3): identify the crawler and allow one
page visit or HTTP request at a time per site, with a pause between them."""

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Literal, Self

import httpx

USER_AGENT = "mouseclock/0.1 (+https://github.com/mousebaoyan/mouseclock)"
# Seconds from the end of one page visit or HTTP request to the start of the next.
INTERVAL = 5.0
MAX_REDIRECTS = 5
TIMEOUT = 30.0
logger = logging.getLogger(__name__)

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

    @asynccontextmanager
    async def permit(self, url: str) -> AsyncGenerator[None]:
        site = self._sites.setdefault(httpx.URL(url).netloc.decode("ascii"), _Site())
        async with site.lock:
            wait = site.finished_at + INTERVAL - self._clock()
            if wait > 0:
                await self._sleep(wait)
            try:
                yield
            finally:
                site.finished_at = self._clock()

    async def get(self, url: str, max_size: int | None = None) -> Response:
        """A body longer than max_size stops being read there, so the caller sees it is too long
        without the whole file being downloaded."""
        # Each hop on its own, so a redirect to another site waits its turn there too.
        for _ in range(MAX_REDIRECTS + 1):
            response, body = await self._send(url, max_size)
            if response.next_request is None:
                return Response(
                    str(response.url),
                    response.status_code,
                    response.headers.get("content-type"),
                    body,
                )
            url = str(response.next_request.url)
        raise FetchError("too_many_redirects", url)

    async def _send(self, url: str, max_size: int | None) -> tuple[httpx.Response, bytes]:
        async with self.permit(url):
            started = self._clock()
            body = bytearray()
            try:
                async with self._client.stream("GET", url) as response:
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if max_size is not None and len(body) > max_size:
                            break
            except httpx.TimeoutException as error:
                raise FetchError("timeout", url) from error
            except httpx.TransportError as error:
                raise FetchError("unreachable", url) from error
            logger.info(
                "Fetched",
                extra={
                    "url": url,
                    "status": response.status_code,
                    "elapsed": self._clock() - started,
                },
            )
            return response, bytes(body)
