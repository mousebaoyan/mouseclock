import asyncio
import logging
import mimetypes
import re
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import (
    AttachmentFailureKind,
    Failure,
    PendingNotice,
    ReadAttachment,
    UnreadAttachment,
    Usage,
    WorkSource,
)
from crawler.crawl.fetch import FetchError, Response
from crawler.crawl.readings import Readings
from crawler.crawl.rounds import Attachment, NoticePage, StepError
from crawler.parse import ParseError
from crawler.parse.files import file_parts
from crawler.parse.image import Picture
from crawler.parse.notice import FILE_NAME, AttachmentLink, file_name, parse_notice
from crawler.parse.refusal import refusal

# What the website keeps (docs/api.md §6): 50 attachments to a snapshot, 2 MiB of text to one,
# files up to 10 MiB.
MAX_ATTACHMENTS = 50
MAX_TEXT = 2 * 1024 * 1024
MAX_FILE = 10 * 1024 * 1024
# Only the types Python itself knows, so every machine names them alike.
_TYPES = mimetypes.MimeTypes()
# An empty answer, or a web page in place of the file: an error, or a captcha the crawler doesn't
# solve (design §7.2).
_NOT_A_FILE = re.compile(rb"(?:\xef\xbb\xbf)?\s*(?:<|\Z)")
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
        self, pages: PageSession, source: WorkSource, pending: PendingNotice, usage: list[Usage]
    ) -> NoticePage | None:
        url = pending.url
        # A notice that is a file and nothing more is fetched as attachments are, as a browser
        # would download it rather than open it.
        file = FILE_NAME.search(file_name(url)) is not None
        response = await (
            pages.download(url, page_url=source.url, max_size=MAX_FILE) if file else pages.get(url)
        )
        if _gone(response):
            return None
        if file and not _NOT_A_FILE.match(response.body):
            # The file is the notice's one attachment, named for the notice, as its own name is
            # often just a number; its type is the one where it ended up, if that says.
            names = [file_name(response.url), file_name(url)]
            suffix = next(PurePosixPath(n).suffix for n in names if FILE_NAME.search(n))
            link = AttachmentLink(pending.title[: 500 - len(suffix)] + suffix, url)
            return NoticePage("", "", (), [await self._read(link, response.body, usage)])
        if file:
            # Named like a file but a page, such as a viewer: opened as any other, which a source
            # needing a browser renders.
            response = await pages.get(url)
            if _gone(response):
                return None
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
        try:
            data = await _download(pages, link.url, page_url)
        except _DownloadError as error:
            return Attachment(_unread(link, error.failure, error.detail), None)
        return await self._read(link, data, usage)

    async def _read(self, link: AttachmentLink, data: bytes, usage: list[Usage]) -> Attachment:
        if len(data) > MAX_FILE:
            return Attachment(_unread(link, "too_large"), None)
        try:
            text, pictures = await self._text(link.url, data, usage)
        except ParseError as error:
            return Attachment(_unread(link, "unreadable", str(error)), data)
        info = ReadAttachment(
            name=link.name,
            url=link.url,
            content_type=_content_type(link),
            text=text[:MAX_TEXT],
            read_from_pictures=pictures,
        )
        return Attachment(info, data)

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


def _gone(response: Response) -> bool:
    """Whether the notice is gone; raises when the site keeps it back or answers with an error."""
    # Before the status: a login page can answer 401 or even 404 for a notice still there.
    if reason := refusal(response.body, response.url, response.content_type):
        raise StepError("restricted", reason)
    if response.status in {404, 410}:
        return True
    if not 200 <= response.status < 300:
        raise StepError("http_status", f"HTTP {response.status}")
    return False


def _content_type(link: AttachmentLink) -> str:
    return (
        _TYPES.guess_file_type(link.name)[0]
        or _TYPES.guess_type(link.url)[0]
        or "application/octet-stream"
    )


def _unread(
    link: AttachmentLink, failure: AttachmentFailureKind, detail: str | None = None
) -> UnreadAttachment:
    return UnreadAttachment(
        name=link.name,
        url=link.url,
        content_type=_content_type(link),
        failure=failure,
        detail=detail,
    )


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
    if response.status != 200 or _NOT_A_FILE.match(response.body):
        raise _DownloadError(
            "download_failed",
            refusal(response.body, response.url, response.content_type)
            or (f"HTTP {response.status}" if response.status != 200 else "返回的是网页"),
        )
    return response.body
