import asyncio
from collections.abc import Awaitable, Callable

import httpx
import pytest
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from pydantic import JsonValue

from crawler.crawl.browser import Browser
from crawler.crawl.fetch import (
    INTERVAL,
    MAX_REDIRECTS,
    Failure,
    Fetcher,
    FetchError,
    Permit,
    Response,
)


def run(main: Callable[[], Awaitable[None]]) -> None:
    async def bounded() -> None:
        async with asyncio.timeout(5):
            await main()

    asyncio.run(bounded())


class FakeSession:
    def __init__(self, number: int) -> None:
        self.number = number
        self.closed = False

    async def get(self, url: str) -> Response:
        return Response(url, 200, "text/html", f"session {self.number}".encode())

    async def download(self, url: str, *, page_url: str) -> Response:
        return Response(url, 200, "application/pdf", f"session {self.number}: {page_url}".encode())

    async def close(self) -> None:
        self.closed = True


class FakeSessions:
    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []

    async def session(self) -> FakeSession:
        await asyncio.sleep(0)
        session = FakeSession(len(self.sessions) + 1)
        self.sessions.append(session)
        return session


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds
        await asyncio.sleep(0)


class FakeAPIResponse:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.url = str(response.url)
        self.status = response.status_code
        self.headers = dict(response.headers)
        self.disposed = False

    async def body(self) -> bytes:
        return self.response.content

    async def dispose(self) -> None:
        self.disposed = True
        await self.response.aclose()


class FakeDownloads:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client
        self.responses: list[FakeAPIResponse] = []
        self.error: PlaywrightError | None = None

    async def get(
        self,
        url: str,
        *,
        headers: dict[str, str],
        **options: object,
    ) -> FakeAPIResponse:
        if self.error is not None:
            raise self.error
        assert options["max_redirects"] == options["max_retries"] == 0
        assert options["fail_on_status_code"] is False
        request_timeout = options["timeout"]
        assert isinstance(request_timeout, int | float)
        response = FakeAPIResponse(
            await self.client.get(url, headers=headers, timeout=request_timeout / 1000)
        )
        self.responses.append(response)
        return response


class FakeCDP:
    def __init__(self) -> None:
        self.handlers: dict[str, Callable[..., None]] = {}
        self.commands: asyncio.Queue[tuple[str, dict[str, JsonValue]]] = asyncio.Queue()
        self.continued: dict[str, asyncio.Event] = {}

    def on(self, event: str, callback: Callable[..., None]) -> None:
        self.handlers[event] = callback

    async def send(
        self, method: str, params: dict[str, JsonValue] | None = None
    ) -> dict[str, JsonValue]:
        self.commands.put_nowait((method, params or {}))
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "main"}}}
        if method == "Fetch.continueRequest":
            assert params is not None
            request_id = params["requestId"]
            assert isinstance(request_id, str)
            self.continued[request_id].set()
        return {}

    async def next_command(
        self, method: str, *, request_id: str | None = None
    ) -> dict[str, JsonValue]:
        while True:
            name, params = await self.commands.get()
            if name == method and (request_id is None or params.get("requestId") == request_id):
                return params

    def pause(
        self,
        request_id: str,
        url: str,
        *,
        frame_id: str = "main",
        redirected: str | None = None,
    ) -> None:
        self.continued[request_id] = asyncio.Event()
        value: dict[str, JsonValue] = {
            "requestId": request_id,
            "request": {"url": url, "method": "GET"},
            "resourceType": "Document",
            "frameId": frame_id,
        }
        if redirected is not None:
            value["redirectedRequestId"] = redirected
        self.handlers["Fetch.requestPaused"](value)


class FakeFrame:
    def __init__(self, page: FakePage) -> None:
        self.page = page


class FakeNavigation:
    def __init__(self, frame: FakeFrame, url: str, *, navigation: bool = True) -> None:
        self.frame = frame
        self.url = url
        self.navigation = navigation
        self.failure: str | None = None

    def is_navigation_request(self) -> bool:
        return self.navigation


