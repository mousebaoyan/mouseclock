import asyncio
import json
from datetime import date

import httpx
import pytest

from crawler.crawl.contract import (
    AttachmentInfo,
    ExtractionContext,
    ProgramCandidate,
    TimeToMinute,
    Usage,
)
from crawler.crawl.rounds import Attachment, NoticePage, StepError
from crawler.extraction.chat import Chat
from crawler.extraction.chat_test import completion
from crawler.extraction.extract import (
    Extract,
    Kind,
    RoundSelection,
    cohort_of,
    prepare,
    resolve_programs,
)
from crawler.extraction.numbered import SelectedFields, SelectionError


def context() -> ExtractionContext:
    return ExtractionContext.model_validate(
        {
            "published_on": "2026-06-01",
            "colleges": [{"id": 12, "name": "计算机学院"}],
            "programs": [
                {
                    "id": 100,
                    "college_id": 12,
                    "cohort": 2027,
                    "kind": "summer_camp",
                    "name": "夏令营",
                    "apply": {"start": {"date": "2026-05-01"}, "end": {"date": "2026-06-10"}},
                }
            ],
        }
    )


def selection() -> dict[str, object]:
    fields = dict.fromkeys(SelectedFields.model_fields)
    fields["apply"] = {
        "value": {"start": None, "end": {"date_id": "D1", "edge": "first"}, "rolling": None},
        "evidence": ["S1"],
        "confidence": 0.95,
    }
    return {
        "college_id": 12,
        "program_id": 100,
        "cohort": 2027,
        "kind": "summer_camp",
        "name": "夏令营",
        "role": "update",
        "fields": fields,
        "unresolved_dates": [],
    }


def test_step_uses_ids_and_only_updates_the_new_deadline() -> None:
    page = NoticePage("", "报名截止延期至6月30日24点。", hyperlinks=(), attachments=[])

    def handle(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        shared = json.loads(payload["messages"][1]["content"])
        notice = json.loads(payload["messages"][2]["content"])
        assert shared["programs"][0]["id"] == 100
        assert notice["title"] == "夏令营延期"
        assert "published_on" not in shared
        return httpx.Response(
            200,
            json=completion(
                json.dumps({"programs": [selection()]}), input_tokens=200, output_tokens=50
            ),
        )

    async def run() -> None:
        async with Chat("local-test", httpx.MockTransport(handle)) as llm:
            extract = Extract(llm)
            usage: list[Usage] = []
            programs = await extract("夏令营延期", page, context(), usage)
        [program] = programs
        assert (program.college_id, program.program_id) == (12, 100)
        assert program.fields.apply is not None
        assert program.fields.apply.value.start is None
        end = program.fields.apply.value.end
        assert end is not None
        assert end.model_dump(exclude_none=True) == {"date": date(2026, 6, 30), "time": "24:00"}
        assert program.fields.apply.evidence[0].quote == page.text
        assert usage[0].input_tokens == 200

    asyncio.run(run())


@pytest.mark.parametrize(("key", "value"), [("college_id", 99), ("program_id", 99)])
def test_unknown_ids_are_rejected(key: str, value: int) -> None:
    item = selection()
    item[key] = value
    _, index = prepare(
        "通知", NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[]), context()
    )
    with pytest.raises(SelectionError):
        resolve_programs(RoundSelection.model_validate({"programs": [item]}), index, context())


def test_the_cohort_comes_from_when_the_notice_came_out_not_from_the_model() -> None:
    # A 「2026 年夏令营」 out in June 2026 is the cohort 2027's.
    item = selection()
    item["cohort"] = 2026
    _, index = prepare(
        "通知", NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[]), context()
    )
    [program] = resolve_programs(
        RoundSelection.model_validate({"programs": [item]}), index, context()
    )
    assert (program.program_id, program.cohort) == (100, 2027)


@pytest.mark.parametrize(
    ("published_on", "kind", "cohort"),
    [
        (date(2026, 6, 1), "summer_camp", 2027),
        (date(2026, 10, 20), "september_round", 2027),
        (date(2026, 11, 20), "winter_camp", 2028),
        (date(2027, 1, 5), "winter_camp", 2028),
    ],
)
def test_winter_camps_from_the_autumn_on_are_the_cohort_after_next(
    published_on: date, kind: Kind, cohort: int
) -> None:
    assert cohort_of(published_on, kind) == cohort


def test_the_model_is_offered_only_the_programs_of_the_notices_cohort() -> None:
    # Last year's program of the same series.
    last_year = {**context().programs[0].model_dump(mode="json"), "id": 99, "cohort": 2026}
    both = context().model_copy(
        update={"programs": [*context().programs, ProgramCandidate.model_validate(last_year)]}
    )
    page = NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[])
    request, index = prepare("通知", page, both)
    messages = json.loads(json.dumps(request["messages"]))
    shared = json.loads(messages[1]["content"])
    assert [p["id"] for p in shared["programs"]] == [100]
    item = selection()
    item["program_id"] = 99
    with pytest.raises(SelectionError, match="unknown_program"):
        resolve_programs(RoundSelection.model_validate({"programs": [item]}), index, both)


