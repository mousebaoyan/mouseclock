import asyncio
from collections.abc import Awaitable, Callable
from datetime import date
from pathlib import Path
from typing import Never

import httpx
import pytest
from pydantic import JsonValue

from crawler.crawl.browser import Browser
from crawler.crawl.browser_test import FakeBrowser, FakePage, FakePlaywright
from crawler.crawl.contract import ListedItem, ProbeReport, Usage, WorkProbe
from crawler.crawl.fetch import Fetcher
from crawler.crawl.fetch_test import FakeSites
from crawler.crawl.probe import probe_source
from crawler.crawl.rounds import StepError
from crawler.crawl.website import Website
from crawler.parse.listing import ListConfig, Selectors, parse_listing

BASE = "https://example.edu/list.html"
FIXTURES = Path(__file__).parents[1] / "parse" / "fixtures" / "listing"
BODY = (FIXTURES / "probe.html").read_bytes()
CONFIG = ListConfig(
    selectors=Selectors(
        items="//section[@id='notices']/article",
        title="./h2/a",
        link="./h2/a/@href",
        date="./span[@class='date']",
        next="//a[@rel='next']/@href",
    )
)
USAGE = Usage(model="fixed-model", input_tokens=120, output_tokens=40)
type Generate = Callable[[bytes, str, str | None, list[Usage]], Awaitable[ListConfig]]


async def unused(*_: object) -> Never:
    raise AssertionError("Model must not be called")


def work(config: dict[str, JsonValue] | None = None) -> WorkProbe:
    return WorkProbe(id=46, url=BASE, browser=False, config=config)


