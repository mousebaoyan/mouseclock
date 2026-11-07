from datetime import date

import pytest

from crawler.extraction.evaluate_test import selected_extraction
from crawler.extraction.numbered import DateRef, SelectionError, resolve
from crawler.parse.indexing import Document, index_documents


def test_selected_deadline_keeps_minutes_and_evidence_is_original_text() -> None:
    text = "报名截止6月30日24时。"
    index = index_documents([Document(text)], published_on=date(2026, 5, 1))
    prediction = resolve(selected_extraction(), index)
    field = prediction.programs[0].fields.apply
    assert field is not None
    assert field.value.model_dump(mode="json", exclude_none=True) == {
        "end": {"date": "2026-06-30", "time": "24:00"}
    }
    assert [e.quote for e in field.evidence] == [text]


def test_unknown_date_id_and_unavailable_range_end_fail_without_guessing() -> None:
    index = index_documents([Document("6月30日24时截止。")], published_on=date(2026, 5, 1))
    selection = selected_extraction()
    field = selection.programs[0].fields.apply
    assert field is not None
    field.value.end = DateRef(date_id="D999", edge="first")
    with pytest.raises(SelectionError, match="unknown_reference"):
        resolve(selection, index)
    field.value.end = DateRef(date_id="D1", edge="last")
    with pytest.raises(SelectionError, match="unusable_date_reference"):
        resolve(selection, index)


def test_month_range_end_and_email_are_taken_from_index() -> None:
    index = index_documents(
        [Document("7月中下旬举办。发至apply@example.edu.cn。")], published_on=date(2026, 5, 1)
    )
    selection = selected_extraction()
    program = selection.programs[0]
    from crawler.extraction.numbered import SelectedEvent, Selection

    program.fields.apply = None
    program.fields.event = Selection(
        value=SelectedEvent(
            start=DateRef(date_id="D1", edge="first"),
            end=DateRef(date_id="D1", edge="last"),
            mode=None,
            place=None,
        ),
        evidence=["S1"],
        confidence=0.9,
    )
    program.fields.apply_url = Selection(value="E1", evidence=["S2"], confidence=0.9)
    fields = resolve(selection, index).programs[0].fields
    assert fields.event is not None
    assert fields.event.value.model_dump(mode="json", exclude_none=True) == {
        "start": {"month": "2026-07", "part": "mid"},
        "end": {"month": "2026-07", "part": "late"},
    }
    assert fields.apply_url is not None
    assert fields.apply_url.value == "mailto:apply@example.edu.cn"
