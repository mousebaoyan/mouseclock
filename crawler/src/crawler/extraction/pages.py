import asyncio
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, TypeAdapter

from crawler.crawl.fetch import Fetcher
from crawler.parse.indexing import Hyperlink
from crawler.parse.notice import parse_notice


class Page(BaseModel):
    url: str
    final_url: str
    text: str
    fetched_at: datetime
    hyperlinks: tuple[Hyperlink, ...] = ()


class PageError(ValueError):
    pass


def cached_page(url: str, path: Path) -> Page | None:
    if not path.exists():
        return None
    return TypeAdapter(dict[str, Page]).validate_json(path.read_bytes()).get(url)


def save_page(page: Page, path: Path) -> None:
    pages = TypeAdapter(dict[str, Page]).validate_json(path.read_bytes()) if path.exists() else {}
    pages[page.url] = page
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(TypeAdapter(dict[str, Page]).dump_json(pages, indent=2) + b"\n")


async def read_page(url: str, path: Path, fetcher: Fetcher, *, reuse_only: bool) -> Page:
    cached = await asyncio.to_thread(cached_page, url, path)
    if cached is not None:
        return cached
    if reuse_only:
        raise PageError("page_cache_missing")
    response = await fetcher.get(url)
    if response.status != 200:
        raise PageError(f"http_{response.status}")
    try:
        notice = parse_notice(response.body, response.url, response.content_type)
    except ValueError as error:
        raise PageError(str(error)) from error
    page = Page(
        url=url,
        final_url=response.url,
        text=notice.text,
        hyperlinks=notice.hyperlinks,
        fetched_at=datetime.now(UTC),
    )
    await asyncio.to_thread(save_page, page, path)
    return page
