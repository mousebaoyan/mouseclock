import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser

from crawler.crawl.contract import AttachmentInfo
from crawler.crawl.fetch import FetchError, PageSession, Response

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Attachment:
    info: AttachmentInfo
    data: bytes | None


class _DownloadPage(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.hidden = 0
        self.office = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "html":
            self.office = any(
                (name == "xmlns" or name.startswith("xmlns:"))
                and value is not None
                and value.startswith("urn:schemas-microsoft-com:office:")
                for name, value in attrs
            )
        if tag in {"title", "script", "style"}:
            self.hidden += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"title", "script", "style"}:
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def _download_error(response: Response) -> str | None:
    status = f"HTTP {response.status}" if not 200 <= response.status < 300 else None
    # Some download endpoints label Office and PDF files as HTML.
    if status is None and response.body.startswith((b"%PDF-", b"\xd0\xcf\x11\xe0", b"PK\x03\x04")):
        return None
    content_type = response.content_type or ""
    charset = re.search(r"charset\s*=\s*['\"]?([\w.-]+)", content_type, re.IGNORECASE)
    meta = re.search(
        rb"<meta\b[^>]*\bcharset\s*=\s*['\"]?([\w.-]+)", response.body[:1024], re.IGNORECASE
    )
    if response.body.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"
    elif response.body.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    elif charset:
        encoding = charset[1]
    elif meta:
        encoding = meta[1].decode("ascii")
    else:
        encoding = "utf-8-sig"
    try:
        prefix = response.body[:1024].decode(encoding, errors="replace")
    except LookupError:
        encoding = "utf-8-sig"
        prefix = response.body[:1024].decode(encoding, errors="replace")
    html = content_type.split(";")[0].strip().lower() in {"text/html", "application/xhtml+xml"}
    html = (
        html
        or re.match(
            r"<(?:!doctype\s+html|html|head|body|title|meta|script|style|form|div|p|span|pre|table|h[1-6])"
            r"(?:\s|/?>)",
            prefix.lstrip(),
            re.IGNORECASE,
        )
        is not None
    )
    if not html:
        return status or ("附件内容为空" if not response.body else None)

    page = _DownloadPage()
    page.feed(response.body.decode(encoding, errors="replace"))
    if status is None and page.office:
        return None
    text = " ".join(" ".join(page.parts).split())
    if "验证码" in text or "captcha" in text.lower():
        return "下载附件需要验证码"
    # A whole notice or login page is not a useful attachment failure message.
    detail = text if 0 < len(text) <= 1000 else "附件地址未返回文件"
    return detail if status is None else f"{status}: {detail}"


async def download_attachment(
    pages: PageSession, url: str, *, name: str, page_url: str
) -> Attachment:
    content_type = "application/octet-stream"
    data: bytes | None = None
    try:
        response = await pages.download(url, page_url=page_url)
    except FetchError as failure:
        error = failure.failure
    else:
        content_type = response.content_type or content_type
        error = _download_error(response)
        if error is None:
            data = response.body
    if error is not None:
        logger.warning("Attachment download failed", extra={"url": url})
    return Attachment(
        AttachmentInfo(name=name, url=url, content_type=content_type, text="", error=error),
        data,
    )
