"""Source access shares one policy here (design §7.3): identify the crawler and allow one
page visit or HTTP request at a time per site, with a pause between them."""

import asyncio
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Self

import httpx

if TYPE_CHECKING:
    from crawler.crawl.browser import Browser, BrowserSession

USER_AGENT = "mouseclock/0.1 (+https://github.com/mousebaoyan/mouseclock)"
# Seconds from the end of one page visit or HTTP request to the start of the next.
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
        self._browser: Browser | None = None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        try:
            if self._browser is not None:
                await self._browser.close()
        finally:
            await self._client.aclose()

    @asynccontextmanager
    async def session(self, browser: bool, *, url: str) -> AsyncGenerator[PageSession]:
        browser_session = None
        if browser:
            if self._browser is None:
                # Keep the browser library unloaded until a source actually needs it.
                from crawler.crawl.browser import Browser

                self._browser = Browser(self.permit)
            browser_session = await self._browser.session(url)
        try:
            yield PageSession(self, browser_session)
        finally:
            if browser_session is not None:
                await browser_session.close()

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
        async with self.permit(url):
            try:
                return await self._client.get(url)
            except httpx.TimeoutException as error:
                raise FetchError("timeout", url) from error
            except httpx.TransportError as error:
                raise FetchError("unreachable", url) from error


class PageSession:
    def __init__(self, fetcher: Fetcher, browser_session: BrowserSession | None) -> None:
        self._fetcher = fetcher
        self._browser_session = browser_session

    async def get(self, url: str) -> Response:
        if self._browser_session is not None:
            return await self._browser_session.get(url)
        return await self._fetcher.get(url)

    async def download(self, url: str, *, page_url: str) -> Response:
        if self._browser_session is not None:
            return await self._browser_session.download(url, page_url=page_url)
        return await self._fetcher.get(url)