class FakeDocument:
    def __init__(self, status: int, request: FakeNavigation) -> None:
        self.request = request
        self.status = status


class FakePage:
    def __init__(self, context: FakeContext) -> None:
        self.context = context
        self.main_frame = FakeFrame(self)
        self.navigation = FakeNavigation(self.main_frame, "about:blank")
        self.url = "about:blank"
        self.html = ""
        self.closed = False
        self.close_started = asyncio.Event()
        self.close_gate: asyncio.Event | None = None
        self.started = asyncio.Event()
        self.content_started = asyncio.Event()
        self.content_gate: asyncio.Event | None = None
        self.navigation_error: PlaywrightError | None = None
        self.connection = FakeCDP()
        self.handlers: dict[str, Callable[..., None]] = {}

    def on(self, event: str, callback: Callable[..., None]) -> None:
        self.handlers[event] = callback

    def begin_navigation(self, url: str) -> FakeNavigation:
        self.navigation = FakeNavigation(self.main_frame, url)
        self.handlers["request"](self.navigation)
        return self.navigation

    def respond(self, status: int, *, request: FakeNavigation | None = None) -> None:
        self.handlers["response"](FakeDocument(status, request or self.navigation))

    def fail(self, request: FakeNavigation, reason: str) -> None:
        request.failure = reason
        self.handlers["requestfailed"](request)

    def commit(self, url: str, html: str, *, loaded: bool = True) -> None:
        self.url = url
        self.html = html
        if callback := self.handlers.get("framenavigated"):
            callback(self.main_frame)
        if loaded:
            self.load()

    def load(self) -> None:
        self.handlers["domcontentloaded"](self)

    async def goto(self, url: str, **_options: object) -> None:
        self.begin_navigation(url)
        self.connection.pause("initial", url)
        await self.connection.continued["initial"].wait()
        if self.navigation_error is not None:
            raise self.navigation_error
        self.respond(self.context.driver.initial_status)
        self.commit(url, "<html>challenge</html>")
        self.started.set()

    async def content(self) -> str:
        html = self.html
        self.content_started.set()
        if self.content_gate is not None:
            await self.content_gate.wait()
        return html

    async def close(self) -> None:
        if not self.closed:
            self.close_started.set()
            if self.close_gate is not None:
                await self.close_gate.wait()
            self.closed = True
            self.context.driver.active_pages -= 1


class FakeRouteRequest:
    def __init__(self, page: FakePage, resource_type: str) -> None:
        self.frame = FakeFrame(page)
        self.resource_type = resource_type


class FakeRoute:
    def __init__(self, page: FakePage, resource_type: str) -> None:
        self.request = FakeRouteRequest(page, resource_type)
        self.continued = False
        self.aborted = False

    async def continue_(self) -> None:
        self.continued = True

    async def abort(self) -> None:
        self.aborted = True


class FakeContext:
    def __init__(self, driver: FakeBrowser) -> None:
        self.driver = driver
        self.client = httpx.AsyncClient(transport=driver.transport)
        self.request = FakeDownloads(self.client)
        self.pages: list[FakePage] = []
        self.closed = False
        self.route_handler: Callable[[FakeRoute], Awaitable[None]] | None = None
        self.page_gate: asyncio.Event | None = None

    async def route(self, pattern: str, handler: Callable[[FakeRoute], Awaitable[None]]) -> None:
        self.route_handler = handler

    def on(self, event: str, handler: object) -> None:
        pass

    async def new_page(self) -> FakePage:
        page = FakePage(self)
        self.pages.append(page)
        self.driver.active_pages += 1
        self.driver.peak_pages = max(self.driver.peak_pages, self.driver.active_pages)
        self.driver.created.put_nowait(page)
        if self.page_gate is not None:
            await self.page_gate.wait()
        return page

    async def new_cdp_session(self, page: FakePage) -> FakeCDP:
        return page.connection

    async def close(self) -> None:
        self.closed = True
        for page in self.pages:
            await page.close()
        await self.client.aclose()


