import io

import docx
import httpx
import pytest

from crawler.crawl.browser import PageSession
from crawler.crawl.contract import WorkSource
from crawler.crawl.fetch_test import FakeSites
from crawler.crawl.notice import read_notice
from crawler.crawl.rounds import NoticePage, StepError

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


def read(pages: dict[str, httpx.Response], url: str = PAGE) -> NoticePage | None:
    return FakeSites(pages).run(
        lambda fetcher: read_notice(PageSession(fetcher, None), SOURCE, url)
    )


@pytest.mark.parametrize("status", [404, 410])
def test_a_page_that_is_gone_reads_as_none(status: int) -> None:
    assert read({PAGE: httpx.Response(status)}) is None


@pytest.mark.parametrize(
    ("response", "failure", "detail"),
    [
        (httpx.Response(403), "http_status", "HTTP 403"),
        (httpx.Response(200, html="<div>自编的正文</div>"), "error", "认不出正文"),
    ],
)
def test_a_page_that_cant_be_read_fails_the_notice(
    response: httpx.Response, failure: str, detail: str
) -> None:
    with pytest.raises(StepError) as caught:
        read({PAGE: response})
    assert (caught.value.failure, caught.value.detail) == (failure, detail)


def test_attachments_keep_their_order_and_the_ones_not_downloaded_stay_listed() -> None:
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
    page = read(pages, "https://example.edu.cn/old/101.htm")
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