def test_an_existing_program_of_another_kind_is_taken_as_a_new_one() -> None:
    item = selection()
    item["kind"] = "pre_recommendation"
    _, index = prepare(
        "通知", NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[]), context()
    )
    [program] = resolve_programs(
        RoundSelection.model_validate({"programs": [item]}), index, context()
    )
    assert (program.program_id, program.kind) == (None, "pre_recommendation")


def test_the_same_existing_project_twice_is_rejected() -> None:
    _, index = prepare(
        "通知", NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[]), context()
    )
    selected = RoundSelection.model_validate({"programs": [selection(), selection()]})
    with pytest.raises(SelectionError, match="duplicate_program"):
        resolve_programs(selected, index, context())


def test_unparsed_attachment_date_keeps_raw_evidence_and_has_no_invented_value() -> None:
    text = "报名截止为下周二17点。"
    attachment = Attachment(
        AttachmentInfo(
            name="安排.txt",
            url="https://example.edu/1.txt",
            content_type="text/plain",
            text=text,
            read_from_pictures=False,
        ),
        b"",
    )
    _, index = prepare(
        "通知", NoticePage("", "见附件。", hyperlinks=(), attachments=[attachment]), context()
    )
    sid = next(s.id for s in index.sentences.values() if s.attachment == 0)
    item = selection()
    fields = dict.fromkeys(SelectedFields.model_fields)
    item["fields"] = fields
    item["unresolved_dates"] = [{"field": "apply.end", "text": "下周二17点", "evidence": [sid]}]
    [program] = resolve_programs(
        RoundSelection.model_validate({"programs": [item]}), index, context()
    )
    assert program.fields.apply is None
    assert program.unresolved_dates is not None
    [raw] = program.unresolved_dates
    assert raw.text == "下周二17点"
    assert raw.evidence[0].attachment == 0
    assert raw.evidence[0].quote == text


def test_raw_date_cannot_be_fabricated_or_replace_a_resolved_time() -> None:
    _, index = prepare(
        "通知",
        NoticePage(
            "", "报名截止6月30日24点。名额满后顺延至下周二。", hyperlinks=(), attachments=[]
        ),
        context(),
    )
    for raw in [
        {"field": "apply.end", "text": "下周二", "evidence": ["S2"]},
        {"field": "event.start", "text": "不存在的日期", "evidence": ["S1"]},
    ]:
        item = selection()
        item["unresolved_dates"] = [raw]
        with pytest.raises(SelectionError):
            resolve_programs(RoundSelection.model_validate({"programs": [item]}), index, context())


def test_a_readable_time_left_unresolved_is_dropped_unless_it_is_a_missing_start_or_end() -> None:
    _, index = prepare(
        "通知",
        NoticePage(
            "", "报名截止6月30日24点。拟录取后7月10日前提交政审表。", hyperlinks=(), attachments=[]
        ),
        context(),
    )
    item = selection()
    item["unresolved_dates"] = [
        # The end it picked, and one of the other times: candidates it could have picked.
        {"field": "apply.end", "text": "6月30日24点", "evidence": ["S1"]},
        {"field": "dates", "text": "7月10日前", "evidence": ["S2"]},
        # A start it gave nothing for is a person's to read.
        {"field": "apply.start", "text": "6月30日24点", "evidence": ["S1"]},
    ]
    [program] = resolve_programs(
        RoundSelection.model_validate({"programs": [item]}), index, context()
    )
    assert program.fields.apply is not None
    assert program.fields.apply.value.end == TimeToMinute(date=date(2026, 6, 30), time="24:00")
    assert [(d.field, d.text) for d in program.unresolved_dates or []] == [
        ("apply.start", "6月30日24点")
    ]


def answer(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json=completion(text),
    )


# The code is what the dashboard shows for the notice, so it says what the model got wrong.
@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("{}", "invalid_selection"),
        (json.dumps({"programs": [selection() | {"college_id": 99}]}), "unknown_college"),
    ],
)
def test_invalid_selection_fails_the_entire_step_and_still_costs(text: str, code: str) -> None:
    usage: list[Usage] = []

    async def run() -> None:
        async with Chat("local-test", httpx.MockTransport(lambda _: answer(text))) as llm:
            extract = Extract(llm)
            with pytest.raises(StepError, match=f"抽取失败: {code}"):
                await extract(
                    "通知",
                    NoticePage("", "报名截止6月30日。", hyperlinks=(), attachments=[]),
                    context(),
                    usage,
                )

    asyncio.run(run())
    assert [u.input_tokens for u in usage] == [100]


def test_missing_usage_is_not_reported_as_a_free_success() -> None:
    async def run() -> None:
        llm = Chat(
            "local-test",
            httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    json=completion('{"programs":[]}', usage=False),
                )
            ),
        )
        async with llm:
            extract = Extract(llm)
            with pytest.raises(StepError, match="missing_usage"):
                await extract(
                    "通知",
                    NoticePage("", "无关材料。", hyperlinks=(), attachments=[]),
                    context(),
                    [],
                )

    asyncio.run(run())
