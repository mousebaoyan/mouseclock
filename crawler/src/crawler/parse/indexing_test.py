from datetime import date

import pytest

from crawler.crawl.contract import TimeToDay, TimeToMinute, TimeToMonth
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


def test_dates_in_addresses_are_excluded_but_anchor_labels_are_kept() -> None:
    text = "https://example.org/2027年6月1日。6月18日截止。"
    start = text.index("6月18日")
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(start, start + 5, "https://example.org/notice"),))],
        published_on=PUBLISHED,
    )
    assert [d.match.text for d in index.dates.values()] == ["6月18日"]


def test_extended_dates_preserve_document_offsets_and_exclude_numeric_addresses() -> None:
    body = (
        "https://example.org/2028-06-30。camp2028.06.30@example.org。\r\n"
        "报名截止2028/6/30 17\uff1a00。"
    )
    label = "2028/6/30 17\uff1a00"
    start = body.index(label)
    documents = [
        Document(
            body, hyperlinks=(Hyperlink(start, start + len(label), "https://apply.example.org"),)
        ),
        Document("七月上旬举办。\r\n报名截止7.5前。", attachment=0),
    ]
    index = index_documents(documents, published_on=date(2028, 6, 1))
    mentions = list(index.dates.values())
    assert [m.match.text for m in mentions] == [label, "七月上旬", "7.5前"]
    assert [m.match.value for m in mentions] == [
        TimeToMinute(date=date(2028, 6, 30), time="17:00"),
        TimeToMonth(month="2028-07", part="early"),
        TimeToDay(date=date(2028, 7, 5), mark="before"),
    ]
    originals = {document.attachment: document.text for document in documents}
    for mention in mentions:
        sentence = index.sentences[mention.sentence_id]
        assert (
            originals[sentence.attachment][mention.match.start : mention.match.end]
            == mention.match.text
        )
    assert index.evidence(mentions[-1].sentence_id).attachment == 0


@pytest.mark.parametrize(
    ("expression", "start", "end"),
    [
        ("2027. 6. 30 17:00", TimeToMinute(date=date(2027, 6, 30), time="17:00"), None),
        ("6. 30", TimeToDay(date=date(2027, 6, 30)), None),
        ("6. 30至7. 1", TimeToDay(date=date(2027, 6, 30)), TimeToDay(date=date(2027, 7, 1))),
    ],
)
def test_spaced_numeric_dates_stay_in_their_evidence_sentence(
    expression: str, start: TimeToDay | TimeToMinute, end: TimeToDay | None
) -> None:
    sentence = f"报名时间{expression}。"
    text = f"Intro. {sentence}Done."
    index = index_documents([Document(text)], published_on=PUBLISHED)
    assert [s.text for s in index.sentences.values()] == ["Intro.", sentence, "Done."]
    [mention] = index.dates.values()
    assert mention.match.text == expression
    assert mention.match.value == start
    assert mention.match.end_value == end
    assert text[mention.match.start : mention.match.end] == expression
    assert index.evidence(mention.sentence_id).quote == sentence


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("版本6.30-7月1日发布", "7月1日"),
        ("版本2027.6.30-7月1日发布", "7月1日"),
        ("版本6.30至七月上旬更新", "七月上旬"),
    ],
)
def test_rejected_numeric_versions_do_not_hide_later_date_ids(text: str, expected: str) -> None:
    index = index_documents([Document(text)], published_on=PUBLISHED)
    [mention] = index.dates.values()
    assert mention.match.text == expected
    assert mention.match.issue is None
    assert text[mention.match.start : mention.match.end] == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("版本2027. 6. 30截止支持", []),
        ("版本2027. 6. 30-7月1日发布", ["7月1日"]),
        ("版本2027. 6. 30发布。报名截止7. 1。", ["7. 1"]),
    ],
)
def test_sentence_boundaries_keep_the_full_numeric_rejection_context(
    text: str, expected: list[str]
) -> None:
    index = index_documents([Document(text)], published_on=PUBLISHED)
    assert [mention.match.text for mention in index.dates.values()] == expected
