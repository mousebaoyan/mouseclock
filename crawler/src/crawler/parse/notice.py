"""A notice's page as its snapshot keeps it (design §7.4): the words of the body with the links in
them, the body's HTML, and the files the notice attaches."""

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import unquote, urldefrag, urljoin, urlsplit

from lxml.html import HtmlElement, tostring

from crawler.parse.indexing import Hyperlink
from crawler.parse.webpage import parse_webpage

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
)
# Where some systems list the attachments, apart from the body.
_ATTACHMENT_AREAS = ("Annex", "wrap-appendix", "cas-wrap-appendix")
# VSB's links to a notice's attachments, in the body or listed after it.
_VSB_ATTACHMENT = "DownloadAttachUrl"
_FILE = re.compile(r"\.(?:pdf|docx?|xlsx?|wps|pptx?|zip|rar|7z|jpe?g|png|gif|bmp)$", re.IGNORECASE)
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


def parse_notice(body: bytes, url: str, content_type: str | None) -> Notice:
    """`url` is where the page ended up after redirects; links resolve against it."""
    root = parse_webpage(body, content_type)
    root.make_links_absolute(url, handle_failures="ignore")
    content = _body(root)
    if content is None:
        raise ValueError("认不出正文")
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
    # USTB's graduate school marks its body only as the article in wrapArticle.
    return next(
        (
            element
            for element in root.find_class("article")
            if (parent := element.getparent()) is not None and "wrapArticle" in parent.classes
        ),
        None,
    )


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
                    if href:
                        target = urldefrag(urljoin(url, href)).url
                        links.setdefault(target, name.strip()[:500] or _name(element, target))
            continue
        if element.tag == "img":
            src = element.get("src")
            if src and element in in_body and not any(icon in src for icon in _ICONS):
                target = urldefrag(urljoin(url, src)).url
                links.setdefault(target, _name(element, target))
            continue
        # WebPlus embeds a PDF as a player with its address in pdfsrc.
        href = element.get("pdfsrc") or (element.get("href") if element.tag == "a" else None)
        if not href:
            continue
        target = urldefrag(urljoin(url, href)).url
        if not (element in in_body or element in in_areas or _VSB_ATTACHMENT in target):
            continue
        name = _name(element, target)
        if (
            element.get("pdfsrc")
            or element.get("download") is not None
            or _VSB_ATTACHMENT in target
            or _FILE.search(unquote(urlsplit(target).path))
            or _FILE.search(name)
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
        unquote(PurePosixPath(urlsplit(url).path).name),
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
        if (
            href
            and len(self.starts) > first
            and urlsplit(href).scheme in {"http", "https", "mailto"}
        ):
            self.hyperlinks.append(Hyperlink(self.starts[first], self.length, href))
