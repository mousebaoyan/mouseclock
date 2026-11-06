import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Protocol
from urllib.parse import urljoin, urlsplit

from playwright.async_api import (
    Browser as PlaywrightBrowser,
)
from playwright.async_api import (
    BrowserContext,
    Download,
    Frame,
    Page,
    Playwright,
    Route,
    async_playwright,
)
from playwright.async_api import (
    Error as PlaywrightError,
)
from playwright.async_api import (
    Request as PlaywrightRequest,
)
from playwright.async_api import (
    Response as PlaywrightResponse,
)
from playwright.async_api import (
    TimeoutError as PlaywrightTimeoutError,
)
from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError

from crawler.crawl.fetch import (
    MAX_REDIRECTS,
    TIMEOUT,
    USER_AGENT,
    FetchError,
    Permit,
    Response,
    site_key,
)

PAGE_TIMEOUT = 300.0
PAGE_LIMIT = 2
_REDIRECTS = {301, 302, 303, 307, 308}
_BLOCKED = {"image", "font", "media"}
_CHALLENGES = {202, 412}
_PARAMS = TypeAdapter(dict[str, JsonValue])
_logger = logging.getLogger(__name__)


class _Version(BaseModel):
    user_agent: str = Field(alias="userAgent")


class _Request(BaseModel):
    url: str


class _Paused(BaseModel):
    request_id: str = Field(alias="requestId")
    request: _Request
    frame_id: str = Field(alias="frameId")
    redirected_request_id: str | None = Field(default=None, alias="redirectedRequestId")


class _Frame(BaseModel):
    id: str


class _FrameTree(BaseModel):
    frame: _Frame


class _Frames(BaseModel):
    frame_tree: _FrameTree = Field(alias="frameTree")


# Playwright leaves CDPSession.send's dictionaries untyped; validate its JSON at this boundary.
class _Commands(Protocol):
    async def send(self, method: str, params: dict[str, JsonValue] | None = None) -> object: ...

    def on(self, event: str, f: Callable[[object], None]) -> None: ...

    async def detach(self) -> None: ...


async def _command(
    connection: _Commands, method: str, params: dict[str, JsonValue] | None = None
) -> dict[str, JsonValue]:
    return _PARAMS.validate_python(await connection.send(method, params))


def _source_error(error: PlaywrightError, url: str) -> FetchError | None:
    if isinstance(error, PlaywrightTimeoutError):
        return FetchError("timeout", url)
    message = str(error).split("\n", 1)[0]
    if "Download is starting" in message:
        return FetchError("unreachable", url)
    if "net::ERR_TOO_MANY_REDIRECTS" in message:
        return FetchError("too_many_redirects", url)
    if "net::ERR_TIMED_OUT" in message or "Request timed out" in message:
        return FetchError("timeout", url)
    if any(
        marker in message
        for marker in ("net::ERR_", "ECONN", "ENOTFOUND", "EAI_AGAIN", "socket hang up")
    ):
        return FetchError("unreachable", url)
    if message.startswith(
        (
            "APIRequestContext.get: self-signed certificate",
            "APIRequestContext.get: certificate has expired",
            "APIRequestContext.get: unable to verify the first certificate",
            "APIRequestContext.get: Hostname/IP does not match certificate's altnames:",
            "APIRequestContext.get: failed to decompress 'gzip' encoding:",
        )
    ):
        return FetchError("unreachable", url)
    return None


class Browser:
    def __init__(self, permit: Callable[[str], Awaitable[Permit]]) -> None:
        self.permit = permit
        self.slots = asyncio.Semaphore(PAGE_LIMIT)
        self._lock = asyncio.Lock()
        self._playwright: Playwright | None = None
        self._browser: PlaywrightBrowser | None = None
        self._user_agent = ""
        self.sessions: set[BrowserSession] = set()

    async def _start(self) -> PlaywrightBrowser:
        async with self._lock:
            if self._browser is not None:
                return self._browser
            playwright = await async_playwright().start()
            try:
                browser = await playwright.chromium.launch(
                    headless=True, args=["--disable-blink-features=AutomationControlled"]
                )
                connection: _Commands = await browser.new_browser_cdp_session()
                try:
                    version = _Version.model_validate(
                        await _command(connection, "Browser.getVersion")
                    )
                finally:
                    await connection.detach()
            except BaseException:
                await playwright.stop()
                raise
            self._user_agent = (
                version.user_agent.replace("HeadlessChrome", "Chrome") + " " + USER_AGENT
            )
            self._playwright = playwright
            self._browser = browser
            return browser

    async def session(self) -> BrowserSession:
        browser = await self._start()
        creating = asyncio.create_task(
            browser.new_context(
                user_agent=self._user_agent, service_workers="block", accept_downloads=False
            )
        )
        try:
            # Cancelling a protocol call does not prevent the browser from creating its resource.
            await asyncio.wait((creating,))
            context = creating.result()
            session = BrowserSession(self, context)
            await session.configure()
        except BaseException:
            context = await creating
            await context.close()
            raise
        self.sessions.add(session)
        return session

    async def close(self) -> None:
        try:
            for session in tuple(self.sessions):
                await session.close()
        finally:
            try:
                if self._browser is not None:
                    await self._browser.close()
                    self._browser = None
            finally:
                if self._playwright is not None:
                    await self._playwright.stop()
                    self._playwright = None


