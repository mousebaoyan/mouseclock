import asyncio
import io
import json
from collections.abc import Callable

import httpx
import pytest
from PIL import Image

from crawler.crawl.contract import (
    AttachmentInfo,
    ExtractedFields,
    ExtractedProgram,
    ExtractionContext,
    Usage,
)
from crawler.crawl.rounds import Attachment, NoticePage
from crawler.extraction.chat import SECOND_MODEL, Chat
from crawler.extraction.chat_test import completion
from crawler.extraction.check import Check
from crawler.extraction.numbered import SelectedFields

type Answer = Callable[[str, dict[str, object]], str]


def context(*programs: dict[str, object]) -> ExtractionContext:
    return ExtractionContext.model_validate(
        {
            "published_on": "2026-06-01",
            "colleges": [{"id": 12, "name": "计算机学院"}],
            "programs": [
                {
                    "college_id": 12,
                    "cohort": 2027,
                    "kind": "summer_camp",
                    "name": "夏令营",
                    "apply": None,
                }
                | p
                for p in programs
            ],
        }
    )


def program(**changes: object) -> ExtractedProgram:
    return ExtractedProgram.model_validate(
        {
            "program_id": 100,
            "college_id": 12,
            "cohort": 2027,
            "kind": "summer_camp",
            "name": "夏令营",
            "role": "update",
            "fields": {},
        }
        | changes
    )


def marks(checked: ExtractedProgram) -> dict[str, bool | None]:
    """Which fields the check bore out."""
    return {name: entry.checked for name, entry in checked.fields if entry is not None}


def png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (40, 20), "white").save(buffer, "PNG")
    return buffer.getvalue()


def run_check(
    answer: Answer, page: NoticePage, ctx: ExtractionContext, programs: list[ExtractedProgram]
) -> tuple[list[ExtractedProgram], list[str]]:
    """The checked programs, and what each call was: the model and what it was asked."""
    calls: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        format_ = payload.get("response_format")
        asked = format_["json_schema"]["name"] if format_ else "picture"
        calls.append(f"{payload['model']} {asked}")
        return httpx.Response(200, json=completion(answer(asked, payload)))

    async def run() -> list[ExtractedProgram]:
        transport = httpx.MockTransport(handle)
        async with (
            Chat("local-test", transport) as first,
            Chat("local-test", transport, model=SECOND_MODEL) as second,
        ):
            usage: list[Usage] = []
            checked = await Check(first, second)("夏令营通知", page, ctx, programs, usage)
            assert len(usage) == len(calls)
            return checked

    return asyncio.run(run()), calls


def test_a_value_read_from_a_picture_is_borne_out_when_a_second_reading_has_it_too() -> None:
    poster = Attachment(
        AttachmentInfo(
            name="海报.png",
            url="http://a/p.png",
            content_type="image/png",
            text="报名截止 6月30日17:00\n名额20人",
            read_from_pictures=True,
        ),
        png(),
    )
    page = NoticePage("", "详见海报。", hyperlinks=(), attachments=[poster])
    fields = ExtractedFields.model_validate(
        {
            "apply": {
                "value": {"end": {"date": "2026-06-30", "time": "17:00"}},
                "evidence": [{"quote": "报名截止 6月30日17:00", "attachment": 0}],
                "confidence": 0.9,
            },
            # Misread one way or the other: the readings disagree on the number.
            "quota": {
                "value": "20 人",
                "evidence": [{"quote": "名额20人", "attachment": 0}],
                "confidence": 0.9,
            },
            "majors": {
                "value": ["软件工程"],
                "evidence": [{"quote": "详见海报。"}],
                "confidence": 0.9,
            },
        }
    )

    [checked], calls = run_check(
        lambda _asked, _payload: "报名截止 6 月 30 日 17:00\n名额28人",
        page,
        context({"id": 100}),
        [program(fields=fields)],
    )

    assert calls == [f"{SECOND_MODEL} picture"]
    # Quoted from the words of the page, the majors had nothing to check.
    assert marks(checked) == {"apply": True, "quota": None, "majors": None}


def selection(fields: dict[str, object]) -> str:
    selected = dict.fromkeys(SelectedFields.model_fields) | fields
    return json.dumps(
        {
            "programs": [
                {
                    "college_id": 12,
                    "program_id": 100,
                    "cohort": 2027,
                    "kind": "summer_camp",
                    "name": "夏令营",
                    "role": "call",
                    "fields": selected,
                    "unresolved_dates": [],
                }
            ]
        }
    )


def test_an_unsure_value_and_a_missing_deadline_are_borne_out_by_a_second_extraction() -> None:
    page = NoticePage("", "招收硕士研究生。专业为计算机科学与技术。", hyperlinks=(), attachments=[])
    fields = ExtractedFields.model_validate(
        {
            "degrees": {
                "value": ["master"],
                "evidence": [{"quote": "招收硕士研究生。"}],
                "confidence": 0.5,
            },
            "majors": {
                "value": ["软件工程"],
                "evidence": [{"quote": "专业为计算机科学与技术。"}],
                "confidence": 0.5,
            },
        }
    )
    second = selection(
        {
            "degrees": {"value": ["master"], "evidence": ["S1"], "confidence": 0.9},
            "majors": {"value": ["计算机科学与技术"], "evidence": ["S2"], "confidence": 0.9},
        }
    )

    [checked], calls = run_check(
        lambda _asked, _payload: second,
        page,
        context({"id": 100}),
        [program(role="call", fields=fields)],
    )

    assert calls == [f"{SECOND_MODEL} notice_extraction"]
    assert marks(checked) == {"degrees": True, "majors": None}
    assert checked.checked == ["no_deadline"]


