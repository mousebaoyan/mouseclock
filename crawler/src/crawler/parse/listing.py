import codecs
import re
from dataclasses import dataclass
from datetime import date
from urllib.parse import urldefrag, urljoin, urlsplit

from lxml import etree, html
from lxml.html import HtmlElement
from pydantic import BaseModel, ConfigDict, field_validator

from crawler.crawl.contract import ListedItem


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


_DATE = re.compile(r"(?<!\d)(\d{4})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})(?!\d)日?")
_YEAR_LAST_DATE = re.compile(r"(?<!\d)(\d{1,2})[-./](\d{1,2})\s+(\d{4})(?!\d)")
_YEAR_FIRST_DATE = re.compile(r"(?<!\d)(\d{4})\s+(\d{1,2})[-./](\d{1,2})(?!\d)")
_SPLIT_DATE = re.compile(r"(?<!\d)(\d{1,2})\s+(\d{4})[-./](\d{1,2})(?!\d)")


@dataclass(frozen=True)
class ListPage:
    items: list[ListedItem]
    next_url: str | None


def _elements(node: HtmlElement, expression: str) -> list[HtmlElement]:
    result: list[object] | str | float | bool = node.xpath(expression, smart_strings=False)
    if not isinstance(result, list):
        raise ValueError("items 必须选中条目元素")
    values: list[object] = result
    elements: list[HtmlElement] = []
    for value in values:
        if not isinstance(value, HtmlElement):
            raise ValueError("items 必须选中条目元素")
        elements.append(value)
    return elements


def _value(node: HtmlElement, expression: str | None, *, href: bool = False) -> str:
    if expression is None:
        return ""
    result: list[object] | str | float | bool = node.xpath(expression, smart_strings=False)
    if isinstance(result, list):
        values: list[object] = result
        if not all(isinstance(v, (HtmlElement, str)) for v in values):
            raise ValueError("字段 XPath 必须返回文字或元素")
        value = values[0] if values else ""
    else:
        value = result
    if isinstance(value, HtmlElement):
        text = value.get("href", "") if href else " ".join(value.itertext())
    elif isinstance(value, str):
        text = value
    else:
        raise ValueError("字段 XPath 必须返回文字或元素")
    return " ".join(text.split())


def _date(text: str) -> date | None:
    match = _SPLIT_DATE.search(text)
    if match:
        day, year, month = map(int, match.groups())
    elif match := _YEAR_LAST_DATE.search(text):
        month, day, year = map(int, match.groups())
    elif (match := _YEAR_FIRST_DATE.search(text)) or (match := _DATE.search(text)):
        year, month, day = map(int, match.groups())
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
            body, parser=html.HTMLParser(encoding=encoding, no_network=True, remove_comments=True)
        )
    except (LookupError, etree.ParserError) as error:
        raise ValueError("列表页无法解析") from error
    try:
        if selectors is not None:
            items: dict[str, ListedItem] = {}
            for row in _elements(root, selectors.items):
                title = _value(row, selectors.title)
                target = _url(url, _value(row, selectors.link, href=True))
                if title and target:
                    items.setdefault(
                        target,
                        ListedItem(
                            url=target, title=title, published_on=_date(_value(row, selectors.date))
                        ),
                    )
            return ListPage(
                list(items.values()), _url(url, _value(root, selectors.next, href=True))
            )
    except etree.XPathError as error:
        raise ValueError("XPath 无法计算") from error
    return ListPage(_generic_items(root, url), _next(root, url))


@dataclass(frozen=True)
class Publication:
    value: date | None
    start: int
    end: int
    node: HtmlElement | None = None


def _row_text(row: HtmlElement) -> tuple[str, dict[HtmlElement, tuple[int, int]]]:
    parts: list[str] = []
    ranges: dict[HtmlElement, tuple[int, int]] = {}
    length = 0

    def append(value: str | None) -> None:
        nonlocal length
        if value is not None:
            parts.append(value + " ")
            length += len(value) + 1

    def visit(node: HtmlElement) -> None:
        start = length
        append(node.text)
        for child in node:
            visit(child)
            append(child.tail)
        ranges[node] = (start, length)

    visit(row)
    return "".join(parts), ranges


def _row_date(
    row: HtmlElement, text: str, ranges: dict[HtmlElement, tuple[int, int]]
) -> Publication | None:
    patterns = (_SPLIT_DATE, _YEAR_LAST_DATE, _YEAR_FIRST_DATE, _DATE)
    nodes = sorted(
        row.iter(),
        key=lambda node: node.tag == "a" or next(node.iterancestors("a"), None) is not None,
    )
    for node in nodes:
        start, end = ranges[node]
        value = text[start:end]
        for pattern in patterns:
            if pattern.fullmatch(value.strip()) and (match := pattern.search(value)):
                return Publication(
                    _date(match[0]), start + match.start(), start + match.end(), node
                )
    for pattern in patterns:
        if match := pattern.search(text):
            return Publication(_date(match[0]), match.start(), match.end())
    for node in row.iter():
        value = node.get("datetime", "")
        if _DATE.search(value):
            return Publication(_date(value), 0, 0, node)
    return None


def _title(
    anchor: HtmlElement,
    row_text: str,
    ranges: dict[HtmlElement, tuple[int, int]],
    published: Publication | None,
) -> str:
    text = anchor.get("title", "").strip()
    if not text:
        title_node = anchor
        for expression in (
            ".//h1 | .//h2 | .//h3 | "
            ".//*[contains(concat(' ',normalize-space(@class),' '),' title ')]",
            ".//*[contains(concat(' ',normalize-space(@class),' '),' text ')]",
            "./p[1]",
        ):
            candidates = _elements(anchor, expression)
            if candidates:
                title_node = candidates[0]
                break
        start, end = ranges[title_node]
        text = row_text[start:end]
        if published and start <= published.start < published.end <= end:
            first, last = published.start - start, published.end - start
            left, right = text[:first].rstrip(), text[last:].lstrip()
            if (
                left
                and right
                and {"[": "]", "【": "】", "(": ")", "\uff08": "\uff09"}.get(left[-1]) == right[0]
            ):
                first, last = len(left) - 1, len(text) - len(right) + 1
            text = text[:first] + text[last:]
    return " ".join(text.split())


def _generic_items(root: HtmlElement, url: str) -> list[ListedItem]:
    best: list[ListedItem] = []
    best_score = (0, 0)
    for parent in root.iter():
        items: dict[str, ListedItem] = {}
        dated = 0
        separate_dates = 0
        for row in parent:
            text, ranges = _row_text(row)
            published = _row_date(row, text, ranges)
            links: dict[str, str] = {}
            for anchor in row.iter("a"):
                target = _url(url, anchor.get("href", ""))
                title = _title(anchor, text, ranges, published)
                if target and title:
                    links.setdefault(target, title)
            if len(links) != 1:
                continue
            target, title = next(iter(links.items()))
            dated += published is not None
            separate_dates += (
                published is not None
                and published.node is not None
                and published.node.tag != "a"
                and next(published.node.iterancestors("a"), None) is None
            )
            items.setdefault(
                target,
                ListedItem(
                    url=target, title=title, published_on=published.value if published else None
                ),
            )
        # A date outside the link identifies publication better than a date inside a title.
        score = (dated, separate_dates)
        if dated and score >= best_score:
            best_score, best = score, list(items.values())
    return best