class FakeBrowser:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport or httpx.MockTransport(lambda _: httpx.Response(404))
        self.contexts: list[FakeContext] = []
        self.created: asyncio.Queue[FakePage] = asyncio.Queue()
        self.active_pages = 0
        self.peak_pages = 0
        self.initial_status = 202
        self.context_created = asyncio.Event()
        self.context_gate: asyncio.Event | None = None

    async def new_context(
        self, *, user_agent: str, service_workers: str, accept_downloads: bool
    ) -> FakeContext:
        context = FakeContext(self)
        self.contexts.append(context)
        self.context_created.set()
        if self.context_gate is not None:
            await self.context_gate.wait()
        return context


def use_browser(monkeypatch: pytest.MonkeyPatch, driver: FakeBrowser) -> None:
    async def start(_owner: object) -> FakeBrowser:
        return driver

    monkeypatch.setattr("crawler.crawl.browser.Browser._start", start)


def test_plain_pages_and_unused_browser_sessions_do_not_start_a_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_browser(_fetcher: Fetcher) -> None:
        pytest.fail("A browser was started without a browser page request")

    monkeypatch.setattr(Fetcher, "browser", unexpected_browser)

    async def main() -> None:
        transport = httpx.MockTransport(
            lambda request: httpx.Response(200, content=request.url.path)
        )
        async with Fetcher(transport) as fetcher:
            async with fetcher.session(False) as pages:
                listing = await pages.get("https://a/list")
                attachment = await pages.download("https://b/file.pdf", page_url=listing.url)
            async with fetcher.session(True):
                pass
        assert listing.body == b"/list"
        assert attachment.body == b"/file.pdf"

    run(main)


