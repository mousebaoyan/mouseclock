import codecs
import re

from lxml import etree, html
from lxml.html import HtmlElement


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
        raise ValueError("网页无法解析") from error
