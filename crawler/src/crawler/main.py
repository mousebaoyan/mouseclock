"""The crawler process: asks the website for work every minute and crawls each source it hands out,
all at once; on SIGTERM it stops asking and exits once the rounds in progress are done."""

import asyncio
import logging
import os
import signal
import sys
from collections.abc import Mapping
from contextlib import suppress
from typing import Annotated

import httpx
from pydantic import BaseModel, ConfigDict, HttpUrl, StringConstraints, ValidationError

from crawler.crawl.browser import Browser
from crawler.crawl.contract import ExtractedProgram, ExtractionContext, Usage, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.listing import list_items
from crawler.crawl.notice import read_notice
from crawler.crawl.rounds import NoticePage, StepError, Steps, crawl_source
from crawler.crawl.website import Website
from crawler.log import JsonFormatter
from crawler.screening.screen import Screen
from crawler.screening.system_one import SystemOne

# Design §16: once a minute; the dashboard flags the crawler after ten minutes without asking.
POLL = 60.0
logger = logging.getLogger(__name__)

type Secret = Annotated[str, StringConstraints(min_length=1)]


class Config(BaseModel):
    model_config = ConfigDict(alias_generator=str.upper)

    mouseclock_url: HttpUrl
    mouseclock_token: Secret
    system_one_api_key: Secret


def load_config(environ: Mapping[str, str]) -> Config:
    try:
        return Config.model_validate(environ)
    except ValidationError as error:
        # Names and reasons only: the values may be secrets.
        problems = {str(e["loc"][0]): e["msg"] for e in error.errors(include_input=False)}
        logger.error("Configuration invalid", extra={"variables": problems})
        raise SystemExit(1) from None


async def serve(website: Website, browser: Browser, steps: Steps, stopping: asyncio.Event) -> None:
    # Leaving the group waits for the rounds still running.
    async with asyncio.TaskGroup() as rounds:
        while True:
            try:
                work = await website.work()
            except httpx.HTTPError as error:
                logger.warning("Asking for work failed: %s", error)
            else:
                for source in work.sources:
                    rounds.create_task(_crawl(source, browser, website, steps))
            with suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), POLL)
            if stopping.is_set():
                break


async def _crawl(source: WorkSource, browser: Browser, website: Website, steps: Steps) -> None:
    try:
        await crawl_source(source, browser, website, steps)
    except Exception:
        # A bug or an outage in this round; the others go on, and the lease hands it out again.
        logger.exception("Round failed")


async def _extract(
    _page: NoticePage, _context: ExtractionContext
) -> tuple[list[ExtractedProgram], list[Usage]]:
    raise StepError("error", "抽取还没接上")


async def _run(config: Config) -> None:
    stopping = asyncio.Event()

    def stop() -> None:
        logger.info("Stopping once the rounds in progress are done")
        stopping.set()

    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop)
    system_one = SystemOne(config.system_one_api_key)
    try:
        async with (
            Fetcher() as fetcher,
            Browser(fetcher) as browser,
            Website(str(config.mouseclock_url), config.mouseclock_token) as website,
        ):
            steps = Steps(
                list_items=list_items, screen=Screen(system_one), read=read_notice, extract=_extract
            )
            await serve(website, browser, steps, stopping)
    finally:
        await system_one.close()


def main() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    # Its line per request is noise next to the fetcher's own (development §4).
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(_run(load_config(os.environ)))