def test_round_reuses_its_browser_session_and_closes_it_before_the_next_round(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = FakeSessions()

    def browser_service(_fetcher: Fetcher) -> FakeSessions:
        return service

    monkeypatch.setattr(Fetcher, "browser", browser_service)

    async def main() -> None:
        async with Fetcher(httpx.MockTransport(lambda _: httpx.Response(500))) as fetcher:
            async with fetcher.session(True) as pages:
                assert service.sessions == []
                listing, notice = await asyncio.gather(
                    pages.get("https://a/list"), pages.get("https://a/notice")
                )
                attachment = await pages.download("https://a/file.pdf", page_url=notice.url)
                assert listing.body == notice.body == b"session 1"
                assert attachment.body == b"session 1: https://a/notice"
                assert not service.sessions[0].closed

            with pytest.raises(RuntimeError, match="closed"):
                await pages.get("https://a/after-close")
            with pytest.raises(RuntimeError, match="closed"):
                await pages.download("https://a/file.pdf", page_url=notice.url)
            assert service.sessions[0].closed

            async with fetcher.session(True) as next_round:
                assert (await next_round.get("https://a/list")).body == b"session 2"
                assert service.sessions[0].closed
            assert all(session.closed for session in service.sessions)

    run(main)


@pytest.mark.parametrize("challenge", [202, 412])
def test_challenge_waits_for_the_final_document_to_commit_before_reading_html(
    monkeypatch: pytest.MonkeyPatch, challenge: int
) -> None:
    driver = FakeBrowser()
    driver.initial_status = challenge
    use_browser(monkeypatch, driver)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                await page.started.wait()
                await asyncio.sleep(0)
                assert not task.done()

                # A response event precedes commit, even when both documents use the same URL.
                page.begin_navigation("https://a.test/list")
                page.connection.pause("challenge", "https://a.test/list")
                await page.connection.next_command("Fetch.continueRequest", request_id="challenge")
                page.respond(200)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                assert not task.done()

                page.commit("https://a.test/list", "<html>script pending</html>", loaded=False)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                assert not task.done()
                page.html = "<html><a>rendered notice</a></html>"
                page.load()
                result = await task
                assert result.status == 200
                assert result.body == b"<html><a>rendered notice</a></html>"
                assert page.closed
                assert driver.active_pages == 0
            finally:
                await browser.close()

    run(main)


def test_page_limit_is_shared_across_rounds_and_cancellation_frees_a_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    finish = asyncio.Event()

    async def render(_request: object) -> Response:
        await finish.wait()
        return Response("https://a.test/list", 200, "text/html", b"rendered")

    monkeypatch.setattr("crawler.crawl.browser._Page.run", render)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            try:
                first, second = await asyncio.gather(browser.session(), browser.session())
                tasks = [
                    asyncio.create_task(first.get("https://a.test/1")),
                    asyncio.create_task(second.get("https://b.test/2")),
                    asyncio.create_task(first.get("https://a.test/3")),
                ]
                page_one = await driver.created.get()
                await driver.created.get()
                await asyncio.sleep(0)
                assert driver.active_pages == driver.peak_pages == 2
                assert driver.created.empty()

                tasks[0].cancel()
                with pytest.raises(asyncio.CancelledError):
                    await tasks[0]
                page_three = await driver.created.get()
                assert page_one.closed
                assert not page_three.closed
                assert driver.active_pages == driver.peak_pages == 2

                finish.set()
                assert [response.body for response in await asyncio.gather(*tasks[1:])] == [
                    b"rendered",
                    b"rendered",
                ]
                assert driver.active_pages == 0
            finally:
                finish.set()
                await browser.close()
            assert all(context.closed for context in driver.contexts)

    run(main)


def test_navigation_during_html_read_discards_the_previous_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    driver.initial_status = 200
    use_browser(monkeypatch, driver)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                page.content_gate = asyncio.Event()
                await page.content_started.wait()
                previous = page.navigation
                page.begin_navigation("https://a.test/final")
                page.content_gate.set()
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                assert not task.done()

                page.respond(200, request=previous)
                await asyncio.sleep(0)
                assert not task.done()
                page.connection.pause("navigate", "https://a.test/final")
                await page.connection.next_command("Fetch.continueRequest", request_id="navigate")
                page.respond(200)
                await asyncio.sleep(0)
                assert not task.done()
                page.commit("https://a.test/final", "<html>final document</html>")
                result = await task
                assert result.url == "https://a.test/final"
                assert result.body == b"<html>final document</html>"
            finally:
                await browser.close()

    run(main)


def test_attachment_cookies_are_scoped_to_the_round_and_each_redirect_destination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: list[tuple[str, str, str]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requested.append(
            (
                str(request.url),
                request.headers.get("cookie", ""),
                request.headers.get("referer", ""),
            )
        )
        if request.url.host == "a.test":
            if request.headers.get("cookie") != "challenge=passed":
                return httpx.Response(403, content=b"challenge required")
            return httpx.Response(302, headers={"location": "https://b.test/file.pdf"})
        assert "challenge" not in request.headers.get("cookie", "")
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"PDF")

    driver = FakeBrowser(httpx.MockTransport(handle))
    use_browser(monkeypatch, driver)
    clock = FakeClock()

    async def main() -> None:
        async with Fetcher(clock=clock.clock, sleep=clock.sleep) as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                context = driver.contexts[0]
                context.client.cookies.set("challenge", "passed", domain="a.test", path="/private")
                result = await session.download(
                    "https://a.test/private/file.pdf", page_url="https://a.test/notice"
                )
                assert (result.url, result.status, result.body) == (
                    "https://b.test/file.pdf",
                    200,
                    b"PDF",
                )
                assert all(response.disposed for response in context.request.responses)
                outside_cookie_path = await session.download(
                    "https://a.test/public/file.pdf", page_url="https://a.test/notice"
                )
                assert outside_cookie_path.status == 403
                await session.close()

                next_round = await browser.session()
                missing_cookie = await next_round.download(
                    "https://a.test/private/file.pdf", page_url="https://a.test/notice"
                )
                assert missing_cookie.status == 403
                assert clock.now >= INTERVAL
            finally:
                await browser.close()

        assert requested == [
            ("https://a.test/private/file.pdf", "challenge=passed", "https://a.test/notice"),
            ("https://b.test/file.pdf", "", "https://a.test/notice"),
            ("https://a.test/public/file.pdf", "", "https://a.test/notice"),
            ("https://a.test/private/file.pdf", "", "https://a.test/notice"),
        ]

    run(main)


def test_page_permit_covers_challenge_refresh_and_subresources_until_the_page_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()
    ordinary_started = asyncio.Event()
    permits: list[str] = []

    def handle(_request: httpx.Request) -> httpx.Response:
        ordinary_started.set()
        return httpx.Response(200, content=b"next request")

    async def main() -> None:
        async with Fetcher(httpx.MockTransport(handle), clock.clock, clock.sleep) as fetcher:

            async def permit(url: str) -> Permit:
                permits.append(url)
                return await fetcher.permit(url)

            browser = Browser(permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                await page.started.wait()
                configuration = await page.connection.next_command("Fetch.enable")
                assert configuration == {
                    "patterns": [
                        {"urlPattern": "*", "requestStage": "Request", "resourceType": "Document"}
                    ]
                }

                route = driver.contexts[0].route_handler
                assert route is not None
                for resource_type in ("script", "stylesheet", "xhr", "document"):
                    resource = FakeRoute(page, resource_type)
                    await route(resource)
                    assert resource.continued
                    assert not resource.aborted
                image = FakeRoute(page, "image")
                await route(image)
                assert image.aborted

                page.connection.pause("iframe", "https://b.test/frame", frame_id="child")
                await page.connection.next_command("Fetch.continueRequest", request_id="iframe")
                page.begin_navigation("https://a.test/list")
                page.connection.pause("challenge", "https://a.test/list")
                await page.connection.next_command("Fetch.continueRequest", request_id="challenge")
                assert permits == ["https://a.test/list"]
                assert clock.now == 0

                ordinary = asyncio.create_task(fetcher.get("https://a.test/other"))
                await asyncio.sleep(0)
                assert not ordinary_started.is_set()
                page.respond(200)
                page.commit("https://a.test/list", "<html>ready</html>")
                assert (await task).body == b"<html>ready</html>"
                assert page.closed
                assert (await ordinary).body == b"next request"
                assert clock.now == INTERVAL
            finally:
                await browser.close()

    run(main)


def test_opposite_cross_site_redirects_release_old_permits_before_waiting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()

    async def main() -> None:
        async with Fetcher(clock=clock.clock, sleep=clock.sleep) as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                first = asyncio.create_task(session.get("https://a.test/list"))
                second = asyncio.create_task(session.get("https://b.test/list"))
                page_a = await driver.created.get()
                page_b = await driver.created.get()
                await asyncio.gather(page_a.started.wait(), page_b.started.wait())
                page_a.begin_navigation("https://b.test/final")
                page_b.begin_navigation("https://a.test/final")
                page_a.connection.pause("to-b", "https://b.test/final", redirected="initial")
                page_b.connection.pause("to-a", "https://a.test/final", redirected="initial")
                await asyncio.gather(
                    page_a.connection.next_command("Fetch.continueRequest", request_id="to-b"),
                    page_b.connection.next_command("Fetch.continueRequest", request_id="to-a"),
                )

                page_a.respond(200)
                page_a.commit("https://b.test/final", "<html>from b</html>")
                page_b.respond(200)
                page_b.commit("https://a.test/final", "<html>from a</html>")
                responses = await asyncio.gather(first, second)
                assert [(response.url, response.body) for response in responses] == [
                    ("https://b.test/final", b"<html>from b</html>"),
                    ("https://a.test/final", b"<html>from a</html>"),
                ]
                assert page_a.closed
                assert page_b.closed
                assert clock.now >= INTERVAL
            finally:
                await browser.close()

    run(main)


def test_same_document_url_change_during_html_read_keeps_document_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    driver.initial_status = 200
    use_browser(monkeypatch, driver)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                page.content_gate = asyncio.Event()
                await page.content_started.wait()
                page.commit("https://a.test/list?view=all#notices", page.html, loaded=False)
                page.content_gate.set()
                result = await task
                assert result.url == "https://a.test/list?view=all#notices"
                assert result.body == b"<html>challenge</html>"
                assert page.closed
            finally:
                await browser.close()

    run(main)


@pytest.mark.parametrize(
    ("error", "failure"),
    [
        (None, None),
        (PlaywrightTimeoutError("Page.goto timed out"), "timeout"),
        (PlaywrightError("net::ERR_CONNECTION_RESET"), "unreachable"),
        (PlaywrightError("Page.goto: Download is starting"), "unreachable"),
        (PlaywrightError("Unexpected browser error"), None),
    ],
    ids=["cancel", "timeout", "unreachable", "unexpected_download", "unexpected_error"],
)
def test_navigation_failure_or_cancellation_closes_the_page_and_releases_its_permit(
    monkeypatch: pytest.MonkeyPatch,
    error: PlaywrightError | None,
    failure: Failure | None,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()

    async def main() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"still usable"))
        async with Fetcher(transport, clock.clock, clock.sleep) as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                if error is None:
                    await page.started.wait()
                    task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await task
                else:
                    page.navigation_error = error
                    if failure is None:
                        with pytest.raises(PlaywrightError) as browser_error:
                            await task
                        assert browser_error.value is error
                    else:
                        with pytest.raises(FetchError) as source_failure:
                            await task
                        assert source_failure.value.failure == failure
                assert page.closed
                assert driver.active_pages == 0
                assert (await fetcher.get("https://a.test/after-failure")).body == b"still usable"
                assert clock.now == INTERVAL
            finally:
                await browser.close()

    run(main)


def test_cancelling_a_cross_site_wait_leaves_both_sites_usable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()
    destination_requested = asyncio.Event()

    async def main() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"available"))
        async with Fetcher(transport, clock.clock, clock.sleep) as fetcher:

            async def permit(url: str) -> Permit:
                if url == "https://b.test/final":
                    destination_requested.set()
                return await fetcher.permit(url)

            browser = Browser(permit)
            destination = await fetcher.permit("https://b.test/held")
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                await page.started.wait()
                page.begin_navigation("https://b.test/final")
                page.connection.pause("redirect", "https://b.test/final", redirected="initial")
                await destination_requested.wait()
                assert (await fetcher.get("https://a.test/other")).body == b"available"
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert page.closed
                destination.release()
                assert (await fetcher.get("https://b.test/other")).body == b"available"
            finally:
                destination.release()
                await browser.close()

    run(main)


