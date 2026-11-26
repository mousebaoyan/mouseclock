"""A notice's page as its snapshot keeps it (design §7.4): the words of the body with the links in
them, the body's HTML, and the files the notice attaches."""

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from lxml.html import HtmlElement, tostring

from crawler.parse import ParseError, without_nul
from crawler.parse.indexing import Hyperlink
from crawler.parse.webpage import absolute_url, parse_webpage

# The body as the site systems of the sources mark it, more specific first (design §7.2);
# fixtures/notice/README.md lists the systems and the sites they come from.
_BODIES = (
    "v_news_content",
    "wp_articlecontent",
    "TRS_UEDITOR",
    "gp-content",
    "gp-article",
    "b-abody",
    "b-pagecontent",
    "abody",
    "rich_media_content",
)
# Bodies marked only by where they sit: a class right within one of its parent's.
_NESTED_BODIES = (
    # GPower, as USTB's graduate school has it, then its other themes.
    ("wrapArticle", "article"),
    ("pageArticle", "article"),
    ("page_article", "article"),
    ("gp-container", "article"),
    ("newsInfo", "newsInfoCon"),
    ("boxcontent", "article-content"),
    ("detail-sticky-left-content", "news-info"),
    ("blog-single-inner", "blog-inner-text"),
)
# Drupal gives blocks around the page, such as a banner or a word about the college, a body field
# as well; the notice's own is the one in the node shown in full.
_DRUPAL_BODY = "field-body"
# VSB marks some bodies only by this id.
_VSB_BODY = "vsb_content"
# Editors' marks, tried after all the rest: TRS's older editor and TinyMCE, and Fudan's body,
# which sits in a plain div.
_LATE_BODIES = ("TRS_Editor", "mce-content-body", "view-cnt")
# Where some systems list the attachments, apart from the body.
_ATTACHMENT_AREAS = ("Annex", "wrap-appendix", "cas-wrap-appendix")
# VSB's links to a notice's attachments, in the body or listed after it.
_VSB_ATTACHMENT = "DownloadAttachUrl"
FILE_NAME = re.compile(
    r"\.(?:pdf|docx?|xlsx?|wps|pptx?|zip|rar|7z|jpe?g|png|gif|bmp)$", re.IGNORECASE
)
# TRS writes a notice's attachments into its page script, which fills the attachment area in a
# browser: addresses and names, separated by |. They are read from the script, which never runs.
_TRS_HREFS = re.compile(r"appLinkStr\s*=\s*'([^']*)'")
_TRS_NAMES = re.compile(r"appDescStr\s*=\s*'([^']*)'")
# The editors' file-type icons beside attachment links.
_ICONS = ("/fileTypeImages/", "/_ueditor/")
_BLOCKS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "tfoot",
    "thead",
    "tr",
    "ul",
}
_CELLS = {"td", "th"}
_HIDDEN = {"script", "style", "noscript", "template"}
# From weakest to strongest; of the gaps met between two words, the strongest is kept.
_GAPS = ("", " ", "\t", "\n")


@dataclass(frozen=True)
class AttachmentLink:
    name: str
    url: str


@dataclass(frozen=True)
class Notice:
    html: str
    text: str
    hyperlinks: tuple[Hyperlink, ...]
    # In the order they appear on the page.
    attachments: list[AttachmentLink]


def file_name(url: str) -> str:
    """The last part of the address's path, decoded."""
    return without_nul(unquote(PurePosixPath(urlsplit(url).path).name))


def parse_notice(body: bytes, url: str, content_type: str | None) -> Notice:
    """`url` is where the page ended up after redirects; links resolve against it."""
    root = parse_webpage(body, content_type)
    # Two steps, as make_links_absolute doesn't pass handle_failures on to <base>: a link broken
    # against the page's <base>, or a <base> broken itself, then spoils only that link.
    root.resolve_base_href(handle_failures="ignore")
    root.make_links_absolute(url, resolve_base_href=False, handle_failures="ignore")
    content = _body(root)
    if content is None:
        raise ParseError("认不出正文")
    text = _Text()
    text.walk(content)
    return Notice(
        tostring(content, encoding="unicode", with_tail=False),
        "".join(text.parts),
        tuple(text.hyperlinks),
        _attachments(root, content, url),
    )


def _body(root: HtmlElement) -> HtmlElement | None:
    for name in _BODIES:
        if found := root.find_class(name):
            return found[0]
    for parent, name in _NESTED_BODIES:
        for element in root.find_class(name):
            if (above := element.getparent()) is not None and parent in above.classes:
                return element
    for node in root.find_class("node--view-mode-full"):
        if found := node.find_class(_DRUPAL_BODY):
            return found[0]
    if (found := root.get_element_by_id(_VSB_BODY, None)) is not None:
        return found
    for name in _LATE_BODIES:
        if found := root.find_class(name):
            return found[0]
    return None


