import asyncio
import logging
import mimetypes
import re
from collections.abc import Awaitable, Callable

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import (
    AttachmentFailureKind,
    Failure,
    ReadAttachment,
    UnreadAttachment,
    Usage,
    WorkSource,
)
from crawler.crawl.fetch import FetchError
from crawler.crawl.readings import Readings
from crawler.crawl.rounds import Attachment, NoticePage, StepError
from crawler.parse import ParseError
from crawler.parse.files import file_parts
from crawler.parse.image import Picture
from crawler.parse.notice import AttachmentLink, parse_notice

# What the website keeps (docs/api.md §6): 50 attachments to a snapshot, 2 MiB of text to one,
# files up to 10 MiB.
MAX_ATTACHMENTS = 50
MAX_TEXT = 2 * 1024 * 1024
MAX_FILE = 10 * 1024 * 1024
# Only the types Python itself knows, so every machine names them alike.
_TYPES = mimetypes.MimeTypes()
# An empty answer, or a web page in place of the file: an error, or a captcha the crawler doesn't
# solve (design §7.2).
_NOT_A_FILE = re.compile(rb"\s*(?:<|\Z)")
# Why a download failed, as the dashboard and the review page show it.
_FETCH_FAILURES: dict[Failure, str] = {
    "timeout": "请求超时",
    "unreachable": "无法连接",
    "too_many_redirects": "重定向次数过多",
}
logger = logging.getLogger(__name__)


class ReadNotice:
    """A notice's page with its attachments downloaded and read. The LLM reads the pictures in
    them, and the same file at the same address keeps the words it read (design §7.4)."""

    def __init__(
        self, read_picture: Callable[[Picture, list[Usage]], Awaitable[str]], readings: Readings
    ) -> None:
        self.read_picture = read_picture
        self.readings = readings

    async def __call__(
        self, pages: PageSession, _source: WorkSource, url: str, usage: list[Usage]
    ) -> NoticePage | None:
        response = await pages.get(url)
        if response.status in {404, 410}:
            return None
        if not 200 <= response.status < 300:
            raise StepError("http_status", f"HTTP {response.status}")
        try:
            notice = parse_notice(response.body, response.url, response.content_type)
        except ParseError as error:
            raise StepError("error", str(error)) from error
        if len(notice.attachments) > MAX_ATTACHMENTS:
            logger.warning(
                "Keeping %d of %d attachments",
                MAX_ATTACHMENTS,
                len(notice.attachments),
                extra={"url": url},
            )
        attachments = [
            await self._attachment(pages, link, response.url, usage)
            for link in notice.attachments[:MAX_ATTACHMENTS]
        ]
        return NoticePage(notice.html, notice.text, notice.hyperlinks, attachments)

    # Listed whatever happens to the file, so the positions evidence refers to stay put; one not
    # read says why, and a broken file is kept all the same (design §7.4).
    async def _attachment(
        self, pages: PageSession, link: AttachmentLink, page_url: str, usage: list[Usage]
    ) -> Attachment:
        content_type = (
            _TYPES.guess_file_type(link.name)[0]
            or _TYPES.guess_type(link.url)[0]
            or "application/octet-stream"
        )
        data = None
        try:
            data = await _download(pages, link.url, page_url)
            text, pictures = await self._text(link.url, data, usage)
        except _DownloadError as error:
            failure, detail = error.failure, error.detail
        except ParseError as error:
            failure, detail = "unreadable", str(error)
        else:
            info = ReadAttachment(
                name=link.name,
                url=link.url,
                content_type=content_type,
                text=text[:MAX_TEXT],
                read_from_pictures=pictures,
            )
            return Attachment(info, data)
        unread = UnreadAttachment(
            name=link.name, url=link.url, content_type=content_type, failure=failure, detail=detail
        )
        return Attachment(unread, data)

    async def _text(self, url: str, data: bytes, usage: list[Usage]) -> tuple[str, bool]:
        """The file's words, and whether the LLM read any of them from pictures."""
        # Only words read from pictures are kept.
        if (kept := self.readings.text(url, data)) is not None:
            return kept, True
        parts = await asyncio.to_thread(file_parts, data)
        text = "\n".join(
            [
                part if isinstance(part, str) else await self.read_picture(part, usage)
                for part in parts
            ]
        )
        pictures = any(isinstance(part, Picture) for part in parts)
        if pictures:
            self.readings.keep(url, data, text)
        return text, pictures


class _DownloadError(Exception):
    def __init__(self, failure: AttachmentFailureKind, detail: str | None = None) -> None:
        super().__init__(failure)
        self.failure: AttachmentFailureKind = failure
        self.detail = detail


async def _download(pages: PageSession, url: str, page_url: str) -> bytes:
    try:
        response = await pages.download(url, page_url=page_url, max_size=MAX_FILE)
    except FetchError as error:
        raise _DownloadError("download_failed", _FETCH_FAILURES[error.failure]) from error
    if response.status != 200:
        raise _DownloadError("download_failed", f"HTTP {response.status}")
    if _NOT_A_FILE.match(response.body):
        raise _DownloadError("download_failed", "返回的是网页")
    if len(response.body) > MAX_FILE:
        raise _DownloadError("too_large")
    return response.body
