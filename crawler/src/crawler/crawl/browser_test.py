import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx
import pytest
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from crawler.crawl.browser import Browser
from crawler.crawl.fetch import INTERVAL, Failure, Fetcher, FetchError


def run(main: Callable[[], Awaitable[None]]) -> None:
    async def bounded() -> None:
        async with asyncio.timeout(5):
            await main()

    asyncio.run(bounded())


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds
        await asyncio.sleep(0)


@dataclass
class FakeRequest:
    frame: object
    navigation: bool

    def is_navigation_request(self) -> bool:
        return self.navigation


@dataclass
class FakeResponse:
    status: int
    request: FakeRequest


class FakePage:
    def __init__(self, context: FakeContext) -> None:
        self.context = context
        self.main_frame = object()
        self.url = "about:blank"
        self.closed = False
        self.ready = asyncio.Event()
        self.handlers: dict[str, Callable[[FakeResponse], None]] = {}

    def on(self, event: str, callback: Callable[[FakeResponse], None]) -> None:
        self.handlers[event] = callback

    async def goto(self, url: str, *, wait_until: str, **_options: object) -> None:
        assert wait_until == "networkidle"
        driver = self.context.driver
        self.url = driver.destination or url
        driver.started.put_nowait(self)
        if driver.block_pages:
            await self.ready.wait()
        if driver.error is not None:
            raise driver.error
        for status, navigation, main_frame in driver.responses:
            frame = self.main_frame if main_frame else object()
            self.handlers["response"](FakeResponse(status, FakeRequest(frame, navigation)))

    async def content(self) -> str:
        return "<html>保研通知</html>"

    async def close(self) -> None:
        self.closed = True


class FakeDownload:
    def __init__(self, url: str, body: bytes) -> None:
        self.url = url
        self.status = 200
        self.headers = {"content-type": "application/pdf"}
        self.data = body
        self.disposed = False

    async def body(self) -> bytes:
        return self.data

    async def dispose(self) -> None:
        self.disposed = True


class FakeDownloads:
    def __init__(self, context: FakeContext) -> None:
        self.context = context
        self.responses: list[FakeDownload] = []

    async def get(self, url: str, *, headers: dict[str, str], **_options: object) -> FakeDownload:
        if self.context.driver.error is not None:
            raise self.context.driver.error
        response = FakeDownload(
            url, f"%PDF context {self.context.number}: {headers['Referer']}".encode()
        )
        self.responses.append(response)
        return response


class FakeContext:
    def __init__(self, driver: FakeBrowser, number: int) -> None:
        self.driver = driver
        self.number = number
        self.request = FakeDownloads(self)
        self.pages: list[FakePage] = []
        self.closed = False

    async def route(self, _pattern: str, _handler: object) -> None:
        pass

    def on(self, _event: str, _handler: object) -> None:
        pass

    async def new_page(self) -> FakePage:
        page = FakePage(self)
        self.pages.append(page)
        return page

    async def close(self) -> None:
        self.closed = True


class FakeBrowser:
    def __init__(self) -> None:
        self.contexts: list[FakeContext] = []
        self.started: asyncio.Queue[FakePage] = asyncio.Queue()
        self.block_pages = False
        self.destination: str | None = None
        self.error: PlaywrightError | None = None
        self.responses = [(200, True, True)]

    async def new_context(self, **_options: object) -> FakeContext:
        context = FakeContext(self, len(self.contexts) + 1)
        self.contexts.append(context)
        return context


@pytest.fixture
def driver(monkeypatch: pytest.MonkeyPatch) -> FakeBrowser:
    browser = FakeBrowser()

    async def start(_owner: object) -> FakeBrowser:
        return browser

    monkeypatch.setattr("crawler.crawl.browser.Browser._start", start)
    return browser


def test_page_visits_and_http_requests_wait_for_each_other(driver: FakeBrowser) -> None:
    driver.block_pages = True
    clock = FakeClock()
    http_started = asyncio.Event()
    finish_http = asyncio.Event()
    request_times: list[float] = []

    async def handle(_request: httpx.Request) -> httpx.Response:
        request_times.append(clock.now)
        http_started.set()
        await finish_http.wait()
        return httpx.Response(200)

    async def main() -> None:
        async with (
            Fetcher(httpx.MockTransport(handle), clock.clock, clock.sleep) as fetcher,
            fetcher.session(True, url="https://a/list") as session,
        ):
            first_http = asyncio.create_task(fetcher.get("https://a/first"))
            await http_started.wait()
            visit = asyncio.create_task(session.get("https://a/list"))
            await asyncio.sleep(0)
            assert driver.started.empty()
            clock.now = 2
            finish_http.set()
            await first_http
            page = await driver.started.get()
            assert clock.now == 2 + INTERVAL
            second_http = asyncio.create_task(fetcher.get("https://a/second"))
            await asyncio.sleep(0)
            assert request_times == [0]
            clock.now = 10
            page.ready.set()
            await visit
            await second_http
            assert page.closed
            assert request_times == [0, 10 + INTERVAL]

    run(main)


