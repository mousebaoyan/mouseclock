"""Source access shares one policy here (design §7.3): identify the crawler and allow one
page visit or HTTP request at a time per site, with a pause between them."""

import asyncio
import time
from collections.abc import Awaitable, Callable
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


def site_key(url: str) -> str:
    return httpx.URL(url).netloc.decode("ascii")


@dataclass
class Permit:
    _site: _Site
    _clock: Callable[[], float]
    _released: bool = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._site.finished_at = self._clock()
            self._site.lock.release()


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

    def session(self, browser: bool) -> PageSession:
        return PageSession(self, browser)

    def browser(self) -> Browser:
        if self._browser is None:
            # Keep the browser library unloaded until a source actually needs it.
            from crawler.crawl.browser import Browser

            self._browser = Browser(self.permit)
        return self._browser

    async def permit(self, url: str) -> Permit:
        site = self._sites.setdefault(site_key(url), _Site())
        await site.lock.acquire()
        try:
            wait = site.finished_at + INTERVAL - self._clock()
            if wait > 0:
                await self._sleep(wait)
            return Permit(site, self._clock)
        except BaseException:
            site.lock.release()
            raise

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
        permit = await self.permit(url)
        try:
            return await self._client.get(url)
        except httpx.TimeoutException as error:
            raise FetchError("timeout", url) from error
        except httpx.TransportError as error:
            raise FetchError("unreachable", url) from error
        finally:
            permit.release()


class PageSession:
    def __init__(self, fetcher: Fetcher, browser: bool) -> None:
        self._fetcher = fetcher
        self._use_browser = browser
        self._browser_session: BrowserSession | None = None
        self._lock = asyncio.Lock()
        self._closed = False

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        self._closed = True
        if self._browser_session is not None:
            await self._browser_session.close()

    async def _open_browser(self) -> BrowserSession:
        async with self._lock:
            if self._browser_session is None:
                self._browser_session = await self._fetcher.browser().session()
            return self._browser_session

    async def get(self, url: str) -> Response:
        if self._closed:
            raise RuntimeError("Page session is closed")
        if self._use_browser:
            return await (await self._open_browser()).get(url)
        return await self._fetcher.get(url)

    async def download(self, url: str, *, page_url: str) -> Response:
        if self._closed:
            raise RuntimeError("Page session is closed")
        if self._use_browser:
            return await (await self._open_browser()).download(url, page_url=page_url)
        return await self._fetcher.get(url)