def test_same_site_http_redirect_limit_does_not_count_challenge_refreshes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()

    async def main() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"available"))
        async with Fetcher(transport, clock.clock, clock.sleep) as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                await page.started.wait()
                for index in range(MAX_REDIRECTS + 2):
                    request_id = f"challenge-{index}"
                    page.begin_navigation("https://a.test/list")
                    page.connection.pause(request_id, "https://a.test/list")
                    await page.connection.next_command(
                        "Fetch.continueRequest", request_id=request_id
                    )
                previous = "initial"
                for index in range(MAX_REDIRECTS):
                    request_id = f"redirect-{index}"
                    page.begin_navigation(f"https://a.test/redirect/{index}")
                    page.connection.pause(
                        request_id, f"https://a.test/redirect/{index}", redirected=previous
                    )
                    await page.connection.next_command(
                        "Fetch.continueRequest", request_id=request_id
                    )
                    previous = request_id
                page.begin_navigation("https://a.test/too-far")
                page.connection.pause("over-limit", "https://a.test/too-far", redirected=previous)
                with pytest.raises(FetchError) as caught:
                    await task
                assert caught.value.failure == "too_many_redirects"
                assert not page.connection.continued["over-limit"].is_set()
                assert page.closed
                assert (await fetcher.get("https://a.test/other")).body == b"available"
                assert clock.now == INTERVAL
            finally:
                await browser.close()

    run(main)


