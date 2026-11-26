"""Pages a site shows in place of the notice or file asked for, saying it won't give them out: a
login, a page for its campus only, a captcha. The crawler doesn't get past them (design §7.2)."""

import re
from urllib.parse import urlsplit

from crawler.parse import ParseError
from crawler.parse.webpage import parse_webpage

# Where single sign-on sends whoever hasn't logged in (cas/login, tpass/login, VSB's
# caslogin.jsp), and where 公众号 sends some networks (wappoc_appmsgcaptcha). Only the last
# segment of the path counts: a notice can be filed under a name that merely mentions them.
_LOGIN = re.compile(r"/(?:cas)?login(?:\.jsp)?$")
_CAPTCHA = re.compile(r"/\w*captcha$")
# How WebPlus marks the page it shows in place of an article this address may not read.
_WEBPLUS_REFUSED = b"<!--No Permission-->"
# The website keeps details up to 1000 characters.
_MAX_DETAIL = 1000


def refusal(body: bytes, url: str, content_type: str | None) -> str | None:
    """Why the site won't give out what was asked for, when the page the request ended up at,
    `url`, says so."""
    path = urlsplit(url).path.lower()
    if _LOGIN.search(path):
        return "要登录"
    if _CAPTCHA.search(path):
        return "要验证码"
    try:
        root = parse_webpage(body, content_type)
    except ParseError:
        return None
    if _WEBPLUS_REFUSED in body and (message := root.find_class("wp_error_msg")):
        reason = " ".join(message[0].text_content().split()).removeprefix("提示\uff1a")
        return reason[:_MAX_DETAIL]
    # VSB asks for a captcha before some downloads, under the heading 请输入验证码下载附件.
    code = root.get_element_by_id("codeValue", None)
    if code is not None and code.tag == "input" and root.xpath("//h1[contains(., '验证码')]"):
        return "要验证码"
    return None