def test_page_limit_is_shared_by_rounds(driver: FakeBrowser) -> None:
    driver.block_pages = True

    async def main() -> None:
        async with (
            Fetcher() as fetcher,
            fetcher.session(True, url="https://a/list") as first,
            fetcher.session(True, url="https://b/list") as second,
        ):
            tasks = [
                asyncio.create_task(first.get("https://a/list")),
                asyncio.create_task(second.get("https://b/list")),
                asyncio.create_task(first.get("https://c/list")),
            ]
            first_page = await driver.started.get()
            second_page = await driver.started.get()
            await asyncio.sleep(0)
            assert sum(len(context.pages) for context in driver.contexts) == 2
            first_page.ready.set()
            third_page = await driver.started.get()
            assert first_page.closed
            second_page.ready.set()
            third_page.ready.set()
            await asyncio.gather(*tasks)
            assert all(page.closed for context in driver.contexts for page in context.pages)

    run(main)


def test_each_round_opens_reuses_and_closes_its_context(driver: FakeBrowser) -> None:
    clock = FakeClock()

    async def main() -> None:
        async with Fetcher(clock=clock.clock, sleep=clock.sleep) as fetcher:
            async with fetcher.session(False, url="https://a/list"):
                assert driver.contexts == []
            async with fetcher.session(True, url="https://a/list") as session:
                assert len(driver.contexts) == 1
                await session.get("https://a/list")
                await session.get("https://a/notice")
                assert len(driver.contexts[0].pages) == 2
                assert not driver.contexts[0].closed
            assert driver.contexts[0].closed
            async with fetcher.session(True, url="https://a/list"):
                assert len(driver.contexts) == 2
            assert driver.contexts[1].closed

    run(main)


def test_downloads_use_the_rounds_context_request_client(driver: FakeBrowser) -> None:
    clock = FakeClock()

    async def main() -> None:
        async with Fetcher(clock=clock.clock, sleep=clock.sleep) as fetcher:
            for number in (1, 2):
                async with fetcher.session(True, url="https://a/list") as session:
                    await session.get("https://a/notice")
                    attachment = await session.download(
                        "https://a/file.pdf", page_url="https://a/notice"
                    )
                    assert attachment.body == f"%PDF context {number}: https://a/notice".encode()
                    assert attachment.content_type == "application/pdf"
                    assert driver.contexts[number - 1].request.responses[0].disposed

    run(main)


def test_last_main_navigation_response_is_used_without_a_cross_site_permit(
    driver: FakeBrowser,
) -> None:
    driver.destination = "https://b/notice"
    driver.responses = [
        (202, True, True),
        (200, True, True),
        (404, False, True),
        (500, True, False),
    ]

    async def main() -> None:
        async with Fetcher() as fetcher:
            destination_permit = await fetcher.permit("https://b/busy")
            try:
                async with fetcher.session(True, url="https://a/list") as session:
                    response = await session.get("https://a/notice")
                    assert response.status == 200
                    assert response.url == "https://b/notice"
                    assert response.body.decode() == "<html>保研通知</html>"
            finally:
                destination_permit.release()

    run(main)


@pytest.mark.parametrize("status", [202, 412])
def test_unresolved_challenges_fail(driver: FakeBrowser, status: int) -> None:
    driver.responses = [(status, True, True)]

    async def main() -> None:
        async with Fetcher() as fetcher, fetcher.session(True, url="https://a/list") as session:
            with pytest.raises(FetchError) as caught:
                await session.get("https://a/list")
            assert caught.value.failure == "unreachable"
            assert driver.contexts[0].pages[0].closed

    run(main)


@pytest.mark.parametrize(
    ("error", "failure"),
    [
        (PlaywrightTimeoutError("Timed out"), "timeout"),
        (PlaywrightError("Browser request failed"), "unreachable"),
    ],
)
@pytest.mark.parametrize("download", [False, True])
def test_playwright_errors_become_fetch_errors(
    driver: FakeBrowser, error: PlaywrightError, failure: Failure, *, download: bool
) -> None:
    driver.error = error
    clock = FakeClock()

    async def main() -> None:
        async with (
            Fetcher(clock=clock.clock, sleep=clock.sleep) as fetcher,
            fetcher.session(True, url="https://a/list") as session,
        ):
            operation = (
                session.download("https://a/file.pdf", page_url="https://a/notice")
                if download
                else session.get("https://a/notice")
            )
            with pytest.raises(FetchError) as caught:
                await operation
            assert caught.value.failure == failure
            driver.error = None
            assert (await session.get("https://a/retry")).status == 200
            assert clock.now == INTERVAL

    run(main)


@pytest.mark.parametrize("stage", ["start", "context", "configure"])
@pytest.mark.parametrize(
    ("error", "failure"),
    [
        (PlaywrightTimeoutError("Timed out"), "timeout"),
        (PlaywrightError("Browser initialization failed"), "unreachable"),
    ],
)
def test_initialization_errors_include_the_source_url(
    monkeypatch: pytest.MonkeyPatch,
    driver: FakeBrowser,
    stage: str,
    error: PlaywrightError,
    failure: Failure,
) -> None:
    async def fail(*_args: object, **_options: object) -> None:
        raise error

    if stage == "start":
        monkeypatch.setattr(Browser, "_start", fail)
    elif stage == "context":
        monkeypatch.setattr(FakeBrowser, "new_context", fail)
    else:
        monkeypatch.setattr(FakeContext, "route", fail)

    async def main() -> None:
        async with Fetcher() as fetcher:
            with pytest.raises(FetchError) as caught:
                await fetcher.browser().session("https://a/list")
            assert caught.value.failure == failure
            assert caught.value.url == "https://a/list"
            assert all(context.closed for context in driver.contexts)

    run(main)