def test_challenge_navigation_network_failure_releases_the_page_without_waiting_for_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()

    async def main() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"available"))
        async with Fetcher(transport, clock.clock, clock.sleep) as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                await page.started.wait()
                page.begin_navigation("https://a.test/after-challenge")
                page.connection.pause("challenge", "https://a.test/after-challenge")
                await page.connection.next_command("Fetch.continueRequest", request_id="challenge")
                page.fail(page.navigation, "net::ERR_CONNECTION_REFUSED")

                with pytest.raises(FetchError) as caught:
                    await task
                assert caught.value.failure == "unreachable"
                assert caught.value.url == "https://a.test/after-challenge"
                assert page.closed
                assert (await fetcher.get("https://a.test/other")).body == b"available"
                assert clock.now == INTERVAL
            finally:
                await browser.close()

    run(main)


def test_aborted_navigation_and_old_or_subresource_failures_allow_the_replacement_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                task = asyncio.create_task(session.get("https://a.test/list"))
                page = await driver.created.get()
                await page.started.wait()
                previous = page.navigation
                page.fail(previous, "net::ERR_ABORTED")
                await asyncio.sleep(0)
                assert not task.done()

                page.begin_navigation("https://a.test/final")
                page.fail(previous, "net::ERR_CONNECTION_REFUSED")
                script = FakeNavigation(
                    page.main_frame, "https://a.test/optional.js", navigation=False
                )
                page.fail(script, "net::ERR_CONNECTION_REFUSED")
                iframe = FakeNavigation(FakeFrame(page), "https://b.test/optional-frame")
                page.fail(iframe, "net::ERR_CONNECTION_REFUSED")
                await asyncio.sleep(0)
                assert not task.done()

                page.connection.pause("replacement", "https://a.test/final")
                await page.connection.next_command(
                    "Fetch.continueRequest", request_id="replacement"
                )
                page.respond(200)
                page.commit("https://a.test/final", "<html>replacement document</html>")
                assert (await task).body == b"<html>replacement document</html>"
                assert page.closed
            finally:
                await browser.close()

    run(main)