def run_probe(probe: WorkProbe, sites: FakeSites, generate: Generate = unused) -> ProbeReport:
    reports: list[ProbeReport] = []

    def receive(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/crawler/probes/46"
        reports.append(ProbeReport.model_validate_json(request.content))
        return httpx.Response(204)

    async def main(fetcher: Fetcher) -> None:
        async with Website(
            "https://website.example", "fake-token", httpx.MockTransport(receive)
        ) as site:
            await probe_source(probe, Browser(fetcher), site, generate)

    sites.run(main)
    [report] = reports
    return report


def test_generic_and_explicit_configuration_report_preview_without_calling_model() -> None:
    generic_sites = FakeSites(
        {BASE: httpx.Response(200, content=(FIXTURES / "vsb.html").read_bytes())}
    )
    generic = run_probe(work(), generic_sites)
    assert generic.failure is None
    assert len(generic.items) == 2
    assert generic.items[0].title == "示例招生通知甲"
    assert generic.suggested_config is None
    assert generic.usage == []

    configured_sites = FakeSites({BASE: httpx.Response(200, content=BODY)})
    configured = run_probe(work(CONFIG.model_dump(mode="json")), configured_sites)
    assert configured.failure is None
    assert [item.title for item in configured.items] == ["自编招生通知甲", "自编招生通知乙"]
    assert ListConfig.model_validate(configured.suggested_config) == CONFIG
    assert configured.usage == []
    assert [url for _, url in configured_sites.requests] == [BASE]


def test_generated_configuration_is_applied_to_the_same_page_and_reported() -> None:
    sites = FakeSites(
        {BASE: httpx.Response(200, content=BODY, headers={"content-type": "text/html"})}
    )
    assert parse_listing(BODY, BASE).items == []

    async def generate(
        body: bytes, url: str, content_type: str | None, usage: list[Usage]
    ) -> ListConfig:
        assert (body, url, content_type) == (BODY, BASE, "text/html")
        usage.append(USAGE)
        return CONFIG

    report = run_probe(work(), sites, generate)
    assert report.failure is None
    assert report.items == [
        ListedItem(
            url="https://example.edu/notice/101.html",
            title="自编招生通知甲",
            published_on=date(2026, 9, 10),
        ),
        ListedItem(
            url="https://example.edu/notice/102.html",
            title="自编招生通知乙",
            published_on=date(2026, 9, 9),
        ),
    ]
    assert ListConfig.model_validate(report.suggested_config) == CONFIG
    assert report.usage == [USAGE]
    assert [url for _, url in sites.requests] == [BASE]


@pytest.mark.parametrize("invalid_output", [True, False])
def test_failed_generation_or_empty_result_preserves_usage(invalid_output: bool) -> None:
    async def generate(
        _body: bytes, _url: str, _content_type: str | None, usage: list[Usage]
    ) -> ListConfig:
        usage.append(USAGE)
        if invalid_output:
            raise StepError("error", "试抓配置无效")
        return ListConfig(selectors=Selectors(items="//missing", title="./a", link="./a/@href"))

    report = run_probe(work(), FakeSites({BASE: httpx.Response(200, content=BODY)}), generate)
    assert report.failure == ("error" if invalid_output else "no_items")
    assert report.items == []
    assert report.suggested_config is None
    assert report.usage == [USAGE]


@pytest.mark.parametrize(
    ("config", "failure", "detail"),
    [
        (
            {"selectors": {"items": "[", "title": "./a", "link": "./a"}},
            "error",
            "配置不对: selectors.items",
        ),
        (
            {"selectors": {"items": "count(//article)", "title": "./a", "link": "./a"}},
            "error",
            "items 必须选中条目元素",
        ),
        ({}, "no_items", None),
    ],
)
def test_explicit_configuration_failure_does_not_invoke_model(
    config: dict[str, JsonValue], failure: str, detail: str | None
) -> None:
    report = run_probe(work(config), FakeSites({BASE: httpx.Response(200, content=BODY)}))
    assert report.failure == failure
    assert report.detail == detail
    assert report.items == []
    assert report.suggested_config is None
    assert report.usage == []


@pytest.mark.parametrize("status", [403, 500])
def test_http_failure_is_reported_without_generating_configuration(status: int) -> None:
    report = run_probe(
        work(), FakeSites({BASE: httpx.Response(status, text="private failure body")})
    )
    assert report.failure == "http_status"
    assert report.detail is not None
    assert str(status) in report.detail
    assert "private failure body" not in report.model_dump_json()
    assert report.usage == []


def test_timeout_is_reported_without_generating_configuration() -> None:
    reports: list[ProbeReport] = []

    def timeout(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("private transport detail")

    def receive(request: httpx.Request) -> httpx.Response:
        reports.append(ProbeReport.model_validate_json(request.content))
        return httpx.Response(204)

    async def main() -> None:
        async with (
            Fetcher(httpx.MockTransport(timeout)) as fetcher,
            Website(
                "https://website.example", "fake-token", httpx.MockTransport(receive)
            ) as website,
        ):
            await probe_source(work(), Browser(fetcher), website, unused)

    asyncio.run(main())
    [report] = reports
    assert report.failure == "timeout"
    assert report.usage == []
    assert "private transport detail" not in report.model_dump_json()


def test_explicit_http_and_redirect_determine_link_base() -> None:
    config = CONFIG.model_copy(update={"force_http": True})
    destination = "http://example.edu/admission/list.html"
    sites = FakeSites(
        {
            BASE.replace("https:", "http:"): httpx.Response(302, headers={"location": destination}),
            destination: httpx.Response(200, content=BODY),
        }
    )
    report = run_probe(work(config.model_dump(mode="json")), sites)
    assert report.failure is None
    assert report.items[0].url == "http://example.edu/admission/notice/101.html"
    assert ListConfig.model_validate(report.suggested_config).force_http
    assert [url for _, url in sites.requests] == [BASE.replace("https:", "http:"), destination]


def test_reporting_failure_propagates_for_lease_recovery() -> None:
    def receive(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    async def main(fetcher: Fetcher) -> None:
        async with Website(
            "https://website.example", "fake-token", httpx.MockTransport(receive)
        ) as website:
            await probe_source(
                work(CONFIG.model_dump(mode="json")), Browser(fetcher), website, unused
            )

    sites = FakeSites({BASE: httpx.Response(200, content=BODY)})
    with pytest.raises(httpx.HTTPStatusError):
        sites.run(main)


def test_browser_probe_parses_rendered_page_and_closes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driver = FakeBrowser()
    monkeypatch.setattr("crawler.crawl.browser.async_playwright", lambda: FakePlaywright(driver))

    async def content(_self: FakePage) -> str:
        return BODY.decode("utf-8")

    monkeypatch.setattr(FakePage, "content", content)
    reports: list[ProbeReport] = []

    def receive(request: httpx.Request) -> httpx.Response:
        reports.append(ProbeReport.model_validate_json(request.content))
        return httpx.Response(204)

    def no_http(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("Browser probe must use rendered HTML")

    async def main() -> None:
        async with (
            Fetcher(httpx.MockTransport(no_http)) as fetcher,
            Browser(fetcher) as browser,
            Website(
                "https://website.example", "fake-token", httpx.MockTransport(receive)
            ) as website,
        ):
            probe = work(CONFIG.model_dump(mode="json")).model_copy(update={"browser": True})
            await probe_source(probe, browser, website, unused)

    asyncio.run(main())
    [report] = reports
    assert report.failure is None
    assert len(report.items) == 2
    [context] = driver.contexts
    assert context.closed
    assert len(context.pages) == 1
    assert context.pages[0].closed
