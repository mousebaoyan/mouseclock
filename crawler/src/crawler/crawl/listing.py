import time
from calendar import monthrange
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, urlunsplit

from pydantic import ValidationError

from crawler.crawl.contract import ListedItem, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.rounds import StepError
from crawler.parse.listing import ListConfig, parse_listing


async def list_items(
    fetcher: Fetcher, source: WorkSource, clock: Callable[[], float] = time.time
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

    now = datetime.fromtimestamp(clock(), timezone(timedelta(hours=8))).date()
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
        try:
            page = parse_listing(
                response.body, response.url, config.selectors, response.content_type
            )
        except ValueError as error:
            raise StepError("error", f"配置不对: {error}") from error
        if not page.items:
            break
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