def test_cancelling_context_creation_waits_for_and_closes_the_unclaimed_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    driver.context_gate = asyncio.Event()
    use_browser(monkeypatch, driver)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            task = asyncio.create_task(browser.session())
            try:
                await driver.context_created.wait()
                task.cancel()
                await asyncio.sleep(0)
                assert not task.done()
                assert not driver.contexts[0].closed
                assert driver.context_gate is not None
                driver.context_gate.set()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert driver.contexts[0].closed
                assert not browser.sessions
            finally:
                assert driver.context_gate is not None
                driver.context_gate.set()
                await asyncio.gather(task, return_exceptions=True)
                await browser.close()
                for context in driver.contexts:
                    await context.close()

    run(main)


@pytest.mark.parametrize("expired", [False, True], ids=["cancel", "timeout"])
def test_interrupted_page_creation_closes_the_page_before_releasing_its_slot(
    monkeypatch: pytest.MonkeyPatch, expired: bool
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)

    async def main() -> None:
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            session = await browser.session()
            context = driver.contexts[0]
            context.page_gate = asyncio.Event()
            deadlines: list[asyncio.Timeout] = []
            timeout = asyncio.timeout

            def deadline(_seconds: float) -> asyncio.Timeout:
                timer = timeout(None)
                deadlines.append(timer)
                return timer

            monkeypatch.setattr("crawler.crawl.browser.asyncio.timeout", deadline)
            task = asyncio.create_task(session.get("https://a.test/list"))
            page = await driver.created.get()
            page.close_gate = asyncio.Event()
            blocked: asyncio.Task[bool] | None = None
            try:
                if expired:
                    deadlines[0].reschedule(asyncio.get_running_loop().time())
                else:
                    task.cancel()
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                assert not task.done()
                context.page_gate.set()
                await page.close_started.wait()
                await browser.slots.acquire()
                blocked = asyncio.create_task(browser.slots.acquire())
                await asyncio.sleep(0)
                assert not blocked.done()
                assert not page.closed
                page.close_gate.set()
                if expired:
                    with pytest.raises(FetchError) as caught:
                        await task
                    assert caught.value.failure == "timeout"
                else:
                    with pytest.raises(asyncio.CancelledError):
                        await task
                await blocked
                browser.slots.release()
                browser.slots.release()
                assert page.closed
                assert driver.active_pages == 0
            finally:
                context.page_gate.set()
                page.close_gate.set()
                if blocked is not None and not blocked.done():
                    blocked.cancel()
                await asyncio.gather(task, return_exceptions=True)
                if blocked is not None:
                    await asyncio.gather(blocked, return_exceptions=True)
                await browser.close()

    run(main)


