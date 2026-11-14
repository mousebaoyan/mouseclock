from datetime import date

import pytest

from crawler.crawl.contract import TimeToDay, TimeToMinute
from crawler.parse.indexing import Document, Hyperlink, index_documents

PUBLISHED = date(2027, 6, 1)


def test_document_order_repeated_text_and_exact_evidence() -> None:
    documents = [
        Document(" 相同句子。\r\n报名\uff1f可以\uff01要求\uff1b说明\n"),
        Document("相同句子。", attachment=0),
        Document("", attachment=1),
        Document("相同句子。", attachment=2),
    ]
    index = index_documents(documents, published_on=PUBLISHED)
    assert [s.text for s in index.sentences.values()] == [
        "相同句子。",
        "报名\uff1f",
        "可以\uff01",
        "要求\uff1b",
        "说明",
        "相同句子。",
        "相同句子。",
    ]
    assert index.evidence("S6").attachment == 0
    assert index.evidence("S7").attachment == 2
    originals = {d.attachment: d.text for d in documents}
    for sentence in index.sentences.values():
        assert originals[sentence.attachment][sentence.start : sentence.end] == sentence.text
        assert index.evidence(sentence.id).quote == sentence.text
    assert index == index_documents(documents, published_on=PUBLISHED)


@pytest.mark.parametrize(
    "href", ["", "/relative", "javascript:alert(1)", "tel:1234", "mailto:bad%E3%80%82", "http://["]
)
def test_unusable_links_do_not_hide_visible_email_or_abort_dates(href: str) -> None:
    text = "office@example.org。8月12日17:00截止。"
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(0, 18, href),))], published_on=PUBLISHED
    )
    assert not index.links
    assert index.emails["E1"].target == "office@example.org"
    assert index.dates["D1"].match.value == TimeToMinute(date=date(2027, 8, 12), time="17:00")


def test_absolute_links_repeated_labels_and_mailto() -> None:
    text = "报名入口\uff1b报名入口。联系\n老师\uff1bcamp@example.org。"
    index = index_documents(
        [
            Document(
                text,
                hyperlinks=(
                    Hyperlink(0, 4, "https://apply.example.org/first"),
                    Hyperlink(5, 9, "https://apply.example.org/second"),
                    Hyperlink(10, 15, "mailto:camp@example.org?subject=Camp"),
                ),
            )
        ],
        published_on=PUBLISHED,
    )
    assert index.links["L1"].target == "https://apply.example.org/first"
    assert index.links["L2"].target == "https://apply.example.org/second"
    assert index.links["L1"].sentence_id != index.links["L2"].sentence_id
    assert index.emails["E1"].text == "联系\n老师"
    assert index.emails["E1"].target == index.emails["E2"].target == "camp@example.org"
    for ref in (*index.links.values(), *index.emails.values()):
        assert text[ref.start : ref.end] == ref.text


def test_url_email_decimal_filename_and_list_punctuation() -> None:
    text = (
        "1. 报名https://apply.example.org/info_(camp)?a=1&b=2。\n"
        "2. 邮箱camp@example.org\uff1b附件说明.pdf\uff0c成绩3.5以上。Next sentence. Last."
    )
    index = index_documents([Document(text)], published_on=PUBLISHED)
    assert [s.text for s in index.sentences.values()] == [
        "1. 报名https://apply.example.org/info_(camp)?a=1&b=2。",
        "2. 邮箱camp@example.org\uff1b",
        "附件说明.pdf\uff0c成绩3.5以上。",
        "Next sentence.",
        "Last.",
    ]
    assert index.links["L1"].target == "https://apply.example.org/info_(camp)?a=1&b=2"


def test_literal_link_is_not_duplicated_and_punctuation_outside_anchor_splits() -> None:
    text = "https://apply.example.org/?。下一句\uff01\uff1f末句。"
    end = text.index("。")
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(0, end, "https://apply.example.org/"),))],
        published_on=PUBLISHED,
    )
    assert len(index.links) == 1
    assert [s.text for s in index.sentences.values()] == [
        text[: end + 1],
        "下一句\uff01\uff1f",
        "末句。",
    ]


def test_date_ids_link_exact_source_with_values_and_attachment() -> None:
    documents = [
        Document("自即日起至6月18日17:00报名。"),
        Document("6月20日前提交。", attachment=0),
    ]
    index = index_documents(documents, published_on=PUBLISHED)
    assert index.dates["D1"].match.value == TimeToDay(date=PUBLISHED)
    assert index.dates["D1"].match.end_value == TimeToMinute(date=date(2027, 6, 18), time="17:00")
    assert index.evidence(index.dates["D2"].sentence_id).attachment == 0
    originals = {d.attachment: d.text for d in documents}
    for mention in index.dates.values():
        sentence = index.sentences[mention.sentence_id]
        assert (
            originals[sentence.attachment][mention.match.start : mention.match.end]
            == mention.match.text
        )


@pytest.mark.parametrize(
    "url", ["https://example.org/2027年6月1日", "https://example.org/?date=2027-06-01"]
)
def test_dates_in_addresses_are_excluded_but_anchor_labels_are_kept(url: str) -> None:
    text = f"{url}。6月18日截止。"
    start = text.index("6月18日")
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(start, start + 5, "https://example.org/notice"),))],
        published_on=PUBLISHED,
    )
    assert [d.match.text for d in index.dates.values()] == ["6月18日"]
