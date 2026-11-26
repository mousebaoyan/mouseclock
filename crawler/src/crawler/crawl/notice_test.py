import asyncio
import io
import json
from collections.abc import Iterator
from contextlib import closing
from itertools import batched
from pathlib import Path
from urllib.parse import urljoin

import docx
import httpx
import pytest
from PIL import Image

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import ReadAttachment, UnreadAttachment, Usage, WorkSource
from crawler.crawl.fetch import Fetcher
from crawler.crawl.fetch_test import FakeSites
from crawler.crawl.notice import MAX_FILE, ReadNotice
from crawler.crawl.readings import Readings
from crawler.crawl.rounds import NoticePage, StepError
from crawler.extraction.chat import Chat
from crawler.extraction.chat_test import completion
from crawler.extraction.pictures import STRIPS_PER_CALL, ReadPicture
from crawler.parse.image import picture

SOURCE = WorkSource(
    id=7,
    url="https://example.edu.cn/tzgg.htm",
    browser=False,
    keep_all=False,
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
        content = json.loads(request.content)["messages"][1]["content"]
        self.calls.append([part["image_url"]["url"] for part in content])
        text = f"第{len(self.calls)}次读的文字"
        return httpx.Response(200, json=completion(text, input_tokens=1000, output_tokens=100))


@pytest.fixture
def readings(tmp_path: Path) -> Iterator[Readings]:
    with closing(Readings(tmp_path / "readings.sqlite3")) as kept:
        yield kept


def read(
    pages: dict[str, httpx.Response],
    readings: Readings,
    url: str = PAGE,
    model: FakeModel | None = None,
    usage: list[Usage] | None = None,
) -> NoticePage | None:
    transport = httpx.MockTransport((model or FakeModel()).handle)

    async def use(fetcher: Fetcher) -> NoticePage | None:
        async with Chat("local-test", transport) as llm:
            read_notice = ReadNotice(ReadPicture(llm), readings)
            return await read_notice(
                PageSession(fetcher, None), SOURCE, url, [] if usage is None else usage
            )

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


def test_no_nul_from_a_picture_or_a_link_reaches_the_snapshot(readings: Readings) -> None:
    class Model(FakeModel):
        def handle(self, request: httpx.Request) -> httpx.Response:
            super().handle(request)
            text = "报名截止9月1\x002日"
            return httpx.Response(200, json=completion(text, input_tokens=1, output_tokens=1))

    body = (
        '<div class="v_news_content"><p>自编的通知正文。</p><p><a href="pl%00an.png"></a></p></div>'
    )
    picture = httpx.Response(200, content=png_file("white"))
    page = read(
        {PAGE: httpx.Response(200, html=body), urljoin(PAGE, "pl%00an.png"): picture},
        readings,
        model=Model(),
    )

    assert page is not None
    [attachment] = page.attachments
    assert isinstance(attachment.info, ReadAttachment)
    assert (attachment.info.name, attachment.info.text) == (
        "pl\ufffdan.png",
        "报名截止9月1\ufffd2日",
    )


def test_attachments_keep_their_order_and_the_ones_not_read_say_why(readings: Readings) -> None:
    body = (
        '<div class="v_news_content"><p>自编的通知正文。</p>'
        '<p><a href="files/form.docx">申请表.docx</a></p>'
        '<p><a href="files/letter.doc">推荐信.doc</a></p>'
        '<p><a href="files/list.pdf">名单.pdf</a></p>'
        '<p><a href="files/big.pdf">简章.pdf</a></p>'
        '<p><a href="files/broken.xlsx">名额.xlsx</a></p>'
        '<p><a href="files/denied.pdf">日程.pdf</a></p></div>'
    )
    files = "https://example.edu.cn/info/1001/files"
    broken = b"PK\x03\x04" + b"\x00" * 30
    pages = {
        # The notice moved; its links are relative to where it is now.
        "https://example.edu.cn/old/101.htm": httpx.Response(301, headers={"location": PAGE}),
        PAGE: httpx.Response(200, html=body),
        f"{files}/form.docx": httpx.Response(200, content=docx_file("请于9月20日前提交。")),
        # Some sites answer with a captcha page in place of the file.
        f"{files}/letter.doc": httpx.Response(200, html="<p>请输入验证码下载附件</p>"),
        f"{files}/big.pdf": httpx.Response(200, content=b"%PDF" + b"0" * MAX_FILE),
        f"{files}/broken.xlsx": httpx.Response(200, content=broken),
        f"{files}/denied.pdf": httpx.Response(200, text="Access denied"),
    }
    page = read(pages, readings, "https://example.edu.cn/old/101.htm")
    assert page is not None
    assert page.text == (
        "自编的通知正文。\n申请表.docx\n推荐信.doc\n名单.pdf\n简章.pdf\n名额.xlsx\n日程.pdf"
    )
    unread = {
        "name": "名单.pdf",
        "url": f"{files}/list.pdf",
        "content_type": "application/pdf",
    }
    assert [a.info for a in page.attachments] == [
        ReadAttachment(
            name="申请表.docx",
            url=f"{files}/form.docx",
            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            text="请于9月20日前提交。",
            read_from_pictures=False,
        ),
        UnreadAttachment(
            name="推荐信.doc",
            url=f"{files}/letter.doc",
            content_type="application/msword",
            failure="download_failed",
            detail="返回的是网页",
        ),
        UnreadAttachment(**unread, failure="download_failed", detail="HTTP 404"),
        UnreadAttachment(
            name="简章.pdf",
            url=f"{files}/big.pdf",
            content_type="application/pdf",
            failure="too_large",
        ),
        UnreadAttachment(
            name="名额.xlsx",
            url=f"{files}/broken.xlsx",
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            failure="unreadable",
            detail="BadZipFile",
        ),
        UnreadAttachment(
            name="日程.pdf",
            url=f"{files}/denied.pdf",
            content_type="application/pdf",
            failure="unreadable",
            detail="认不出文件格式",
        ),
    ]
    # A broken file is kept all the same, for people to open themselves.
    assert [a.data for a in page.attachments[1:]] == [None, None, None, broken, b"Access denied"]


def test_an_attachment_the_site_doesnt_answer_for_says_so(readings: Readings) -> None:
    body = '<div class="v_news_content"><p>正文。</p><a href="f.pdf">简章.pdf</a></div>'

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".pdf"):
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(200, html=body)

    async def use() -> NoticePage | None:
        async with (
            Fetcher(httpx.MockTransport(handle), lambda: 0.0, _no_wait) as fetcher,
            Chat("local-test", httpx.MockTransport(FakeModel().handle)) as llm,
        ):
            return await ReadNotice(ReadPicture(llm), readings)(
                PageSession(fetcher, None), SOURCE, PAGE, []
            )

    page = asyncio.run(use())
    assert page is not None
    [attachment] = page.attachments
    assert attachment.info == UnreadAttachment(
        name="简章.pdf",
        url="https://example.edu.cn/info/1001/f.pdf",
        content_type="application/pdf",
        failure="download_failed",
        detail="无法连接",
    )