@pytest.mark.parametrize("page_creation", [False, True], ids=["context", "page"])
def test_creation_failure_after_cancellation_is_propagated_once(
    monkeypatch: pytest.MonkeyPatch, page_creation: bool
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)

    async def main() -> None:
        started, finish = asyncio.Event(), asyncio.Event()
        error = RuntimeError("Resource creation failed")
        unhandled: list[dict[str, object]] = []
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()

        def unexpected(_loop: asyncio.AbstractEventLoop, context: dict[str, object]) -> None:
            unhandled.append(context)

        loop.set_exception_handler(unexpected)
        async with Fetcher() as fetcher:
            browser = Browser(fetcher.permit)
            if page_creation:
                session = await browser.session()

                async def create_page() -> FakePage:
                    started.set()
                    await finish.wait()
                    raise error

                monkeypatch.setattr(driver.contexts[0], "new_page", create_page)

                async def operation() -> object:
                    return await session.get("https://a.test/list")

            else:

                async def create_context(**_options: object) -> FakeContext:
                    started.set()
                    await finish.wait()
                    raise error

                monkeypatch.setattr(driver, "new_context", create_context)

                async def operation() -> object:
                    return await browser.session()

            task = asyncio.create_task(operation())
            try:
                await started.wait()
                task.cancel()
                await asyncio.sleep(0)
                assert not task.done()
                finish.set()
                with pytest.raises(RuntimeError) as caught:
                    await task
                assert caught.value is error
                await asyncio.sleep(0)
                assert not unhandled
                assert driver.active_pages == 0
            finally:
                finish.set()
                await asyncio.gather(task, return_exceptions=True)
                loop.set_exception_handler(previous_handler)
                await browser.close()

    run(main)


@pytest.mark.parametrize(
    ("message", "failure"),
    [
        ("APIRequestContext.get: self-signed certificate", "unreachable"),
        ("APIRequestContext.get: certificate has expired", "unreachable"),
        ("APIRequestContext.get: unable to verify the first certificate", "unreachable"),
        (
            "APIRequestContext.get: Hostname/IP does not match certificate's altnames:"
            " Host: a.test",
            "unreachable",
        ),
        (
            "APIRequestContext.get: failed to decompress 'gzip' encoding: incorrect header",
            "unreachable",
        ),
        ("APIRequestContext.get: Unknown internal failure", None),
        (
            "APIRequestContext.get: Unknown internal failure\nCall log:\n"
            "  - User-Agent: ECONNRESET self-signed certificate\n",
            None,
        ),
    ],
    ids=["self_signed", "expired", "unverified", "hostname", "compression", "unknown", "call_log"],
)
def test_attachment_transport_errors_release_the_permit_and_preserve_unknown_errors(
    monkeypatch: pytest.MonkeyPatch, message: str, failure: Failure | None
) -> None:
    driver = FakeBrowser()
    use_browser(monkeypatch, driver)
    clock = FakeClock()

    async def main() -> None:
        transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"still available"))
        async with Fetcher(transport, clock.clock, clock.sleep) as fetcher:
            browser = Browser(fetcher.permit)
            try:
                session = await browser.session()
                error = PlaywrightError(message)
                driver.contexts[0].request.error = error
                if failure is None:
                    with pytest.raises(PlaywrightError) as caught:
                        await session.download(
                            "https://a.test/file.pdf", page_url="https://a.test/notice"
                        )
                    assert caught.value is error
                else:
                    with pytest.raises(FetchError) as source_failure:
                        await session.download(
                            "https://a.test/file.pdf", page_url="https://a.test/notice"
                        )
                    assert source_failure.value.failure == failure
                assert (
                    await fetcher.get("https://a.test/after-failure")
                ).body == b"still available"
                assert clock.now == INTERVAL
            finally:
                await browser.close()

    run(main)
