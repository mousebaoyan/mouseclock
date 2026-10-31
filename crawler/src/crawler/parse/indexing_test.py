from datetime import date

import pytest

from crawler.crawl.contract import TimeToDay, TimeToMinute
from crawler.parse.indexing import Document, Hyperlink, index_documents

SOURCE = "https://admissions.example.org/notices/camp.html"
PUBLISHED = date(2027, 6, 1)


def test_indexing_without_a_notice_url_uses_only_supplied_content() -> None:
    index = index_documents(
        [Document("6月18日截止。https://apply.example.org/camp。camp@example.org。")],
        published_on=PUBLISHED,
    )
    assert index.source_url is None
    assert index.dates["D1"].match.value == TimeToDay(date=date(2027, 6, 18))
    assert index.links["L1"].target == "https://apply.example.org/camp"
    assert index.emails["E1"].target == "camp@example.org"


def test_relative_hyperlinks_require_an_actual_base_url() -> None:
    with pytest.raises(ValueError, match="base URL"):
        index_documents(
            [Document("报名入口", hyperlinks=(Hyperlink(0, 4, "/apply"),))],
            published_on=PUBLISHED,
        )
    index = index_documents(
        [Document("报名入口", url=SOURCE, hyperlinks=(Hyperlink(0, 4, "/apply"),))],
        published_on=PUBLISHED,
    )
    assert index.links["L1"].target == "https://admissions.example.org/apply"


def test_malformed_mailto_keeps_its_issue_and_does_not_hide_a_visible_address() -> None:
    text = "office@example.org\uff1b8月12日17:00截止。"
    address_end = len("office@example.org")
    index = index_documents(
        [
            Document(
                text, hyperlinks=(Hyperlink(0, address_end, "mailto:office@example.org%E3%80%82"),)
            )
        ],
        published_on=PUBLISHED,
    )
    assert index.emails["E1"].target is None
    assert index.emails["E1"].issue == "invalid_target"
    assert index.emails["E1"].href == "mailto:office@example.org%E3%80%82"
    assert index.emails["E2"].target == "office@example.org"
    assert index.emails["E2"].issue is None
    assert index.dates["D1"].match.value == TimeToMinute(date=date(2027, 8, 12), time="17:00")


def test_body_attachments_and_repeated_quotes_keep_their_own_locations() -> None:
    documents = [
        Document("相同句子。", attachment=1),
        Document("\t相同句子。\r\n报名\uff1f可以\uff01要求\uff1b说明\n"),
        Document("相同句子。", attachment=0),
        Document("", attachment=2),
    ]
    index = index_documents(documents, published_on=PUBLISHED, source_url=SOURCE)
    assert [s.text for s in index.sentences.values()] == [
        "相同句子。",
        "报名\uff1f",
        "可以\uff01",
        "要求\uff1b",
        "说明",
        "相同句子。",
        "相同句子。",
    ]
    assert index.evidence("S1").model_dump(exclude_none=True) == {"quote": "相同句子。"}
    assert index.evidence("S6").model_dump(exclude_none=True) == {
        "quote": "相同句子。",
        "attachment": 0,
    }
    assert index.evidence("S7").attachment == 1
    originals = {document.attachment: document.text for document in documents}
    for sentence in index.sentences.values():
        assert originals[sentence.attachment][sentence.start : sentence.end] == sentence.text
    assert index == index_documents(documents, published_on=PUBLISHED, source_url=SOURCE)
    with pytest.raises(KeyError):
        index.evidence("S99")


def test_urls_emails_decimals_and_filenames_are_not_split_at_internal_punctuation() -> None:
    text = (
        "报名https://apply.example.org/camp?year=2028;a=1。"
        "邮箱camp@example.org\uff1b附件说明.pdf\uff0c成绩3.5以上。Next sentence. Last."
    )
    index = index_documents([Document(text)], published_on=PUBLISHED, source_url=SOURCE)
    assert [s.text for s in index.sentences.values()] == [
        "报名https://apply.example.org/camp?year=2028;a=1。",
        "邮箱camp@example.org\uff1b",
        "附件说明.pdf\uff0c成绩3.5以上。",
        "Next sentence.",
        "Last.",
    ]
    assert index.links["L1"].target == "https://apply.example.org/camp?year=2028;a=1"
    assert index.links["L1"].sentence_id == "S1"
    assert index.emails["E1"].target == "camp@example.org"


def test_hyperlinks_use_explicit_offsets_and_resolve_relative_targets() -> None:
    text = "请到报名平台报名\uff1b帮助页面有说明。"
    links = (
        Hyperlink(2, 6, "https://apply.example.org/camp?year=2028"),
        Hyperlink(9, 13, "/help/camp.html"),
    )
    index = index_documents(
        [Document(text, hyperlinks=links)], published_on=PUBLISHED, source_url=SOURCE
    )
    assert index.links["L1"].text == "报名平台"
    assert index.links["L2"].text == "帮助页面"
    assert index.links["L2"].target == "https://admissions.example.org/help/camp.html"
    assert index.links["L2"].href == "/help/camp.html"
    assert index.links["L2"].sentence_id == "S2"
    for ref in index.links.values():
        assert text[ref.start : ref.end] == ref.text


def test_repeated_anchor_labels_are_located_by_offsets_not_text_search() -> None:
    text = "报名入口\uff1b报名入口。"
    index = index_documents(
        [
            Document(
                text,
                hyperlinks=(
                    Hyperlink(0, 4, "/first"),
                    Hyperlink(5, 9, "/second"),
                ),
            )
        ],
        published_on=PUBLISHED,
        source_url=SOURCE,
    )
    assert index.links["L1"].target == "https://admissions.example.org/first"
    assert index.links["L2"].target == "https://admissions.example.org/second"
    assert index.links["L1"].sentence_id != index.links["L2"].sentence_id


