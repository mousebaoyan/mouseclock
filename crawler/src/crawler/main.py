"""Ask the website for work every minute and run sources and probes concurrently; on SIGTERM,
stop asking and exit once the tasks in progress are done."""

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
from crawler.crawl.contract import WorkProbe, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.listing import list_items
from crawler.crawl.notice import read_notice
from crawler.crawl.probe import GenerateConfig, probe_source
from crawler.crawl.rounds import Steps, crawl_source
from crawler.crawl.website import Website
from crawler.extraction.extract import Extract
from crawler.extraction.probe import ProbeConfig
from crawler.extraction.responses import Responses
from crawler.log import JsonFormatter, current_probe
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
    llm_api_key: Secret


def load_config(environ: Mapping[str, str]) -> Config:
    try:
        return Config.model_validate(environ)
    except ValidationError as error:
        # Names and reasons only: the values may be secrets.
        problems = {str(e["loc"][0]): e["msg"] for e in error.errors(include_input=False)}
        logger.error("Configuration invalid", extra={"variables": problems})
        raise SystemExit(1) from None


async def serve(
    website: Website,
    browser: Browser,
    steps: Steps,
    stopping: asyncio.Event,
    generate: GenerateConfig,
) -> None:
    # Leaving the group waits for the rounds still running.
    async with asyncio.TaskGroup() as rounds:
        while True:
            try:
                work = await website.work()
            except (httpx.HTTPError, ValidationError) as error:
                # By kind only: the text may carry the token (development §4). A website that no
                # longer matches this crawler is asked again next minute, like one that's down.
                status = (
                    error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
                )
                logger.warning(
                    "Asking for work failed",
                    extra={"error": type(error).__name__, "status": status},
                )
            else:
                for source in work.sources:
                    rounds.create_task(_crawl(source, browser, website, steps))
                for probe in work.probes:
                    rounds.create_task(_probe(probe, browser, website, generate))
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


async def _probe(
    probe: WorkProbe, browser: Browser, website: Website, generate: GenerateConfig
) -> None:
    token = current_probe.set(probe.id)
    try:
        await probe_source(probe, browser, website, generate)
    except Exception as error:
        # An upstream exception may contain model output or credentials; log only its kind.
        logger.exception("Probe failed", exc_info=False, extra={"error": type(error).__name__})
    finally:
        current_probe.reset(token)


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
            Responses(config.llm_api_key) as llm,
        ):
            steps = Steps(
                list_items=list_items,
                screen=Screen(system_one),
                read=read_notice,
                extract=Extract(llm),
            )
            await serve(website, browser, steps, stopping, ProbeConfig(llm).generate)
    finally:
        await system_one.close()


def main() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    # Its line per request is noise next to the fetcher's own (development §4).
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(_run(load_config(os.environ)))