class BrowserSession:
    def __init__(self, owner: Browser, context: BrowserContext) -> None:
        self._owner = owner
        self._context = context
        self._pages: set[Page] = set()
        self._popup_tasks: set[asyncio.Task[None]] = set()
        self._closed = False

    async def configure(self) -> None:
        await self._context.route("**/*", self._route)
        self._context.on("page", self._new_page)

    def _new_page(self, page: Page) -> None:
        task = asyncio.create_task(self._popup(page))
        self._popup_tasks.add(task)

    async def _popup(self, page: Page) -> None:
        if await page.opener() is not None:
            await page.close()

    async def _route(self, route: Route) -> None:
        request = route.request
        if request.resource_type in _BLOCKED:
            await route.abort()
            return
        try:
            allowed = request.frame.page in self._pages
        except PlaywrightError as error:
            if "Frame for this navigation request is not available" not in str(error):
                raise
            allowed = False
        if not allowed:
            await route.abort()
            return
        await route.continue_()

    async def get(self, url: str) -> Response:
        async with self._owner.slots:
            page: Page | None = None
            creating: asyncio.Task[Page] | None = None
            request: _Page | None = None
            started = time.monotonic()
            try:
                async with asyncio.timeout(PAGE_TIMEOUT):
                    creating = asyncio.create_task(self._context.new_page())
                    await asyncio.wait((creating,))
                    page = creating.result()
                    self._pages.add(page)
                    request = _Page(page, self._context, self._owner.permit, url)
                    response = await request.run()
                    _logger.info(
                        "Browser fetched %s status=%s elapsed=%.3fs",
                        response.url,
                        response.status,
                        time.monotonic() - started,
                    )
                    return response
            except TimeoutError as error:
                raise FetchError("timeout", url) from error
            finally:
                if request is not None:
                    await request.close()
                elif creating is not None:
                    page = await creating
                    await page.close()
                if page is not None:
                    self._pages.discard(page)

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
            except PlaywrightError as error:
                failure = _source_error(error, url)
                if failure is not None:
                    raise failure from error
                raise
            finally:
                permit.release()
        raise FetchError("too_many_redirects", url)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await self._context.close()
        finally:
            try:
                if self._popup_tasks:
                    await asyncio.gather(*self._popup_tasks)
            finally:
                self._owner.sessions.discard(self)


