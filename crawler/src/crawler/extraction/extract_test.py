import asyncio
import json
from datetime import date

import httpx
import pytest

from crawler.crawl.contract import AttachmentInfo, ExtractionContext
from crawler.crawl.rounds import Attachment, NoticePage, StepError
from crawler.extraction.extract import (
    Extract,
    RoundSelection,
    prepare,
    resolve_programs,
)
from crawler.extraction.numbered import SelectedFields, SelectionError
from crawler.extraction.responses import Responses


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
        shared = json.loads(payload["input"][0]["content"])
        notice = json.loads(payload["input"][1]["content"])
        assert shared["programs"][0]["id"] == 100
        assert notice["title"] == "夏令营延期"
        assert "published_on" not in shared
        return httpx.Response(
            200,
            json={
                "model": "deepseek-flash",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": json.dumps({"programs": [selection()]})}
                        ],
                    }
                ],
                "usage": {"input_tokens": 200, "output_tokens": 50},
            },
        )

    async def run() -> None:
        async with Responses("local-test", httpx.MockTransport(handle)) as llm:
            extract = Extract(llm)
            programs, usage = await extract("夏令营延期", page, context())
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


@pytest.mark.parametrize(
    ("key", "value"), [("college_id", 99), ("program_id", 99), ("cohort", 2028)]
)
def test_unknown_ids_and_mismatched_existing_project_are_rejected(key: str, value: int) -> None:
    item = selection()
    item[key] = value
    _, index = prepare(
        "通知", NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[]), context()
    )
    with pytest.raises(SelectionError):
        resolve_programs(RoundSelection.model_validate({"programs": [item]}), index, context())


def test_unparsed_attachment_date_keeps_raw_evidence_and_has_no_invented_value() -> None:
    text = "报名截止为下周二17点。"
    attachment = Attachment(
        AttachmentInfo(
            name="安排.txt", url="https://example.edu/1.txt", content_type="text/plain", text=text
        ),
        b"",
        [],
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
        "通知", NoticePage("", "报名截止6月30日24点。", hyperlinks=(), attachments=[]), context()
    )
    for raw in [
        {"field": "apply.end", "text": "6月30日24点", "evidence": ["S1"]},
        {"field": "event.start", "text": "不存在的日期", "evidence": ["S1"]},
    ]:
        item = selection()
        item["unresolved_dates"] = [raw]
        with pytest.raises(SelectionError):
            resolve_programs(RoundSelection.model_validate({"programs": [item]}), index, context())


def answer(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": "deepseek-flash",
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
            "usage": {"input_tokens": 100, "output_tokens": 10},
        },
    )


# The code is what the dashboard shows for the notice, so it says what the model got wrong.
@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("{}", "invalid_selection"),
        (json.dumps({"programs": [selection() | {"college_id": 99}]}), "unknown_college"),
    ],
)
def test_invalid_selection_fails_the_entire_step(text: str, code: str) -> None:
    async def run() -> None:
        async with Responses("local-test", httpx.MockTransport(lambda _: answer(text))) as llm:
            extract = Extract(llm)
            with pytest.raises(StepError, match=f"抽取失败: {code}"):
                await extract(
                    "通知",
                    NoticePage("", "报名截止6月30日。", hyperlinks=(), attachments=[]),
                    context(),
                )

    asyncio.run(run())


def test_missing_usage_is_not_reported_as_a_free_success() -> None:
    async def run() -> None:
        llm = Responses(
            "local-test",
            httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    json={
                        "model": "deepseek-flash",
                        "status": "completed",
                        "output": [
                            {
                                "type": "message",
                                "content": [{"type": "output_text", "text": '{"programs":[]}'}],
                            }
                        ],
                    },
                )
            ),
        )
        async with llm:
            extract = Extract(llm)
            with pytest.raises(StepError, match="missing_usage"):
                await extract(
                    "通知", NoticePage("", "无关材料。", hyperlinks=(), attachments=[]), context()
                )

    asyncio.run(run())
