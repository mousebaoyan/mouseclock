import asyncio
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

from pydantic import BaseModel

from crawler.crawl.fetch import Fetcher

CONTAINERS = {
    "gp-content",
    "abody",
    "v_news_content",
    "wp_articlecontent",
    "TRS_Editor",
    "TRS_UEDITOR",
    "vsb_content",
    "vsb_content_2",
    "Zoom",
    "zoom",
    "article-content",
    "item-page",
    "article_content",
}
BLOCKS = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "section"}
VOID = {"br", "img", "input", "hr", "meta", "link", "wbr", "source", "embed", "area"}


class Page(BaseModel):
    url: str
    final_url: str
    text: str
    fetched_at: datetime


class PageError(ValueError):
    pass


class ArticleParser(HTMLParser):
    def __init__(self, url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.url = url
        self.stack: list[tuple[str, bool]] = []
        self.active = 0
        self.parts: list[str] = []
        self.suppressed = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        names = set((values.get("class") or "").split()) | {values.get("id") or ""}
        begins = bool(names & CONTAINERS) and not self.active
        if tag in {"script", "style"}:
            self.suppressed += 1
        if tag not in VOID:
            self.stack.append((tag, begins))
        if begins:
            self.active += 1
        if self.active and not self.suppressed:
            if tag in BLOCKS:
                self.parts.append("\n")
            href = values.get("href")
            if tag == "a" and href and not href.startswith(("javascript:", "#")):
                self.parts.append(" " + urljoin(self.url, href) + " ")

    def handle_endtag(self, tag: str) -> None:
        if self.active and not self.suppressed and tag in BLOCKS:
            self.parts.append("\n")
        if tag in {"script", "style"} and self.suppressed:
            self.suppressed -= 1
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                self.active -= sum(begins for _, begins in self.stack[index:])
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if self.active and not self.suppressed:
            self.parts.append(data)


def article_text(html: str, url: str) -> str:
    parser = ArticleParser(url)
    parser.feed(html)
    text = "\n".join(line.strip() for line in "".join(parser.parts).splitlines() if line.strip())
    if not text:
        raise PageError("article_container_not_found")
    return text


def cached_page(url: str, path: Path) -> Page | None:
    if path.exists():
        page = Page.model_validate_json(path.read_bytes())
        if page.url != url:
            raise PageError("page_cache_url_mismatch")
        return page
    return None


def save_page(page: Page, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page.model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n")


async def read_page(url: str, path: Path, fetcher: Fetcher, *, reuse_only: bool) -> Page:
    cached = await asyncio.to_thread(cached_page, url, path)
    if cached is not None:
        return cached
    if reuse_only:
        raise PageError("page_cache_missing")
    response = await fetcher.get(url)
    if response.status != 200:
        raise PageError(f"http_{response.status}")
    # httpx's response decoder is not available on Fetcher's immutable response.
    html = response.body.decode("utf-8-sig")
    page = Page(
        url=url,
        final_url=response.url,
        text=article_text(html, response.url),
        fetched_at=datetime.now(UTC),
    )
    await asyncio.to_thread(save_page, page, path)
    return page