class _Page:
    def __init__(
        self,
        page: Page,
        context: BrowserContext,
        permit: Callable[[str], Awaitable[Permit]],
        url: str,
    ) -> None:
        self._context = context
        self._permit = permit
        self._page = page
        self._url = url
        self._connection: _Commands | None = None
        self._frame_id = ""
        self._tasks: set[asyncio.Task[None]] = set()
        self._gate = asyncio.Lock()
        self._current_permit: Permit | None = None
        self._site: str | None = None
        self._redirects: dict[str, int] = {}
        self._changed = asyncio.Event()
        self._failure: asyncio.Future[BaseException] = asyncio.get_running_loop().create_future()
        self._main: PlaywrightResponse | None = None
        self._current_request: PlaywrightRequest | None = None
        self._generation = 0
        self._committed_generation = -1
        self._loaded_generation = -1
        self._document_pending = False
        self._closing = False

    def _spawn(self, operation: Awaitable[None]) -> None:
        task = asyncio.ensure_future(operation)
        self._tasks.add(task)
        task.add_done_callback(self._done)

    def _done(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                self._fail(error)
        self._changed.set()

    def _fail(self, error: BaseException) -> None:
        if not self._closing and not self._failure.done():
            self._failure.set_result(error)

    async def _send(
        self, method: str, params: dict[str, JsonValue] | None = None
    ) -> dict[str, JsonValue]:
        if self._connection is None:
            raise RuntimeError("CDP connection has not started")
        return await _command(self._connection, method, params)

    async def _configure(self) -> None:
        frames = _Frames.model_validate(await self._send("Page.getFrameTree"))
        self._frame_id = frames.frame_tree.frame.id
        await self._send(
            "Fetch.enable",
            {
                "patterns": [
                    {"urlPattern": "*", "resourceType": "Document", "requestStage": "Request"}
                ]
            },
        )

    def _request_paused(self, value: object) -> None:
        if self._closing:
            return
        try:
            event = _Paused.model_validate(value)
        except ValidationError as error:
            self._fail(error)
            return
        if event.frame_id == self._frame_id:
            self._document_pending = True
            self._changed.set()
        self._spawn(self._paused(event))

    def _release(self) -> None:
        if self._current_permit is not None:
            self._current_permit.release()
            self._current_permit = None
        self._site = None

    async def _paused(self, event: _Paused) -> None:
        if event.frame_id == self._frame_id:
            async with self._gate:
                redirects = (
                    self._redirects.pop(event.redirected_request_id, 0) + 1
                    if event.redirected_request_id is not None
                    else 0
                )
                if redirects > MAX_REDIRECTS:
                    self._fail(FetchError("too_many_redirects", event.request.url))
                    return
                self._redirects[event.request_id] = redirects
                url = event.request.url
                if urlsplit(url).scheme in {"http", "https"}:
                    site = site_key(url)
                    if site != self._site:
                        # Release before waiting at the destination so two visits crossing
                        # between the same sites cannot hold each other's permits.
                        self._release()
                        permit = await self._permit(url)
                        if self._closing:
                            permit.release()
                            return
                        self._current_permit = permit
                        self._site = site
                await self._send("Fetch.continueRequest", {"requestId": event.request_id})
        else:
            await self._send("Fetch.continueRequest", {"requestId": event.request_id})

    def _requested(self, request: PlaywrightRequest) -> None:
        if request.is_navigation_request() and request.frame == self._page.main_frame:
            self._current_request = request
            self._generation += 1
            self._main = None
            self._document_pending = True
            self._changed.set()

    def _response(self, response: PlaywrightResponse) -> None:
        if response.request is self._current_request:
            self._main = response
            self._changed.set()

    def _request_failed(self, request: PlaywrightRequest) -> None:
        if request is not self._current_request:
            return
        reason = request.failure
        if reason == "net::ERR_ABORTED":
            return
        error = PlaywrightError(reason or "Main navigation failed without a reason")
        self._fail(_source_error(error, request.url) or error)

    def _navigated(self, frame: Frame) -> None:
        if frame == self._page.main_frame:
            # History/hash changes have no new response or DOMContentLoaded event.
            if self._main is not None and self._committed_generation != self._generation:
                self._committed_generation = self._generation
                self._document_pending = False
            self._changed.set()

    def _domcontentloaded(self, _: Page) -> None:
        if self._committed_generation == self._generation:
            self._loaded_generation = self._generation
        self._changed.set()

    def _download(self, download: Download) -> None:
        self._fail(FetchError("unreachable", download.url))
        self._spawn(download.cancel())

    def _ready(self) -> bool:
        return (
            self._main is not None
            and self._committed_generation == self._generation
            and self._loaded_generation == self._generation
            and not self._document_pending
            and not self._tasks
        )

    async def _navigate(self) -> Response:
        await self._page.goto(self._url, wait_until="commit", timeout=0)
        while True:
            self._changed.clear()
            response = self._main
            if response is not None and response.status not in _CHALLENGES and self._ready():
                generation = self._generation
                try:
                    body = await self._page.content()
                except PlaywrightError as error:
                    if "page is navigating" not in str(error):
                        raise
                    continue
                if generation == self._generation and response is self._main and self._ready():
                    return Response(
                        self._page.url,
                        response.status,
                        "text/html; charset=utf-8",
                        body.encode("utf-8"),
                    )
            await self._changed.wait()

    async def run(self) -> Response:
        self._connection = await self._context.new_cdp_session(self._page)
        self._connection.on("Fetch.requestPaused", self._request_paused)
        self._page.on("request", self._requested)
        self._page.on("requestfailed", self._request_failed)
        self._page.on("response", self._response)
        self._page.on("download", self._download)
        self._page.on("framenavigated", self._navigated)
        self._page.on("domcontentloaded", self._domcontentloaded)
        navigation: asyncio.Task[Response] | None = None
        try:
            await self._configure()
            navigation = asyncio.create_task(self._navigate())
            await asyncio.wait((navigation, self._failure), return_when=asyncio.FIRST_COMPLETED)
            if self._failure.done():
                raise self._failure.result()
            return await navigation
        except PlaywrightError as error:
            failure = _source_error(error, self._page.url or self._url)
            if failure is not None:
                raise failure from error
            raise
        finally:
            if navigation is not None and not navigation.done():
                navigation.cancel()
                await asyncio.gather(navigation, return_exceptions=True)

    async def close(self) -> None:
        self._closing = True
        try:
            await self._page.close()
        finally:
            tasks = tuple(self._tasks)
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._release()
