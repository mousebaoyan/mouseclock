import io
import json
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path

import docx
import httpx
import pytest
from PIL import Image

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import Usage, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.fetch_test import FakeSites
from crawler.crawl.notice import ReadNotice
from crawler.crawl.readings import Readings
from crawler.crawl.rounds import NoticePage, StepError
from crawler.extraction.pictures import ReadPicture
from crawler.extraction.responses import Responses

SOURCE = WorkSource(
    id=7,
    url="https://example.edu.cn/tzgg.htm",
    browser=False,
    config=None,
    backfill=False,
)
PAGE = "https://example.edu.cn/info/1001/101.htm"


def docx_file(*paragraphs: str) -> bytes:
    document = docx.Document()
    for paragraph in paragraphs:
        document.add_paragraph(paragraph)
    stream = io.BytesIO()
    document.save(stream)
    return stream.getvalue()


def png_file(color: str) -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (600, 300), color).save(stream, "PNG")
    return stream.getvalue()


class FakeModel:
    """Reads each picture as which call it was, and records the images each call had."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        content = json.loads(request.content)["input"][0]["content"]
        self.calls.append([part["image_url"] for part in content])
        message = {"type": "output_text", "text": f"第{len(self.calls)}次读的文字"}
        return httpx.Response(
            200,
            json={
                "model": "deepseek-flash",
                "status": "completed",
                "output": [{"type": "message", "content": [message]}],
                "usage": {"input_tokens": 1000, "output_tokens": 100},
            },
        )


@pytest.fixture
def readings(tmp_path: Path) -> Iterator[Readings]:
    with closing(Readings(tmp_path / "readings.sqlite3")) as kept:
        yield kept


def read(
    pages: dict[str, httpx.Response],
    readings: Readings,
    url: str = PAGE,
    model: FakeModel | None = None,
) -> NoticePage | None:
    transport = httpx.MockTransport((model or FakeModel()).handle)

    async def use(fetcher: Fetcher) -> NoticePage | None:
        async with Responses("local-test", transport) as llm:
            read_notice = ReadNotice(ReadPicture(llm), readings)
            return await read_notice(PageSession(fetcher, None), SOURCE, url)

    return FakeSites(pages).run(use)


@pytest.mark.parametrize("status", [404, 410])
def test_a_page_that_is_gone_reads_as_none(status: int, readings: Readings) -> None:
    assert read({PAGE: httpx.Response(status)}, readings) is None


@pytest.mark.parametrize(
    ("response", "failure", "detail"),
    [
        (httpx.Response(403), "http_status", "HTTP 403"),
        (httpx.Response(200, html="<div>自编的正文</div>"), "error", "认不出正文"),
    ],
)
def test_a_page_that_cant_be_read_fails_the_notice(
    response: httpx.Response, failure: str, detail: str, readings: Readings
) -> None:
    with pytest.raises(StepError) as caught:
        read({PAGE: response}, readings)
    assert (caught.value.failure, caught.value.detail) == (failure, detail)


def test_attachments_keep_their_order_and_the_ones_not_downloaded_stay_listed(
    readings: Readings,
) -> None:
    body = (
        '<div class="v_news_content"><p>自编的通知正文。</p>'
        '<p><a href="files/form.docx">申请表.docx</a></p>'
        '<p><a href="files/letter.doc">推荐信.doc</a></p>'
        '<p><a href="files/list.pdf">名单.pdf</a></p></div>'
    )
    pages = {
        # The notice moved; its links are relative to where it is now.
        "https://example.edu.cn/old/101.htm": httpx.Response(301, headers={"location": PAGE}),
        PAGE: httpx.Response(200, html=body),
        "https://example.edu.cn/info/1001/files/form.docx": httpx.Response(
            200, content=docx_file("请于9月20日前提交。")
        ),
        # Some sites answer with a captcha page in place of the file.
        "https://example.edu.cn/info/1001/files/letter.doc": httpx.Response(
            200, html="<p>请输入验证码下载附件</p>"
        ),
    }
    page = read(pages, readings, "https://example.edu.cn/old/101.htm")
    assert page is not None
    assert page.text == "自编的通知正文。\n申请表.docx\n推荐信.doc\n名单.pdf"
    assert [(a.info.name, a.info.content_type, a.info.text) for a in page.attachments] == [
        (
            "申请表.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "请于9月20日前提交。",
        ),
        ("推荐信.doc", "application/msword", ""),
        ("名单.pdf", "application/pdf", ""),
    ]
    assert [a.data is not None for a in page.attachments] == [True, False, False]


def test_the_llm_reads_a_picture_once_while_the_file_stays_the_same(readings: Readings) -> None:
    body = '<div class="v_news_content"><p>自编的通知正文。</p><p><img src="poster.png"></p></div>'
    poster = "https://example.edu.cn/info/1001/poster.png"
    model = FakeModel()

    def read_with(image: bytes) -> NoticePage:
        pages = {PAGE: httpx.Response(200, html=body), poster: httpx.Response(200, content=image)}
        page = read(pages, readings, model=model)
        assert page is not None
        return page

    first = read_with(png_file("white"))
    again = read_with(png_file("white"))
    changed = read_with(png_file("gray"))

    assert [page.attachments[0].info.text for page in (first, again, changed)] == [
        "第1次读的文字",
        "第1次读的文字",
        "第2次读的文字",
    ]
    assert first.attachments[0].usage == [
        Usage(model="deepseek-flash", input_tokens=1000, output_tokens=100)
    ]
    assert again.attachments[0].usage == []
    assert [len(images) for images in model.calls] == [1, 1]
    assert model.calls[0][0].startswith("data:image/png;base64,")


def test_a_picture_the_llm_cant_read_fails_the_notice(readings: Readings) -> None:
    body = '<div class="v_news_content"><p>自编的通知正文。</p><p><img src="poster.png"></p></div>'
    pages = {
        PAGE: httpx.Response(200, html=body),
        "https://example.edu.cn/info/1001/poster.png": httpx.Response(
            200, content=png_file("white")
        ),
    }

    async def use(fetcher: Fetcher) -> NoticePage | None:
        transport = httpx.MockTransport(lambda _: httpx.Response(503))
        async with Responses("local-test", transport) as llm:
            read_notice = ReadNotice(ReadPicture(llm), readings)
            return await read_notice(PageSession(fetcher, None), SOURCE, PAGE)

    with pytest.raises(StepError, match="http_503"):
        FakeSites(pages).run(use)
