import asyncio
import logging
import mimetypes
import re

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import AttachmentInfo, WorkSource
from crawler.crawl.fetch import FetchError
from crawler.crawl.rounds import Attachment, NoticePage, StepError
from crawler.parse.files import file_text
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


async def read_notice(pages: PageSession, _source: WorkSource, url: str) -> NoticePage | None:
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
        await _attachment(pages, link, response.url)
        for link in notice.attachments[:MAX_ATTACHMENTS]
    ]
    return NoticePage(notice.html, notice.text, notice.hyperlinks, attachments)


# Listed whatever happens to the file, so the positions evidence refers to stay put.
async def _attachment(pages: PageSession, link: AttachmentLink, page_url: str) -> Attachment:
    content_type = (
        _TYPES.guess_file_type(link.name)[0]
        or _TYPES.guess_type(link.url)[0]
        or "application/octet-stream"
    )
    data = await _download(pages, link.url, page_url)
    text = ""
    if data is not None:
        try:
            text = await asyncio.to_thread(file_text, data)
        except ValueError as error:
            logger.warning("Attachment unreadable: %s", error, extra={"url": link.url})
    info = AttachmentInfo(
        name=link.name, url=link.url, content_type=content_type, text=text[:MAX_TEXT]
    )
    return Attachment(info, data)


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
