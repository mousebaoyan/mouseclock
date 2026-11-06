import codecs
import re
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit

from lxml import etree, html
from lxml.html import HtmlElement
from pydantic import (
    BaseModel,
    ConfigDict,
    InstanceOf,
    TypeAdapter,
    ValidationError,
    field_validator,
)

from crawler.crawl.contract import ListedItem, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.rounds import StepError


class Selectors(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    items: str
    title: str
    link: str
    date: str | None = None
    next: str | None = None

    @field_validator("items", "title", "link", "date", "next")
    @classmethod
    def valid_xpath(cls, value: str | None) -> str | None:
        if value is not None:
            if not value.strip():
                raise ValueError("XPath cannot be empty")
            try:
                etree.XPath(value, regexp=False)
            except etree.XPathError as error:
                raise ValueError("invalid XPath") from error
        return value


class ListConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selectors: Selectors | None = None
    force_http: bool = False


_ELEMENTS = TypeAdapter(list[InstanceOf[HtmlElement]])
_DATE = re.compile(r"(?<!\d)(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})(?!\d)")
_SPLIT_DATE = re.compile(r"(\d{1,2})\s+(\d{4})[-./](\d{1,2})")
_DATE_NODES = (
    ".//time/@datetime | .//*[contains(@class,'date') or contains(@class,'time') "
    "or contains(@class,'news_meta') or contains(@class,'pull-right')]"
)
_LINK = ".//a[@href][1]/@href"
_TEMPLATES = (
    # The whole list includes pinned links to another site's admission system.
    Selectors(
        items="//ul[li/a[contains(@href,'info/') and contains(@href,'.htm')]]/li",
        title=(
            ".//a[1]/@title[normalize-space()] | .//h3[1] | .//a[1]/p[1] | "
            ".//a[1][not(normalize-space(@title)) and not(.//h3) and not(p)]"
        ),
        link=_LINK,
        date=_DATE_NODES,
    ),
    Selectors(
        # WebPlus also uses news_list for footer links, without date markup.
        items=(
            "//ul[(contains(@class,'news_list') or contains(@class,'wp_article_list')) "
            "and li[.//time or .//*[contains(@class,'news_meta') "
            "or contains(@class,'date') or contains(@class,'time')]]]/li"
        ),
        title=".//a[1]/@title[normalize-space()] | .//a[1][not(normalize-space(@title))]",
        link=_LINK,
        date=_DATE_NODES,
    ),
    Selectors(
        items="//ul[li/a[contains(@href,'/t20')]]/li",
        title=".//a[1]",
        link=_LINK,
        date=_DATE_NODES,
    ),
    Selectors(
        items="//ul[li/a/div[contains(@class,'infoBox')]]/li",
        title=".//*[contains(concat(' ',normalize-space(@class),' '),' title ')]",
        link=_LINK,
        date=_DATE_NODES,
    ),
    Selectors(
        items="//div[contains(@class,'views-element-container')]//li[contains(@class,'list-page')]",
        title=(
            ".//div[@class='title']/a/span[@class='text'] | "
            ".//div[@class='title']/a[not(span[@class='text'])]"
        ),
        link=_LINK,
        date=_DATE_NODES,
    ),
)


@dataclass(frozen=True)
class ListPage:
    items: list[ListedItem]
    next_url: str | None


def _elements(node: HtmlElement, expression: str) -> list[HtmlElement]:
    result: object = node.xpath(expression, smart_strings=False)
    try:
        return _ELEMENTS.validate_python(result)
    except ValidationError as error:
        raise StepError("error", "配置不对: items 必须选中条目元素") from error


def _value(node: HtmlElement, expression: str | None, separator: str = "") -> str:
    if expression is None:
        return ""
    result: object = node.xpath(expression, smart_strings=False)
    if isinstance(result, list):
        try:
            values = TypeAdapter(list[InstanceOf[HtmlElement] | str]).validate_python(result)
        except ValidationError as error:
            raise StepError("error", "配置不对: 字段 XPath 必须返回文字或元素") from error
        if not values:
            return ""
        value = values[0]
    elif isinstance(result, str):
        value = result
    else:
        raise StepError("error", "配置不对: 字段 XPath 必须返回文字或元素")
    text = separator.join(value.itertext()) if isinstance(value, HtmlElement) else value
    return " ".join(text.split())


def _date(text: str) -> date | None:
    match = _DATE.search(text)
    if match:
        year, month, day = map(int, match.groups())
    elif match := _SPLIT_DATE.fullmatch(text):
        day, year, month = map(int, match.groups())
    else:
        return None
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _url(base: str, href: str) -> str | None:
    if not href or href.startswith("#"):
        return None
    absolute, _ = urldefrag(urljoin(base, href))
    parts = urlsplit(absolute)
    return absolute if parts.scheme in {"http", "https"} and parts.netloc else None


def _next(root: HtmlElement, url: str) -> str | None:
    for anchor in root.iter("a"):
        if anchor.get("aria-disabled") == "true" or "disabled" in anchor.get("class", ""):
            continue
        label = "".join("".join(anchor.itertext()).split())
        title = "".join(anchor.get("title", "").split())
        is_next = "next" in anchor.get("rel", "").split() or any(
            re.fullmatch(r"(?:下一?页|Next)[>\u00bb\u203a]*", value, re.IGNORECASE)
            for value in (label, title)
        )
        if is_next and (target := _url(url, anchor.get("href", ""))):
            return target
    # Some Drupal pagers show only numbered pages, with no separate Next link.
    for anchor in root.iter("a"):
        if anchor.get("aria-current") != "page":
            continue
        row = anchor.getparent()
        current = re.search(r"(\d+)\s*$", "".join(anchor.itertext()))
        if row is None or "pager" not in row.get("class", "") or current is None:
            continue
        following = row.getnext()
        if following is None:
            continue
        link = next(following.iter("a"), None)
        if link is None:
            continue
        number = re.search(r"(\d+)\s*$", "".join(link.itertext()))
        if number is not None and int(number[1]) == int(current[1]) + 1:
            return _url(url, link.get("href", ""))
    return None


def parse_listing(
    body: bytes,
    url: str,
    selectors: Selectors | None = None,
    content_type: str | None = None,
) -> ListPage:
    if not body.strip():
        return ListPage([], None)
    declaration = (content_type or "") + " " + body[:4096].decode("ascii", errors="ignore")
    match = re.search(r"charset\s*=\s*['\"]?([\w.-]+)", declaration, re.IGNORECASE)
    try:
        encoding = codecs.lookup(match[1] if match else "utf-8").name
        root = html.document_fromstring(
            body, parser=html.HTMLParser(encoding=encoding, no_network=True)
        )
    except (LookupError, etree.ParserError) as error:
        raise StepError("error", "列表页无法解析") from error
    try:
        configured = selectors is not None
        candidates = (selectors,) if selectors is not None else _TEMPLATES
        rows: list[HtmlElement] = []
        for candidate in candidates:
            rows = _elements(root, candidate.items)
            if rows:
                selectors = candidate
                break
        if selectors is None or not rows:
            return ListPage([], None)
        items: dict[str, ListedItem] = {}
        for row in rows:
            title = _value(row, selectors.title)
            target = _url(url, _value(row, selectors.link))
            if title and target:
                item = ListedItem(
                    url=target,
                    title=title,
                    published_on=_date(_value(row, selectors.date, " ")),
                )
                items.setdefault(target, item)
        following = _url(url, _value(root, selectors.next)) if configured else _next(root, url)
        return ListPage(list(items.values()), following)
    except etree.XPathError as error:
        raise StepError("error", "配置不对: XPath 无法计算") from error
    except ValidationError as error:
        raise StepError("error", "列表条目或配置字段不符合结构") from error


async def list_items(
    fetcher: Fetcher, source: WorkSource, *, today: date | None = None
) -> list[ListedItem]:
    try:
        config = ListConfig.model_validate(source.config or {})
    except ValidationError as error:
        location = ".".join(str(value) for value in error.errors(include_input=False)[0]["loc"])
        raise StepError("error", f"配置不对: {location}") from error

    def request_url(url: str) -> str:
        parts = urlsplit(url)
        if config.force_http and parts.netloc == urlsplit(source.url).netloc:
            return urlunsplit(parts._replace(scheme="http"))
        return url

    now = today or datetime.now(timezone(timedelta(hours=8))).date()
    year = now.year - 2
    cutoff = now.replace(year=year, day=min(now.day, monthrange(year, now.month)[1]))
    current = request_url(source.url)
    visited: set[str] = set()
    items: dict[str, ListedItem] = {}
    while True:
        if current in visited:
            raise StepError("error", "分页链接循环")
        visited.add(current)
        response = await fetcher.get(current)
        visited.add(response.url)
        if not 200 <= response.status < 300:
            raise StepError("http_status", f"HTTP {response.status}")
        page = parse_listing(response.body, response.url, config.selectors, response.content_type)
        if not page.items:
            return []
        fresh = [item for item in page.items if item.url not in items]
        if (
            source.backfill
            and fresh
            and all(item.published_on is not None and item.published_on < cutoff for item in fresh)
        ):
            break
        for item in page.items:
            if not source.backfill or item.published_on is None or item.published_on >= cutoff:
                items.setdefault(item.url, item)
        if not source.backfill or page.next_url is None:
            break
        current = request_url(page.next_url)
    return list(items.values())
