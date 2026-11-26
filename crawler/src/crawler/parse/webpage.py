import codecs
import re
from urllib.parse import urldefrag, urljoin

from lxml import etree, html
from lxml.html import HtmlElement

from crawler.parse import ParseError


def parse_webpage(body: bytes, content_type: str | None) -> HtmlElement:
    """The page in the charset its response or its own head declares, UTF-8 when neither does."""
    declaration = (content_type or "") + " " + body[:4096].decode("ascii", errors="ignore")
    match = re.search(r"charset\s*=\s*['\"]?([\w.-]+)", declaration, re.IGNORECASE)
    try:
        encoding = codecs.lookup(match[1] if match else "utf-8").name
        return html.document_fromstring(
            body,
            parser=html.HTMLParser(
                encoding=encoding, no_network=True, remove_comments=True, remove_pis=True
            ),
        )
    except (LookupError, etree.ParserError) as error:
        raise ParseError("网页无法解析") from error


def absolute_url(base: str, href: str) -> str | None:
    """`href` resolved against `base`, without its fragment; None when it is too broken to read,
    such as an unclosed IPv6 address. Pages are full of those, and each only spoils its own link."""
    try:
        return urldefrag(urljoin(base, href)).url
    except ValueError:
        return None


def page_without_scripts(body: bytes, content_type: str | None) -> HtmlElement:
    """The page with its scripts and styles emptied: lists are read, and their configurations
    written, without the code some sites put inside a notice's link."""
    root = parse_webpage(body, content_type)
    # Keep the nodes themselves so positional XPath still addresses the original page.
    for node in root.iter("script", "style"):
        node.text = None
    return root


def html_without_scripts(body: bytes, content_type: str | None) -> str:
    return etree.tostring(
        page_without_scripts(body, content_type), encoding="unicode", method="html"
    )
