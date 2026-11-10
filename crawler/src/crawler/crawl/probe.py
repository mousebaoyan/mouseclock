import logging
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit, urlunsplit

from pydantic import ValidationError

from crawler.crawl.browser import Browser
from crawler.crawl.contract import ProbeReport, Usage, WorkProbe
from crawler.crawl.fetch import FetchError
from crawler.crawl.rounds import StepError
from crawler.crawl.website import Website
from crawler.parse.listing import ListConfig, parse_listing

type GenerateConfig = Callable[[bytes, str, str | None, list[Usage]], Awaitable[ListConfig]]

logger = logging.getLogger(__name__)


async def probe_source(
    probe: WorkProbe, browser: Browser, website: Website, generate: GenerateConfig
) -> None:
    usage: list[Usage] = []
    try:
        try:
            config = ListConfig.model_validate(probe.config if probe.config is not None else {})
        except ValidationError as error:
            raise StepError("error", "试抓配置不合法") from error
        url = probe.url
        if config.force_http:
            url = urlunsplit(urlsplit(url)._replace(scheme="http"))
        async with browser.session(probe) as pages:
            response = await pages.get(url)
        if not 200 <= response.status < 300:
            raise StepError("http_status", f"HTTP {response.status}")
        try:
            page = parse_listing(
                response.body, response.url, config.selectors, response.content_type
            )
            suggested = config if probe.config is not None else None
            if not page.items and probe.config is None:
                suggested = await generate(
                    response.body, response.url, response.content_type, usage
                )
                page = parse_listing(
                    response.body, response.url, suggested.selectors, response.content_type
                )
        except ValidationError as error:
            raise StepError("error", "列表条目不符合接口要求") from error
        except ValueError as error:
            raise StepError("error", "列表解析失败") from error
        if not page.items:
            raise StepError("no_items", "未读到列表条目")
        try:
            report = ProbeReport(
                items=page.items,
                suggested_config=suggested.model_dump(mode="json", exclude_none=True)
                if suggested is not None
                else None,
                usage=usage,
            )
        except ValidationError as error:
            raise StepError("error", "试抓结果不符合接口要求") from error
    except (FetchError, StepError) as error:
        detail = error.url if isinstance(error, FetchError) else error.detail
        report = ProbeReport(
            items=[],
            failure=error.failure,
            detail=detail[:1000] if detail is not None else None,
            usage=usage,
        )
    # Submission failures belong to the entry point; a failed submission is not a failed parse.
    await website.probe(probe.id, report)
    logger.info(
        "Probe finished",
        extra={"probe_id": probe.id, "listed": len(report.items), "failure": report.failure},
    )
