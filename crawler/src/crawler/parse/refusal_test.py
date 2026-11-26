import pytest

from crawler.parse.refusal import refusal

NOTICE = '<div class="v_news_content"><p>自编的通知正文。</p></div>'


@pytest.mark.parametrize(
    ("url", "page"),
    [
        ("https://example.edu.cn/portallogin/news.htm", NOTICE),
        ("https://example.edu.cn/notices/login.htm", NOTICE),
        ("https://example.edu.cn/notice/captcha-guide.htm", NOTICE),
        ("https://example.edu.cn/notice/42.htm", NOTICE + '<div id="codeValue">验证码说明</div>'),
        ("https://example.edu.cn/notice/42.htm", NOTICE + '<input id="codeValue">'),
        (
            "https://example.edu.cn/notice/42.htm",
            NOTICE + '<input id="codeValue"><script>alert("请输入验证码")</script>',
        ),
    ],
)
def test_a_page_that_only_mentions_a_login_or_a_captcha_is_no_refusal(url: str, page: str) -> None:
    assert refusal(page.encode(), url, None) is None


def test_a_long_reason_is_cut_to_what_the_website_keeps() -> None:
    page = '<!--No Permission--><div class="wp_error_msg">提示\uff1a' + "限" * 1500 + "</div>"
    assert refusal(page.encode(), "https://example.edu.cn/a/page.psp", None) == "限" * 1000
