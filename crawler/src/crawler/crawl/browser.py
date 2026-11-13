import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Self
from urllib.parse import urljoin

from playwright.async_api import (
    BrowserContext,
    Page,
    Route,
    async_playwright,
)
from playwright.async_api import (
    Error as PlaywrightError,
)
from playwright.async_api import (
    Response as PlaywrightResponse,
)
from playwright.async_api import (
    TimeoutError as PlaywrightTimeoutError,
)

from crawler.crawl.contract import WorkProbe, WorkSource
from crawler.crawl.fetch import (
    MAX_REDIRECTS,
    TIMEOUT,
    USER_AGENT,
    Fetcher,
    FetchError,
    Response,
)

PAGE_TIMEOUT = 300.0
PAGE_LIMIT = 2
_REDIRECTS = {301, 302, 303, 307, 308}
_BLOCKED = {"image", "font", "media"}
_CHALLENGES = {202, 412}
logger = logging.getLogger(__name__)


async def _close_popup(page: Page) -> None:
    if await page.opener() is not None:
        await page.close()


async def _route(route: Route) -> None:
    if route.request.resource_type in _BLOCKED:
        await route.abort()
    else:
        await route.continue_()


class Browser:
    def __init__(self, fetcher: Fetcher) -> None:
        self.fetcher = fetcher
        self.slots = asyncio.Semaphore(PAGE_LIMIT)

    async def __aenter__(self) -> Self:
        self._playwright = await async_playwright().start()
        try:
            self._browser = await self._playwright.chromium.launch(
                headless=True, args=["--disable-blink-features=AutomationControlled"]
            )
            async with await self._browser.new_page() as page:
                user_agent: str = await page.evaluate("navigator.userAgent")
        except BaseException:
            await self._playwright.stop()
            raise
        self._user_agent = user_agent.replace("HeadlessChrome", "Chrome") + " " + USER_AGENT
        return self

    async def __aexit__(self, *_: object) -> None:
        try:
            await self._browser.close()
        finally:
            await self._playwright.stop()

    @asynccontextmanager
    async def session(self, source: WorkSource | WorkProbe) -> AsyncGenerator[PageSession]:
        if not source.browser:
            yield PageSession(self.fetcher, None)
            return
        async with await self._browser.new_context(
            user_agent=self._user_agent, service_workers="block", accept_downloads=False
        ) as context:
            await context.route("**/*", _route)
            context.on("page", _close_popup)
            yield PageSession(self.fetcher, BrowserSession(self, context))


class BrowserSession:
    def __init__(self, owner: Browser, context: BrowserContext) -> None:
        self._owner = owner
        self._context = context

    async def get(self, url: str) -> Response:
        async with self._owner.slots, self._owner.fetcher.permit(url):
            started = time.monotonic()
            try:
                async with await self._context.new_page() as page:
                    last_response: PlaywrightResponse | None = None

                    def record_response(response: PlaywrightResponse) -> None:
                        nonlocal last_response
                        request = response.request
                        if request.is_navigation_request() and request.frame == page.main_frame:
                            last_response = response

                    page.on("response", record_response)
                    await page.goto(url, wait_until="networkidle", timeout=PAGE_TIMEOUT * 1000)
                    if last_response is None or last_response.status in _CHALLENGES:
                        raise FetchError("unreachable", page.url)
                    body = await page.content()
                    response = Response(
                        page.url,
                        last_response.status,
                        "text/html; charset=utf-8",
                        body.encode("utf-8"),
                    )
                    logger.info(
                        "Browser fetched",
                        extra={
                            "url": response.url,
                            "status": response.status,
                            "elapsed": time.monotonic() - started,
                        },
                    )
                    return response
            except PlaywrightTimeoutError as error:
                raise FetchError("timeout", url) from error
            except PlaywrightError as error:
                raise FetchError("unreachable", url) from error

    async def download(self, url: str, *, page_url: str) -> Response:
        for _ in range(MAX_REDIRECTS + 1):
            async with self._owner.fetcher.permit(url):
                started = time.monotonic()
                try:
                    response = await self._context.request.get(
                        url,
                        headers={"Referer": page_url},
                        timeout=TIMEOUT * 1000,
                        max_redirects=0,
                        max_retries=0,
                        fail_on_status_code=False,
                    )
                    try:
                        logger.info(
                            "Browser downloaded",
                            extra={
                                "url": url,
                                "status": response.status,
                                "elapsed": time.monotonic() - started,
                            },
                        )
                        location = response.headers.get("location")
                        if response.status in _REDIRECTS and location is not None:
                            url = urljoin(response.url, location)
                            continue
                        return Response(
                            response.url,
                            response.status,
                            response.headers.get("content-type"),
                            await response.body(),
                        )
                    finally:
                        await response.dispose()
                except PlaywrightTimeoutError as error:
                    raise FetchError("timeout", url) from error
                except PlaywrightError as error:
                    raise FetchError("unreachable", url) from error
        raise FetchError("too_many_redirects", url)


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
