import asyncio
import logging
import mimetypes
import re
from collections.abc import Awaitable, Callable

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import AttachmentInfo, Usage, WorkSource
from crawler.crawl.fetch import FetchError
from crawler.crawl.readings import Readings
from crawler.crawl.rounds import Attachment, NoticePage, StepError
from crawler.parse.files import file_parts
from crawler.parse.image import Picture
from crawler.parse.notice import AttachmentLink, parse_notice

# What the website keeps (docs/api.md §6): 50 attachments to a snapshot, 2 MiB of text to one,
# files up to 50 MB.
MAX_ATTACHMENTS = 50
MAX_TEXT = 2 * 1024 * 1024
MAX_FILE = 50 * 1024 * 1024
# Only the types Python itself knows, so every machine names them alike.
_TYPES = mimetypes.MimeTypes()
# An empty answer, or a web page in place of the file: an error, or a captcha the crawler doesn't
# solve (design §7.2).
_NOT_A_FILE = re.compile(rb"\s*(?:<|\Z)")
logger = logging.getLogger(__name__)


class ReadNotice:
    """A notice's page with its attachments downloaded and read. The LLM reads the pictures in
    them, and the same file at the same address keeps the words it read (design §7.4)."""

    def __init__(
        self, read_picture: Callable[[Picture], Awaitable[tuple[str, Usage]]], readings: Readings
    ) -> None:
        self.read_picture = read_picture
        self.readings = readings

    async def __call__(
        self, pages: PageSession, _source: WorkSource, url: str
    ) -> NoticePage | None:
        response = await pages.get(url)
        if response.status in {404, 410}:
            return None
        if not 200 <= response.status < 300:
            raise StepError("http_status", f"HTTP {response.status}")
        try:
            notice = parse_notice(response.body, response.url, response.content_type)
        except ValueError as error:
            raise StepError("error", str(error)) from error
        if len(notice.attachments) > MAX_ATTACHMENTS:
            logger.warning(
                "Keeping %d of %d attachments",
                MAX_ATTACHMENTS,
                len(notice.attachments),
                extra={"url": url},
            )
        attachments = [
            await self._attachment(pages, link, response.url)
            for link in notice.attachments[:MAX_ATTACHMENTS]
        ]
        return NoticePage(notice.html, notice.text, notice.hyperlinks, attachments)

    # Listed whatever happens to the file, so the positions evidence refers to stay put.
    async def _attachment(
        self, pages: PageSession, link: AttachmentLink, page_url: str
    ) -> Attachment:
        content_type = (
            _TYPES.guess_file_type(link.name)[0]
            or _TYPES.guess_type(link.url)[0]
            or "application/octet-stream"
        )
        data = await _download(pages, link.url, page_url)
        text = ""
        usage: list[Usage] = []
        if data is not None:
            try:
                text, usage = await self._text(link.url, data)
            except ValueError as error:
                logger.warning("Attachment unreadable: %s", error, extra={"url": link.url})
        info = AttachmentInfo(
            name=link.name, url=link.url, content_type=content_type, text=text[:MAX_TEXT]
        )
        return Attachment(info, data, usage)

    async def _text(self, url: str, data: bytes) -> tuple[str, list[Usage]]:
        if (kept := self.readings.text(url, data)) is not None:
            return kept, []
        texts: list[str] = []
        usage: list[Usage] = []
        for part in await asyncio.to_thread(file_parts, data):
            if isinstance(part, str):
                texts.append(part)
                continue
            text, used = await self.read_picture(part)
            texts.append(text)
            usage.append(used)
        text = "\n".join(texts)
        if usage:
            self.readings.keep(url, data, text)
        return text, usage


async def _download(pages: PageSession, url: str, page_url: str) -> bytes | None:
    try:
        response = await pages.download(url, page_url=page_url)
    except FetchError as error:
        logger.warning("Attachment not downloaded: %s", error.failure, extra={"url": url})
        return None
    if response.status != 200 or _NOT_A_FILE.match(response.body) or len(response.body) > MAX_FILE:
        logger.warning(
            "Attachment not downloaded: HTTP %s, %s, %d bytes",
            response.status,
            response.content_type,
            len(response.body),
            extra={"url": url},
        )
        return None
    return response.body
