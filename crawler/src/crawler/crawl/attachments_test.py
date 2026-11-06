import asyncio

import httpx
import pytest

from crawler.crawl.attachments import download_attachment
from crawler.crawl.fetch import Fetcher

URL = "https://school.test/download.jsp?file=1"
PAGE_URL = "https://school.test/notice.htm"


@pytest.mark.parametrize(
    ("body", "content_type", "status", "error"),
    [
        (
            '<html><body><form>请输入验证码下载附件<input name="code"></form></body></html>',
            "text/html;charset=UTF-8",
            200,
            "下载附件需要验证码",
        ),
        ("<div>获取文件错误</div>", "text/html;charset=UTF-8", 200, "获取文件错误"),
        ("<p>附件已删除</p>", "text/html;charset=gb2312", 200, "附件已删除"),
        (
            '<meta charset="utf-8"><p>文件已删除</p>',
            "text/html;charset=gb2312",
            200,
            "文件已删除",
        ),
        (
            "<p>文件已删除</p>".encode("utf-8-sig"),
            "text/html;charset=gb2312",
            200,
            "文件已删除",
        ),
        (
            (
                '<html><head><meta charset="gb2312"></head><body>请输入验证码下载附件</body></html>'
            ).encode("gb2312"),
            "text/html",
            200,
            "下载附件需要验证码",
        ),
        (
            (
                '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'
                "<p>文件已删除</p>"
            ).encode("gb2312"),
            "text/html",
            200,
            "文件已删除",
        ),
        (
            "<p>请输入验证码下载附件</p>".encode("utf-16"),
            None,
            200,
            "下载附件需要验证码",
        ),
        (
            "<html><head><title>下载</title><body>请输入验证码下载附件</body></html>",
            "text/html;charset=UTF-8",
            200,
            "下载附件需要验证码",
        ),
        (
            "<html><head><title>下载</title><p>文件已删除</p></html>",
            "text/html;charset=UTF-8",
            200,
            "文件已删除",
        ),
        ("<p>文件不存在</p>", "text/html", 404, "HTTP 404: 文件不存在"),
        ("<script>location.href='/login';</script>", None, 200, "附件地址未返回文件"),
        (
            "<!DOCTYPE HTML><html><body>文件已删除</body></html>",
            "application/octet-stream",
            200,
            "文件已删除",
        ),
        ("\ufeff\n<div>获取文件错误</div>", None, 200, "获取文件错误"),
        ("", "application/pdf", 200, "附件内容为空"),
        ("denied", "text/plain", 403, "HTTP 403"),
    ],
)
def test_download_errors_keep_the_link_and_never_keep_an_error_page_as_a_file(
    body: str | bytes, content_type: str | None, status: int, error: str
) -> None:
    encoding = "gb2312" if content_type and "gb2312" in content_type else "utf-8"
    content = body.encode(encoding) if isinstance(body, str) else body
    headers = {"content-type": content_type} if content_type else {}

    async def main() -> None:
        transport = httpx.MockTransport(
            lambda _: httpx.Response(status, content=content, headers=headers)
        )
        async with Fetcher(transport) as fetcher, fetcher.session(False) as pages:
            attachment = await download_attachment(pages, URL, name="申请表.doc", page_url=PAGE_URL)
        assert attachment.info.url == URL
        assert attachment.info.name == "申请表.doc"
        assert attachment.info.text == ""
        assert attachment.info.error == error
        assert attachment.data is None

    asyncio.run(main())


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b"%PDF-1.7\n", "text/html"),
        (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "text/html"),
        (b"PK\x03\x04", "text/html"),
        (
            '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" '
            'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
            '<Worksheet ss:Name="申请表"><Table><Row><Cell>'
            '<Data ss:Type="String">申请表</Data>'
            "</Cell></Row></Table></Worksheet></Workbook>".encode(),
            "application/vnd.ms-excel",
        ),
        (
            '<html xmlns:x="urn:schemas-microsoft-com:office:excel">'
            "<head><title>申请表</title></head><body>"
            "<table><tr><td>申请表</td></tr></table></body></html>".encode(),
            "application/vnd.ms-excel",
        ),
    ],
)
def test_downloads_keep_binary_and_office_files_after_redirects(
    body: bytes, content_type: str
) -> None:
    async def main() -> None:
        def handle(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/download.jsp":
                return httpx.Response(302, headers={"location": "https://files.test/form"})
            return httpx.Response(200, content=body, headers={"content-type": content_type})

        async with Fetcher(httpx.MockTransport(handle)) as fetcher, fetcher.session(False) as pages:
            attachment = await download_attachment(pages, URL, name="申请表", page_url=PAGE_URL)
        assert attachment.info.url == URL
        assert attachment.info.error is None
        assert attachment.data == body

    asyncio.run(main())


def test_a_transport_failure_is_an_attachment_error() -> None:
    async def main() -> None:
        def handle(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out", request=request)

        async with Fetcher(httpx.MockTransport(handle)) as fetcher, fetcher.session(False) as pages:
            attachment = await download_attachment(pages, URL, name="申请表", page_url=PAGE_URL)
        assert attachment.info.url == URL
        assert attachment.info.error == "timeout"
        assert attachment.data is None

    asyncio.run(main())