def test_a_missing_deadline_the_second_extraction_finds_is_left_for_review() -> None:
    page = NoticePage("", "报名截止6月30日。", hyperlinks=(), attachments=[])
    second = selection(
        {
            "apply": {
                "value": {
                    "start": None,
                    "end": {"date_id": "D1", "edge": "first"},
                    "rolling": None,
                },
                "evidence": ["S1"],
                "confidence": 0.9,
            }
        }
    )

    [checked], _ = run_check(
        lambda _asked, _payload: second, page, context({"id": 100}), [program(role="call")]
    )

    assert checked.checked is None


@pytest.mark.parametrize(
    ("answers", "program_id", "marks"),
    [
        ({"ecnu-max": ("different", None), SECOND_MODEL: ("different", None)}, None, ["new"]),
        ({"ecnu-max": ("same", 101), SECOND_MODEL: ("same", 101)}, 101, None),
        ({"ecnu-max": ("same", 101), SECOND_MODEL: ("unsure", None)}, None, None),
        ({"ecnu-max": ("same", 101), SECOND_MODEL: ("same", 100)}, None, None),
    ],
)
def test_a_new_program_is_taken_as_one_the_school_has_only_when_both_models_say_so(
    answers: dict[str, tuple[str, int | None]], program_id: int | None, marks: list[str] | None
) -> None:
    page = NoticePage("", "夏令营入营名单。", hyperlinks=(), attachments=[])

    def answer(_asked: str, payload: dict[str, object]) -> str:
        verdict, same_as = answers[str(payload["model"])]
        return json.dumps({"answer": verdict, "same_as": same_as, "reason": "名称一致"})

    [checked], calls = run_check(
        answer,
        page,
        context({"id": 100}, {"id": 101, "name": "夏令营报名"}),
        [program(program_id=None)],
    )

    assert calls == ["ecnu-max same_program", f"{SECOND_MODEL} same_program"]
    assert (checked.program_id, checked.checked) == (program_id, marks)


def test_two_programs_of_a_notice_taken_for_one_stay_as_extracted() -> None:
    page = NoticePage("", "两批夏令营入营名单。", hyperlinks=(), attachments=[])
    same = json.dumps({"answer": "same", "same_as": 101, "reason": "名称一致"})
    programs = [program(program_id=None, role="result", name=n) for n in ("第一批", "第二批")]

    checked, _ = run_check(
        lambda _asked, _payload: same, page, context({"id": 101, "name": "夏令营报名"}), programs
    )

    assert [p.program_id for p in checked] == [None, None]


@pytest.mark.parametrize(
    ("role", "deadline", "verdict", "program_id", "marks"),
    [
        # A list belongs to some call, so both models missing which is no reason to take it as new.
        ("result", None, "different", None, None),
        # A call with the deadline of one the school has is likely that one.
        ("call", "2026-06-10", "different", None, None),
        ("call", "2026-06-20", "different", None, ["new"]),
        # A call with another deadline is another call.
        ("call", "2026-06-20", "same", None, None),
        ("call", "2026-06-10", "same", 101, None),
    ],
)
def test_the_models_are_not_taken_at_their_word_against_the_deadlines(
    role: str, deadline: str, verdict: str, program_id: int | None, marks: list[str] | None
) -> None:
    page = NoticePage("", "夏令营报名通知。", hyperlinks=(), attachments=[])
    apply = {
        "value": {"end": {"date": deadline}},
        "evidence": [{"quote": "夏令营报名通知。"}],
        "confidence": 0.9,
    }
    answer = json.dumps(
        {"answer": verdict, "same_as": 101 if verdict == "same" else None, "reason": "名称一致"}
    )
    known: dict[str, object] = {
        "id": 101,
        "name": "夏令营",
        "apply": {"end": {"date": "2026-06-10"}},
    }

    [checked], _ = run_check(
        lambda _asked, _payload: answer,
        page,
        context(known),
        [program(program_id=None, role=role, fields={"apply": apply} if deadline else {})],
    )

    assert (checked.program_id, checked.checked) == (program_id, marks)


def test_when_the_second_model_fails_everything_waits_for_review_as_it_would() -> None:
    page = NoticePage("", "招收硕士研究生。", hyperlinks=(), attachments=[])
    fields = ExtractedFields.model_validate(
        {
            "degrees": {
                "value": ["master"],
                "evidence": [{"quote": "招收硕士研究生。"}],
                "confidence": 0.5,
            }
        }
    )

    [checked], calls = run_check(
        lambda _asked, _payload: "不是 JSON",
        page,
        context({"id": 100}),
        [program(role="call", fields=fields)],
    )

    assert calls == [f"{SECOND_MODEL} notice_extraction"]
    assert checked == program(role="call", fields=fields)