def test_a_multiline_anchor_stays_intact_and_mailto_has_an_email_id() -> None:
    text = "联系\n老师\uff1bcamp@example.org。"
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(0, 5, "mailto:camp@example.org?subject=Camp"),))],
        published_on=PUBLISHED,
        source_url=SOURCE,
    )
    assert index.emails["E1"].text == "联系\n老师"
    assert index.emails["E1"].target == "camp@example.org"
    assert index.emails["E2"].target == "camp@example.org"
    assert len(index.sentences) == 2


def test_literal_links_inside_anchors_are_not_duplicated() -> None:
    text = "https://apply.example.org/。"
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(0, len(text) - 1, "/apply"),))],
        published_on=PUBLISHED,
        source_url=SOURCE,
    )
    assert len(index.links) == 1
    assert index.links["L1"].target == "https://admissions.example.org/apply"


def test_punctuation_next_to_a_protected_link_still_ends_its_sentence() -> None:
    text = "如何报名?。下一句\uff01\uff1f最后一句。"
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(0, 5, "/help"),))],
        published_on=PUBLISHED,
        source_url=SOURCE,
    )
    assert [s.text for s in index.sentences.values()] == [
        "如何报名?。",
        "下一句\uff01\uff1f",
        "最后一句。",
    ]


def test_url_brackets_queries_and_trailing_punctuation() -> None:
    text = "See (https://apply.example.org/info_(camp)?a=1&b=2).\nMail: mailto:camp@example.org."
    index = index_documents([Document(text)], published_on=PUBLISHED, source_url=SOURCE)
    assert index.links["L1"].target == "https://apply.example.org/info_(camp)?a=1&b=2"
    assert index.emails["E1"].target == "camp@example.org"


def test_chinese_wrappers_do_not_become_part_of_a_url() -> None:
    text = "报名地址\uff08https://apply.example.org/camp\uff09。"
    index = index_documents([Document(text)], published_on=PUBLISHED, source_url=SOURCE)
    assert index.links["L1"].target == "https://apply.example.org/camp"
    assert index.links["L1"].text == "https://apply.example.org/camp"


def test_numbered_list_prefixes_stay_with_their_instructions() -> None:
    text = "1. 请于7月18日前报名。\n  2. 提交附件材料。\n3.1. 阅读说明。"
    index = index_documents([Document(text)], published_on=PUBLISHED)
    assert [sentence.text for sentence in index.sentences.values()] == [
        "1. 请于7月18日前报名。",
        "2. 提交附件材料。",
        "3.1. 阅读说明。",
    ]
    assert index.dates["D1"].sentence_id == "S1"
    for sentence in index.sentences.values():
        assert text[sentence.start : sentence.end] == sentence.text


def test_date_ids_connect_values_to_their_exact_sentence_and_document() -> None:
    text = "网上报名自即日起至6月18日17:00。材料请于6月20日前发送。"
    attachment = "材料截止\uff1a6月20日前。"
    index = index_documents(
        [Document(text), Document(attachment, attachment=0)],
        published_on=PUBLISHED,
        source_url=SOURCE,
    )
    assert index.source_url == SOURCE
    assert index.published_on == PUBLISHED
    first = index.dates["D1"]
    assert first.sentence_id == "S1"
    assert first.match.value == TimeToDay(date=PUBLISHED)
    assert first.match.end_value == TimeToMinute(date=date(2027, 6, 18), time="17:00")
    second, third = index.dates["D2"], index.dates["D3"]
    assert second.match.value == third.match.value
    assert index.evidence(third.sentence_id).attachment == 0
    originals = {None: text, 0: attachment}
    for mention in index.dates.values():
        sentence = index.sentences[mention.sentence_id]
        assert (
            originals[sentence.attachment][mention.match.start : mention.match.end]
            == mention.match.text
        )


def test_dates_inside_addresses_are_excluded_but_dates_in_anchor_labels_are_retained() -> None:
    text = "https://example.org/2027年6月1日。6月1日公告\uff0c6月18日截止。"
    # A date used as a link label is still visible notice content.
    start = text.index("6月1日公告")
    index = index_documents(
        [Document(text, hyperlinks=(Hyperlink(start, start + 6, "/notice"),))],
        published_on=PUBLISHED,
        source_url=SOURCE,
    )
    assert [d.match.text for d in index.dates.values()] == ["6月1日", "6月18日"]


@pytest.mark.parametrize(
    ("link", "message"),
    [
        (Hyperlink(-1, 2, "/apply"), "offsets"),
        (Hyperlink(0, 100, "/apply"), "offsets"),
        (Hyperlink(1, 1, "/apply"), "offsets"),
        (Hyperlink(0, 2, "javascript:alert(1)"), "HTTP"),
    ],
)
def test_bad_external_hyperlink_metadata_is_rejected(link: Hyperlink, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        index_documents(
            [Document("报名入口。", hyperlinks=(link,))], published_on=PUBLISHED, source_url=SOURCE
        )


def test_ambiguous_sources_and_overlapping_anchors_are_rejected() -> None:
    with pytest.raises(ValueError, match="once"):
        index_documents(
            [Document("正文"), Document("另一份正文")], published_on=PUBLISHED, source_url=SOURCE
        )
    with pytest.raises(ValueError, match="overlap"):
        index_documents(
            [
                Document(
                    "报名入口。",
                    hyperlinks=(
                        Hyperlink(0, 3, "/a"),
                        Hyperlink(2, 4, "/b"),
                    ),
                )
            ],
            published_on=PUBLISHED,
            source_url=SOURCE,
        )
