import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from urllib.parse import urljoin

from playwright.async_api import (
    Browser as PlaywrightBrowser,
)
from playwright.async_api import (
    BrowserContext,
    Page,
    Playwright,
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

from crawler.crawl.fetch import (
    MAX_REDIRECTS,
    TIMEOUT,
    USER_AGENT,
    FetchError,
    Permit,
    Response,
)

PAGE_TIMEOUT = 300.0
PAGE_LIMIT = 2
_REDIRECTS = {301, 302, 303, 307, 308}
_BLOCKED = {"image", "font", "media"}
_CHALLENGES = {202, 412}
_logger = logging.getLogger(__name__)


class Browser:
    def __init__(self, permit: Callable[[str], Awaitable[Permit]]) -> None:
        self.permit = permit
        self.slots = asyncio.Semaphore(PAGE_LIMIT)
        self._lock = asyncio.Lock()
        self._playwright: Playwright | None = None
        self._browser: PlaywrightBrowser | None = None
        self._user_agent = ""

    async def _start(self) -> PlaywrightBrowser:
        async with self._lock:
            if self._browser is not None:
                return self._browser
            playwright = await async_playwright().start()
            try:
                browser = await playwright.chromium.launch(
                    headless=True, args=["--disable-blink-features=AutomationControlled"]
                )
                page = await browser.new_page()
                try:
                    user_agent: str = await page.evaluate("navigator.userAgent")
                finally:
                    await page.close()
            except BaseException:
                await playwright.stop()
                raise
            self._user_agent = user_agent.replace("HeadlessChrome", "Chrome") + " " + USER_AGENT
            self._playwright = playwright
            self._browser = browser
            return browser

    async def session(self, url: str) -> BrowserSession:
        try:
            browser = await self._start()
            context = await browser.new_context(
                user_agent=self._user_agent, service_workers="block", accept_downloads=False
            )
            session = BrowserSession(self, context)
            try:
                await session.configure()
            except BaseException:
                await context.close()
                raise
            return session
        except PlaywrightTimeoutError as error:
            raise FetchError("timeout", url) from error
        except PlaywrightError as error:
            raise FetchError("unreachable", url) from error

    async def close(self) -> None:
        try:
            if self._browser is not None:
                await self._browser.close()
        finally:
            if self._playwright is not None:
                await self._playwright.stop()


class BrowserSession:
    def __init__(self, owner: Browser, context: BrowserContext) -> None:
        self._owner = owner
        self._context = context

    async def configure(self) -> None:
        await self._context.route("**/*", self._route)
        self._context.on("page", self._new_page)

    async def _new_page(self, page: Page) -> None:
        if await page.opener() is not None:
            await page.close()

    async def _route(self, route: Route) -> None:
        if route.request.resource_type in _BLOCKED:
            await route.abort()
        else:
            await route.continue_()

    async def get(self, url: str) -> Response:
        async with self._owner.slots:
            permit = await self._owner.permit(url)
            started = time.monotonic()
            try:
                page = await self._context.new_page()
                try:
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
                    _logger.info(
                        "Browser fetched %s status=%s elapsed=%.3fs",
                        response.url,
                        response.status,
                        time.monotonic() - started,
                    )
                    return response
                finally:
                    await page.close()
            except PlaywrightTimeoutError as error:
                raise FetchError("timeout", url) from error
            except PlaywrightError as error:
                raise FetchError("unreachable", url) from error
            finally:
                permit.release()

    async def download(self, url: str, *, page_url: str) -> Response:
        for _ in range(MAX_REDIRECTS + 1):
            permit = await self._owner.permit(url)
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
            finally:
                permit.release()
        raise FetchError("too_many_redirects", url)

    async def close(self) -> None:
        await self._context.close()
