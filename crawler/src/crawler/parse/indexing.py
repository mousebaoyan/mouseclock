"""An index into snapshot text; IDs are local to one invocation, never global identifiers."""

import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date
from typing import Literal
from urllib.parse import unquote, urljoin, urlsplit

from crawler.crawl.contract import Evidence
from crawler.parse.dates import DateMatch, find_dates

_EMAIL = r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}"
_REFERENCE = re.compile(
    rf"(?P<url>https?://[^\s<>\"“”\u2018\u2019\uff0c。\uff01\uff1f\uff1b、"
    rf"\uff08\uff09【】《》\u4e00-\u9fff]+)|"
    rf"(?P<email>(?:mailto:)?{_EMAIL})",
    re.IGNORECASE,
)
_BREAK = re.compile(r"[。\uff01\uff1f!?\uff1b;]|\r\n|[\r\n]|\.(?=\s|$)")


@dataclass(frozen=True)
class Hyperlink:
    start: int
    end: int
    href: str


@dataclass(frozen=True)
class Document:
    text: str
    attachment: int | None = None
    url: str | None = None
    hyperlinks: tuple[Hyperlink, ...] = ()


@dataclass(frozen=True)
class Sentence:
    id: str
    attachment: int | None
    start: int
    end: int
    text: str


@dataclass(frozen=True)
class Reference:
    id: str
    sentence_id: str
    start: int
    end: int
    text: str
    target: str | None
    href: str | None = None
    issue: Literal["invalid_target"] | None = None


@dataclass(frozen=True)
class DateMention:
    id: str
    sentence_id: str
    match: DateMatch


@dataclass(frozen=True)
class NoticeIndex:
    source_url: str | None
    published_on: date | None
    sentences: dict[str, Sentence]
    dates: dict[str, DateMention]
    links: dict[str, Reference]
    emails: dict[str, Reference]

    def evidence(self, sentence_id: str) -> Evidence:
        sentence = self.sentences[sentence_id]
        return Evidence(quote=sentence.text, attachment=sentence.attachment)


@dataclass(frozen=True)
class _LocatedReference:
    start: int
    end: int
    target: str | None
    kind: Literal["url", "email"]
    href: str | None = None


def _target(href: str, base_url: str | None) -> tuple[str | None, Literal["url", "email"]]:
    if not urlsplit(href).scheme and base_url is None:
        raise ValueError("Relative hyperlink requires a base URL")
    target = urljoin(base_url, href) if base_url is not None else href
    parts = urlsplit(target)
    if parts.scheme == "mailto":
        address = unquote(parts.path)
        return (address if re.fullmatch(_EMAIL, address) is not None else None), "email"
    if parts.scheme in {"http", "https"}:
        return (target if parts.netloc else None), "url"
    raise ValueError("Link must be an HTTP(S) URL or a single mailto address")


def _references(document: Document, source_url: str | None) -> list[_LocatedReference]:
    references: list[_LocatedReference] = []
    for link in sorted(document.hyperlinks, key=lambda link: link.start):
        if not 0 <= link.start < link.end <= len(document.text):
            raise ValueError("Hyperlink offsets must select nonempty document text")
        if references and link.start < references[-1].end:
            raise ValueError("Hyperlink spans must not overlap")
        target, kind = _target(link.href, document.url or source_url)
        references.append(_LocatedReference(link.start, link.end, target, kind, link.href))
    for match in _REFERENCE.finditer(document.text):
        start, end = match.span()
        if any(
            ref.target is not None and start < ref.end and end > ref.start for ref in references
        ):
            continue
        raw = match[0].rstrip(".,;:!?")
        for opening, closing in (("(", ")"), ("[", "]"), ("{", "}")):
            while raw.endswith(closing) and raw.count(closing) > raw.count(opening):
                raw = raw[:-1]
        end = start + len(raw)
        if match["email"] is not None:
            target = raw[7:] if raw[:7].lower() == "mailto:" else raw
            kind = "email"
        else:
            target, kind = _target(raw, document.url or source_url)
        references.append(_LocatedReference(start, end, target, kind))
    return sorted(references, key=lambda reference: reference.start)


def _sentences(text: str, references: list[_LocatedReference]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    start = 0
    reference_position = 0
    for match in _BREAK.finditer(text):
        while (
            reference_position < len(references)
            and references[reference_position].end <= match.start()
        ):
            reference_position += 1
        if (
            reference_position < len(references)
            and references[reference_position].start < match.end()
        ):
            continue
        if match[0] == "." and re.fullmatch(
            r"[0-9]+(?:\.[0-9]+)*", text[start : match.start()].strip()
        ):
            continue
        newline = match[0][0] in "\r\n"
        end = match.start() if newline else match.end()
        if match.start() == start and not newline and spans and spans[-1][1] == start:
            spans[-1] = (spans[-1][0], end)
        elif start < end:
            spans.append((start, end))
        start = match.end()
    spans.append((start, len(text)))
    trimmed: list[tuple[int, int]] = []
    for start, end in spans:
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start < end:
            trimmed.append((start, end))
    return trimmed


def index_documents(
    documents: Sequence[Document], *, published_on: date | None, source_url: str | None = None
) -> NoticeIndex:
    index = NoticeIndex(source_url, published_on, {}, {}, {}, {})
    sources: set[int | None] = set()
    for document in sorted(
        documents, key=lambda document: -1 if document.attachment is None else document.attachment
    ):
        if document.attachment in sources:
            raise ValueError("Each snapshot document must appear only once")
        if document.attachment is not None and not 0 <= document.attachment <= 99:
            raise ValueError("Attachment position must be between 0 and 99")
        sources.add(document.attachment)
        references = _references(document, source_url)
        reference_position = 0
        for start, end in _sentences(document.text, references):
            sentence_id = f"S{len(index.sentences) + 1}"
            sentence = Sentence(
                sentence_id, document.attachment, start, end, document.text[start:end]
            )
            index.sentences[sentence_id] = sentence
            while (
                reference_position < len(references) and references[reference_position].start < end
            ):
                ref = references[reference_position]
                collection = index.links if ref.kind == "url" else index.emails
                reference_id = f"{'L' if ref.kind == 'url' else 'E'}{len(collection) + 1}"
                collection[reference_id] = Reference(
                    reference_id,
                    sentence_id,
                    ref.start,
                    ref.end,
                    document.text[ref.start : ref.end],
                    ref.target,
                    ref.href,
                    None if ref.target is not None else "invalid_target",
                )
                reference_position += 1
            address_spans = [
                (start + address.start(), start + address.end())
                for address in _REFERENCE.finditer(sentence.text)
            ]
            for match in find_dates(sentence.text, published_on):
                located = replace(match, start=start + match.start, end=start + match.end)
                # Dates embedded in a URL or an email are not dates asserted by the notice.
                if any(
                    located.start < address_end and located.end > address_start
                    for address_start, address_end in address_spans
                ):
                    continue
                date_id = f"D{len(index.dates) + 1}"
                index.dates[date_id] = DateMention(date_id, sentence_id, located)
    return index
