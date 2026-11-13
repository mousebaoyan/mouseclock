from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from pydantic import JsonValue

from crawler.crawl.browser import Browser, PageSession
from crawler.crawl.contract import WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.fetch_test import FakeSites
from crawler.crawl.listing import list_items
from crawler.crawl.rounds import NoticePage, StepError, Steps, crawl_source
from crawler.crawl.rounds_test import FakeWebsite, extract, screen
from crawler.crawl.website import Website
from crawler.parse.listing import Selectors, parse_listing

FIXTURES = Path(__file__).parent / "fixtures" / "listing"
BASE = "https://example.edu.cn/notices.htm"
TODAY = date(2026, 11, 7)


def source(*, backfill: bool = False, config: dict[str, JsonValue] | None = None) -> WorkSource:
    return WorkSource(id=7, url=BASE, browser=False, config=config, backfill=backfill)


def page(rows: list[tuple[str, str | None]], following: str | None = None) -> bytes:
    items = "".join(
        f'<li><a href="/info/1001/{number}.htm">自编通知{number}</a>'
        f'<span class="date">{published or ""}</span></li>'
        for number, published in rows
    )
    next_link = f'<a rel="next" href="{following}">下一页</a>' if following else ""
    return f'<meta charset="utf-8"><ul>{items}</ul>{next_link}'.encode()


@pytest.mark.parametrize(
    ("name", "urls", "next_url"),
    [
        ("vsb", ["/info/1001/101.htm", "/info/1001/102.htm"], "https://example.edu.cn/page2.htm"),
        (
            "vsb-calendar",
            ["/info/1001/101.htm", "/info/1001/102.htm"],
            "https://example.edu.cn/page2.htm",
        ),
        (
            "webplus",
            ["/2026/0910/c100a101/page.htm", "/2026/0910/c100a102/page.htm"],
            "https://example.edu.cn/page2.htm",
        ),
        ("trs", ["https://admission.example.edu.cn/notice/1", "/202609/t20260909_102.html"], None),
        (
            "gpower",
            ["/" + "1" * 32 + ".htm", "/" + "2" * 32 + ".htm"],
            "https://example.edu.cn/page2.htm",
        ),
        ("drupal", ["/article/101", "/article/102"], "https://example.edu.cn/notices.htm?page=1"),
    ],
)
def test_real_cms_structures_keep_titles_dates_and_links(
    name: str, urls: list[str], next_url: str | None
) -> None:
    result = parse_listing((FIXTURES / f"{name}.html").read_bytes(), BASE)
    assert [item.title for item in result.items] == ["示例招生通知甲", "示例招生通知乙"]
    assert [item.published_on for item in result.items] == [date(2026, 9, 10), date(2026, 9, 9)]
    expected = [
        value if value.startswith("https:") else "https://example.edu.cn" + value for value in urls
    ]
    assert [item.url for item in result.items] == expected
    assert result.next_url == next_url


def test_configured_structure_and_legacy_encoding() -> None:
    selectors = Selectors(
        items="//ul[@class='b-list']/li",
        title="normalize-space(.//a)",
        link=".//a/@href",
        date=".//span[@class='m-date']",
    )
    text = (FIXTURES / "configured.html").read_text(encoding="utf-8")
    result = parse_listing(text.encode("gb18030"), BASE, selectors, "text/html; charset=gb18030")
    assert [(item.title, item.published_on) for item in result.items] == [
        ("示例招生通知甲", date(2026, 9, 10)),
        ("示例招生通知乙", date(2026, 9, 9)),
    ]
    assert result.items[0].url == "https://example.edu.cn/showarticle/Article/example/101"