def _attachments(root: HtmlElement, content: HtmlElement, url: str) -> list[AttachmentLink]:
    in_body = set(content.iter())
    in_areas = {
        element
        for name in _ATTACHMENT_AREAS
        for area in root.find_class(name)
        for element in area.iter()
    }
    links: dict[str, str] = {}
    for element in root.iter():
        if element.tag == "script":
            script = element.text or ""
            if (hrefs := _TRS_HREFS.search(script)) and (names := _TRS_NAMES.search(script)):
                for href, name in zip(hrefs[1].split("|"), names[1].split("|"), strict=False):
                    if href and (target := absolute_url(url, href)):
                        links.setdefault(target, name.strip()[:500] or _name(element, target))
            continue
        if element.tag == "img":
            # Pages that load pictures as they scroll into view, 公众号的文章 among them, keep the
            # address in data-src while src is empty or a placeholder.
            src = element.get("src")
            if not src or src.startswith("data:"):
                src = element.get("data-src")
            if (
                src
                and element in in_body
                and not any(icon in src for icon in _ICONS)
                and (target := absolute_url(url, src))
            ):
                links.setdefault(target, _name(element, target))
            continue
        if element.tag == "iframe" and not element.get("pdfsrc"):
            # A file the body shows in a frame, such as a notice that is a PDF and nothing more.
            src = element.get("src")
            if src and element in in_body and (target := absolute_url(url, src)):
                name = file_name(target)
                if FILE_NAME.search(name):
                    links.setdefault(target, name[:500])
            continue
        # WebPlus embeds a PDF as a player with its address in pdfsrc.
        href = element.get("pdfsrc") or (element.get("href") if element.tag == "a" else None)
        if not href or not (target := absolute_url(url, href)):
            continue
        if not (element in in_body or element in in_areas or _VSB_ATTACHMENT in target):
            continue
        name = _name(element, target)
        if (
            element.get("pdfsrc")
            or element.get("download") is not None
            or _VSB_ATTACHMENT in target
            or FILE_NAME.search(unquote(urlsplit(target).path))
            or FILE_NAME.search(name)
        ):
            links.setdefault(target, name)
    # The website keeps addresses up to 2000 characters.
    return [
        AttachmentLink(name, target)
        for target, name in links.items()
        if urlsplit(target).scheme in {"http", "https"} and len(target) <= 2000
    ]


def _name(element: HtmlElement, url: str) -> str:
    embedded = re.search(r"'title':'([^']+)'", element.get("sudyfile-attr", ""))
    for candidate in (
        element.get("download"),
        element.get("title"),
        element.text_content(),
        embedded and embedded[1],
        element.get("alt"),
        file_name(url),
    ):
        name = " ".join((candidate or "").split())
        # VSB writes some names in brackets: 【附件1.docx】.
        if bracketed := re.fullmatch(r"【(.+)】", name):
            name = bracketed[1]
        if name:
            return name[:500]
    return "附件"


class _Text:
    """The words of an element as a reader sees them: blocks on lines of their own, table cells
    apart by tabs, spaces collapsed; and where each link's words are."""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.length = 0
        self.gap = ""
        # Where each run of words begins, so a link knows where its first word went.
        self.starts: list[int] = []
        self.hyperlinks: list[Hyperlink] = []

    def separate(self, gap: str) -> None:
        self.gap = max(self.gap, gap, key=_GAPS.index)

    def add(self, words: str) -> None:
        if words[:1].isspace():
            self.separate(" ")
        if run := " ".join(words.split()):
            if self.length and self.gap:
                self.parts.append(self.gap)
                self.length += len(self.gap)
            self.gap = ""
            self.starts.append(self.length)
            self.parts.append(run)
            self.length += len(run)
        if words[-1:].isspace():
            self.separate(" ")

    def walk(self, element: HtmlElement, in_cell: bool = False) -> None:
        if element.tag in _HIDDEN:
            return
        if element.tag in _CELLS:
            gap = "\t"
        elif element.tag in _BLOCKS:
            # Paragraphs in a cell stay on its row's line.
            gap = " " if in_cell else "\n"
        else:
            gap = ""
        self.separate(gap)
        first = len(self.starts)
        self.add(element.text or "")
        for child in element:
            self.walk(child, in_cell or element.tag in _CELLS)
            self.add(child.tail or "")
        self.separate(gap)
        href = element.get("href") if element.tag == "a" else None
        if href and len(self.starts) > first and _linkable(href):
            self.hyperlinks.append(Hyperlink(self.starts[first], self.length, href))


def _linkable(href: str) -> bool:
    # A link make_links_absolute couldn't read is left as it was.
    try:
        return urlsplit(href).scheme in {"http", "https", "mailto"}
    except ValueError:
        return False