async def _no_wait(_seconds: float) -> None:
    pass


def words(page: NoticePage) -> tuple[str, bool]:
    """The first attachment's words, and whether the LLM read them from pictures."""
    info = page.attachments[0].info
    assert isinstance(info, ReadAttachment)
    return info.text, info.read_from_pictures


def test_the_llm_reads_a_picture_once_while_the_file_stays_the_same(readings: Readings) -> None:
    body = '<div class="v_news_content"><p>自编的通知正文。</p><p><img src="poster.png"></p></div>'
    poster = "https://example.edu.cn/info/1001/poster.png"
    model = FakeModel()

    usage: list[list[Usage]] = [[], [], []]

    def read_with(image: bytes, spent: list[Usage]) -> NoticePage:
        pages = {PAGE: httpx.Response(200, html=body), poster: httpx.Response(200, content=image)}
        page = read(pages, readings, model=model, usage=spent)
        assert page is not None
        return page

    first = read_with(png_file("white"), usage[0])
    again = read_with(png_file("white"), usage[1])
    changed = read_with(png_file("gray"), usage[2])

    # Evidence in them waits for review, kept from before or not.
    assert [words(page) for page in (first, again, changed)] == [
        ("第1次读的文字", True),
        ("第1次读的文字", True),
        ("第2次读的文字", True),
    ]
    used = Usage(model="deepseek-flash", input_tokens=1000, output_tokens=100)
    assert usage == [[used], [], [used]]
    assert [len(images) for images in model.calls] == [1, 1]
    assert model.calls[0][0].startswith("data:image/png;base64,")


def test_a_long_picture_is_read_a_few_strips_at_a_time_in_order(readings: Readings) -> None:
    body = '<div class="v_news_content"><p>自编的复试名单。</p><p><img src="list.png"></p></div>'
    stream = io.BytesIO()
    Image.new("RGB", (600, 20000), "white").save(stream, "PNG")
    strips = picture(stream.getvalue()).strips
    pages = {
        PAGE: httpx.Response(200, html=body),
        "https://example.edu.cn/info/1001/list.png": httpx.Response(200, content=stream.getvalue()),
    }
    model = FakeModel()

    page = read(pages, readings, model=model)

    assert page is not None
    assert len(strips) > STRIPS_PER_CALL
    groups = list(batched(strips, STRIPS_PER_CALL, strict=False))
    assert [len(images) for images in model.calls] == [len(group) for group in groups]
    assert words(page) == ("\n".join(f"第{n}次读的文字" for n in range(1, len(groups) + 1)), True)


def test_a_picture_the_llm_cant_read_fails_the_notice_and_the_ones_read_still_cost(
    readings: Readings,
) -> None:
    body = (
        '<div class="v_news_content"><p>自编的通知正文。</p>'
        '<p><img src="poster.png"></p><p><img src="schedule.png"></p></div>'
    )
    pages = {
        PAGE: httpx.Response(200, html=body),
        "https://example.edu.cn/info/1001/poster.png": httpx.Response(
            200, content=png_file("white")
        ),
        "https://example.edu.cn/info/1001/schedule.png": httpx.Response(
            200, content=png_file("gray")
        ),
    }
    model = FakeModel()

    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400) if model.calls else model.handle(request)

    usage: list[Usage] = []

    async def use(fetcher: Fetcher) -> NoticePage | None:
        async with Chat("local-test", httpx.MockTransport(handle)) as llm:
            read_notice = ReadNotice(ReadPicture(llm), readings)
            return await read_notice(PageSession(fetcher, None), SOURCE, PAGE, usage)

    with pytest.raises(StepError, match="http_400"):
        FakeSites(pages).run(use)
    assert [u.input_tokens for u in usage] == [1000]