def test_documented_http_configuration_reads_the_real_page_structure() -> None:
    config: dict[str, JsonValue] = {
        "selectors": {
            "items": "//div[contains(concat(' ',normalize-space(@class),' '),' jzlb ')]",
            "title": "./div[@class='btt3']/a",
            "link": "./div[@class='btt3']/a/@href",
            "date": "./div[@class='fbsj4']",
            "next": "//a[@class='next']/@href",
        },
        "force_http": True,
    }
    sites = FakeSites(
        {
            "http://example.edu.cn/notices.htm": httpx.Response(
                200, content=(FIXTURES / "zju-http.html").read_bytes()
            )
        }
    )
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(config=config),
            clock=lambda: datetime(2026, 11, 7, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [(item.title, item.published_on) for item in result] == [
        ("示例招生通知甲", date(2026, 9, 10)),
        ("示例招生通知乙", date(2026, 9, 9)),
    ]
    assert result[0].url == "http://example.edu.cn/csen/2026/0910/c27006a101/page.htm"


@pytest.mark.parametrize("backfill", [False, True])
def test_backfill_keeps_boundary_and_unknown_dates_and_ignores_repeated_pinned_rows(
    backfill: bool,
) -> None:
    sites = FakeSites(
        {
            BASE: httpx.Response(
                200,
                content=page([("1", "2026-09-10"), ("2", "2026-09-09"), ("9", "2020-01-01")], "p2"),
            ),
            "https://example.edu.cn/p2": httpx.Response(
                200,
                content=page(
                    [("1", "2026-09-10"), ("3", "2024-11-07"), ("4", None), ("5", "2024-11-06")],
                    "p3",
                ),
            ),
            "https://example.edu.cn/p3": httpx.Response(
                200,
                content=page([("1", "2026-09-10"), ("6", "2024-10-01")], "must-not-fetch"),
            ),
        }
    )
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(backfill=backfill),
            clock=lambda: datetime(2026, 11, 7, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [item.title for item in result] == (
        ["自编通知1", "自编通知2", "自编通知3", "自编通知4"]
        if backfill
        else ["自编通知1", "自编通知2", "自编通知9"]
    )
    assert len(sites.requests) == (3 if backfill else 1)


def test_leap_day_backfill_uses_calendar_years() -> None:
    sites = FakeSites(
        {
            BASE: httpx.Response(200, content=page([("1", "2022-02-28")], "p2")),
            "https://example.edu.cn/p2": httpx.Response(
                200, content=page([("2", "2022-02-27")], "must-not-fetch")
            ),
        }
    )
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(backfill=True),
            clock=lambda: datetime(2024, 2, 29, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [item.published_on for item in result] == [date(2022, 2, 28)]
    assert len(sites.requests) == 2


def test_numbered_pager_advances_one_page_and_stops_at_last() -> None:
    pager = (
        '<ul class="pager-items"><li class="pager-item"><a href="?page=0" {first}>当前页 1</a></li>'
        '<li class="pager-item"><a href="?page=1" {second}>页面 2</a></li>'
        '<li class="pager-item"><a href="?page=1">末页</a></li></ul>'
    )
    sites = FakeSites(
        {
            BASE: httpx.Response(
                200,
                content=page([("1", "2026-09-10")])
                + pager.format(first='aria-current="page"', second="").encode(),
            ),
            BASE + "?page=1": httpx.Response(
                200,
                content=page([("2", "2026-09-09")])
                + pager.format(first="", second='aria-current="page"').encode(),
            ),
        }
    )
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(backfill=True),
            clock=lambda: datetime(2026, 11, 7, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [item.title for item in result] == ["自编通知1", "自编通知2"]
    assert len(sites.requests) == 2


@pytest.mark.parametrize("configured", [False, True])
def test_explicit_http_config_and_redirect_base_are_used_for_pagination_and_links(
    configured: bool,
) -> None:
    sites = FakeSites(
        {
            "http://example.edu.cn/notices.htm": httpx.Response(
                302, headers={"location": "http://example.edu.cn/board/index.htm"}
            ),
            "http://example.edu.cn/board/index.htm": httpx.Response(
                200,
                content=page([("1", "2026-09-10")], "https://example.edu.cn/board/p2").replace(
                    b"/info/1001/1.htm", b"./info/1001/1.htm#section"
                ),
            ),
            "http://example.edu.cn/board/p2": httpx.Response(
                200, content=page([("2", "2023-01-01")])
            ),
        }
    )
    selectors: dict[str, JsonValue] = {
        "items": "//li",
        "title": ".//a",
        "link": ".//a/@href",
        "date": ".//span",
        "next": "//a[@rel='next']/@href",
    }
    config: dict[str, JsonValue] = {"force_http": True}
    if configured:
        config["selectors"] = selectors
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(backfill=True, config=config),
            clock=lambda: datetime(2026, 11, 7, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [item.url for item in result] == ["http://example.edu.cn/board/info/1001/1.htm"]
    assert [url for _, url in sites.requests] == list(sites.pages)


@pytest.mark.parametrize(
    ("config", "detail"),
    [
        ({"unknown": True}, "配置不对: unknown"),
        ({"force_http": "true"}, "配置不对: force_http"),
        (
            {"selectors": {"items": "[", "title": ".//a", "link": ".//a/@href"}},
            "配置不对: selectors.items",
        ),
        (
            {"selectors": {"items": "string(//li)", "title": ".//a", "link": ".//a/@href"}},
            "items 必须选中条目元素",
        ),
        (
            {"selectors": {"items": "//li", "title": ".//missing:title", "link": ".//a/@href"}},
            "XPath 无法计算",
        ),
    ],
)
def test_bad_configuration_is_recorded_by_the_round(
    config: dict[str, JsonValue], detail: str
) -> None:
    sites = FakeSites({BASE: httpx.Response(200, content=page([("1", "2026-09-10")]))})
    website = FakeWebsite([], frozenset())

    async def read(_pages: PageSession, _source: WorkSource, _url: str) -> NoticePage:
        raise AssertionError("a failed list must not read notices")

    async def run(fetcher: Fetcher) -> None:
        async with Website(
            "http://site", "local-test", httpx.MockTransport(website.handle)
        ) as client:
            await crawl_source(
                source(config=config),
                Browser(fetcher),
                client,
                Steps(list_items, screen, read, extract),
            )

    sites.run(run)
    [record] = website.called("POST /runs")
    assert record["failure"] == "error"
    assert record["detail"] == detail
    assert website.called("POST /sources/7/listing") == []


@pytest.mark.parametrize("status", [403, 500])
def test_historical_http_failure_does_not_return_partial_backfill(status: int) -> None:
    sites = FakeSites(
        {
            BASE: httpx.Response(200, content=page([("1", "2026-09-10")], "p2")),
            "https://example.edu.cn/p2": httpx.Response(status),
        }
    )
    with pytest.raises(StepError, match=f"HTTP {status}") as caught:
        sites.run(
            lambda f: list_items(
                PageSession(f, None),
                source(backfill=True),
                clock=lambda: datetime(
                    2026, 11, 7, tzinfo=timezone(timedelta(hours=8))
                ).timestamp(),
            )
        )
    assert caught.value.failure == "http_status"


def test_unknown_and_invalid_dates_do_not_invent_publication_dates() -> None:
    body = page([("1", "2026-02-30"), ("2", "9月1日")])
    result = parse_listing(body, BASE)
    assert [item.published_on for item in result.items] == [None, None]
    assert parse_listing(b"<nav><a href='/about'>About</a></nav>", BASE).items == []
    assert parse_listing(b"", BASE).items == []


def test_cyclic_pagination_finishes_backfill_without_discarding_items() -> None:
    sites = FakeSites(
        {
            BASE: httpx.Response(200, content=page([("1", "2026-09-10")], "p2")),
            "https://example.edu.cn/p2": httpx.Response(
                200, content=page([("2", "2026-09-09")], BASE)
            ),
        }
    )
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(backfill=True),
            clock=lambda: datetime(2026, 11, 7, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [item.title for item in result] == ["自编通知1", "自编通知2"]
    assert len(sites.requests) == 2


@pytest.mark.parametrize(
    "name",
    [
        "opaque-links",
        "month-day-year",
        "year-month-day",
        "table-rows",
        "date-in-link",
        "plain-span",
        "empty-link",
        "right-span",
    ],
)
def test_repeated_structure_finds_dates_without_url_or_class_templates(name: str) -> None:
    result = parse_listing((FIXTURES / f"{name}.html").read_bytes(), BASE)
    assert [(item.title, item.published_on, item.url) for item in result.items] == [
        ("自编招生通知1", date(2026, 9, 10), "https://example.edu.cn/article/101.htm"),
        ("自编招生通知2", date(2026, 9, 9), "https://example.edu.cn/article/102.htm"),
    ]


def test_empty_historical_page_finishes_backfill_without_discarding_items() -> None:
    sites = FakeSites(
        {
            BASE: httpx.Response(200, content=page([("1", "2026-09-10")], "p2")),
            "https://example.edu.cn/p2": httpx.Response(200, text="<ul></ul>"),
        }
    )
    result = sites.run(
        lambda f: list_items(
            PageSession(f, None),
            source(backfill=True),
            clock=lambda: datetime(2026, 11, 7, tzinfo=timezone(timedelta(hours=8))).timestamp(),
        )
    )
    assert [item.title for item in result] == ["自编通知1"]
    assert len(sites.requests) == 2


def test_configured_links_and_next_elements_use_href_instead_of_text() -> None:
    selectors = Selectors(
        items="//li", title=".//a", link=".//a", date=".//span", next="//a[@rel='next']"
    )
    result = parse_listing(page([("1", "2026-09-10")], "p2"), BASE, selectors)
    assert result.items[0].url == "https://example.edu.cn/info/1001/1.htm"
    assert result.next_url == "https://example.edu.cn/p2"


def test_html_comments_are_ignored_during_structure_detection() -> None:
    result = parse_listing(page([("1", "2026-09-10")]) + b"<!-- navigation -->", BASE)
    assert len(result.items) == 1


@pytest.mark.parametrize(
    ("row", "title"),
    [
        (
            '<a href="/1">【博士】自编招生通知\uff08第二批\uff09</a><span>2026-09-10</span>',
            "【博士】自编招生通知\uff08第二批\uff09",
        ),
        (
            '<a href="/1">关于2026年9月10日开展夏令营的通知</a><span>2026-09-09</span>',
            "关于2026年9月10日开展夏令营的通知",
        ),
        (
            '<a href="/1">关于<span>2026年9月10日</span>开展夏令营的通知</a>'
            "<span>2026-09-09</span>",
            "关于 2026年9月10日 开展夏令营的通知",
        ),
        (
            '<a href="/1" title="关于2026年9月10日开展夏令营的通知">通知</a>'
            "<span>2026-09-10</span>",
            "关于2026年9月10日开展夏令营的通知",
        ),
        (
            '<a href="/1"><span>09.10 2026</span>【博士】通知甲\uff08第二批\uff09</a>',
            "【博士】通知甲\uff08第二批\uff09",
        ),
        ('<a href="/1"><span>10</span><span>2026-09</span>通知甲</a>', "通知甲"),
        (
            '<a href="/1">[<span>2026-09-10</span>]【博士】通知甲\uff08第二批\uff09</a>',
            "【博士】通知甲\uff08第二批\uff09",
        ),
        (
            '<a href="/1">[2026-09-10]关于2026年9月11日开展夏令营的通知</a>',
            "关于2026年9月11日开展夏令营的通知",
        ),
        ('<a href="/1">【2026-09-10】通知甲\uff08第二批\uff09</a>', "通知甲\uff08第二批\uff09"),
    ],
)
def test_title_removes_only_the_publication_date_and_its_enclosing_brackets(
    row: str, title: str
) -> None:
    result = parse_listing(f'<meta charset="utf-8"><ul><li>{row}</li></ul>'.encode(), BASE)
    [item] = result.items
    assert item.title == title
    assert item.published_on == (date(2026, 9, 9) if "2026-09-09" in row else date(2026, 9, 10))


def test_page_parse_failure_is_not_reported_as_a_configuration_error() -> None:
    sites = FakeSites(
        {
            BASE: httpx.Response(
                200,
                content=page([("1", "2026-09-10")]),
                headers={"content-type": "text/html; charset=unknown-charset"},
            )
        }
    )
    with pytest.raises(StepError) as caught:
        sites.run(lambda f: list_items(PageSession(f, None), source()))
    assert caught.value.detail == "网页无法解析"


def test_repeated_links_can_be_the_list_rows() -> None:
    body = (
        '<meta charset="utf-8"><div>'
        '<a href="/1"><span>2026-09-10</span>通知甲</a>'
        '<a href="/2"><span>2026-09-09</span>通知乙</a></div>'
    )
    result = parse_listing(body.encode(), BASE)
    assert [(item.title, item.published_on) for item in result.items] == [
        ("通知甲", date(2026, 9, 10)),
        ("通知乙", date(2026, 9, 9)),
    ]
