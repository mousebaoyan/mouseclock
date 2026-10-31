from datetime import date

import pytest

from crawler.crawl.contract import TimeToDay, TimeToMinute, TimeToMonth, TimeValue
from crawler.parse.dates import find_dates


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2027年6月1日", TimeToDay(date=date(2027, 6, 1))),
        ("6月1日", TimeToDay(date=date(2027, 6, 1))),
        ("6月1日8:00", TimeToMinute(date=date(2027, 6, 1), time="08:00")),
        ("6 月 1 日 8\uff1a00", TimeToMinute(date=date(2027, 6, 1), time="08:00")),
        ("6月1日8时30分", TimeToMinute(date=date(2027, 6, 1), time="08:30")),
        ("6月30日24时", TimeToMinute(date=date(2027, 6, 30), time="24:00")),
        ("6月30日24点", TimeToMinute(date=date(2027, 6, 30), time="24:00")),
        ("6月30日23:59", TimeToMinute(date=date(2027, 6, 30), time="23:59")),
        ("6月22日前", TimeToDay(date=date(2027, 6, 22), mark="before")),
        ("7月3日前后", TimeToDay(date=date(2027, 7, 3), mark="about")),
        ("7月3日左右", TimeToDay(date=date(2027, 7, 3), mark="about")),
        ("7月上旬", TimeToMonth(month="2027-07", part="early")),
        ("7月中旬", TimeToMonth(month="2027-07", part="mid")),
        ("7月下旬", TimeToMonth(month="2027-07", part="late")),
        ("7月初", TimeToMonth(month="2027-07", part="early")),
        ("7月底", TimeToMonth(month="2027-07", part="late")),
        ("7月", TimeToMonth(month="2027-07")),
        ("即日起", TimeToDay(date=date(2027, 5, 20))),
    ],
)
def test_date_precision_and_exact_source(text: str, expected: TimeValue) -> None:
    source = f"请于{text}报名。"
    [found] = find_dates(source, date(2027, 5, 20))
    assert found.value == expected
    assert found.end_value is None
    assert found.issue is None
    assert found.text == text
    assert source[found.start : found.end] == text


@pytest.mark.parametrize(
    ("text", "published_on", "start", "end"),
    [
        (
            "6月1日至14日",
            date(2027, 5, 1),
            TimeToDay(date=date(2027, 6, 1)),
            TimeToDay(date=date(2027, 6, 14)),
        ),
        (
            "6月1日—6月14日",
            date(2027, 5, 1),
            TimeToDay(date=date(2027, 6, 1)),
            TimeToDay(date=date(2027, 6, 14)),
        ),
        (
            "2027年12月28日至1月10日",
            None,
            TimeToDay(date=date(2027, 12, 28)),
            TimeToDay(date=date(2028, 1, 10)),
        ),
        (
            "即日起至6月18日17:00",
            date(2027, 6, 1),
            TimeToDay(date=date(2027, 6, 1)),
            TimeToMinute(date=date(2027, 6, 18), time="17:00"),
        ),
        (
            "6月30日23:00至7月1日01:00",
            date(2027, 5, 1),
            TimeToMinute(date=date(2027, 6, 30), time="23:00"),
            TimeToMinute(date=date(2027, 7, 1), time="01:00"),
        ),
        (
            "6月30日24时至7月1日01:00",
            date(2027, 5, 1),
            TimeToMinute(date=date(2027, 6, 30), time="24:00"),
            TimeToMinute(date=date(2027, 7, 1), time="01:00"),
        ),
        (
            "1月10日至14日",
            date(2027, 11, 15),
            TimeToDay(date=date(2028, 1, 10)),
            TimeToDay(date=date(2028, 1, 14)),
        ),
        (
            "2月28日至29日",
            date(2027, 12, 1),
            TimeToDay(date=date(2028, 2, 28)),
            TimeToDay(date=date(2028, 2, 29)),
        ),
    ],
)
def test_ranges_inherit_only_within_the_expression(
    text: str, published_on: date | None, start: TimeValue, end: TimeValue
) -> None:
    [found] = find_dates(text, published_on)
    assert found.text == text
    assert found.value == start
    assert found.end_value == end
    assert found.issue is None


def test_year_inference_does_not_roll_every_past_date_forward() -> None:
    [january] = find_dates("1月10日截止", date(2027, 12, 20))
    assert january.value == TimeToDay(date=date(2028, 1, 10))
    [past] = find_dates("5月10日已开始报名", date(2027, 6, 1))
    assert past.value == TimeToDay(date=date(2027, 5, 10))
    [explicit] = find_dates("2027年1月10日", date(2027, 12, 20))
    assert explicit.value == TimeToDay(date=date(2027, 1, 10))


@pytest.mark.parametrize(
    ("text", "published_on", "expected"),
    [
        ("1月10日", date(2027, 11, 15), date(2028, 1, 10)),
        ("5月31日", date(2027, 12, 1), date(2028, 5, 31)),
        ("6月1日", date(2027, 12, 1), date(2027, 6, 1)),
        ("6月2日", date(2027, 12, 1), date(2027, 6, 2)),
        ("7月1日", date(2027, 12, 1), date(2027, 7, 1)),
        ("6月30日", date(2027, 12, 31), date(2027, 6, 30)),
        ("6月29日", date(2027, 12, 31), date(2028, 6, 29)),
        ("2月28日", date(2027, 8, 31), date(2027, 2, 28)),
        ("2月27日", date(2027, 8, 31), date(2028, 2, 27)),
        ("2月29日", date(2027, 12, 1), date(2028, 2, 29)),
        ("2027年1月10日", date(2027, 12, 20), date(2027, 1, 10)),
    ],
)
def test_year_inference_uses_a_strict_six_calendar_month_threshold(
    text: str, published_on: date, expected: date
) -> None:
    [found] = find_dates(text, published_on)
    assert found.value == TimeToDay(date=expected)
    assert found.issue is None
    assert found.text == text


@pytest.mark.parametrize("text", ["2027年12月28日至7月10日", "2月29日"])
def test_inference_does_not_repair_a_reversed_range_or_an_invalid_inferred_year(text: str) -> None:
    [found] = find_dates(text, date(2028, 12, 1))
    assert found.issue == "invalid_date"
    assert found.value is None
    assert found.end_value is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("6月", TimeToMonth(month="2028-06")),
        ("6月中旬", TimeToMonth(month="2028-06", part="mid")),
        ("6月下旬", TimeToMonth(month="2027-06", part="late")),
        ("7月", TimeToMonth(month="2027-07")),
    ],
)
def test_month_precision_uses_its_first_possible_day_only_for_year_inference(
    text: str, expected: TimeToMonth
) -> None:
    [found] = find_dates(text, date(2027, 12, 15))
    assert found.value == expected
    assert found.issue is None


@pytest.mark.parametrize("text", ["6月1日", "即日起", "7月上旬", "6月1日至14日"])
def test_missing_publication_retains_the_expression_without_guessing(text: str) -> None:
    [found] = find_dates(text, None)
    assert found.text == text
    assert found.issue == "missing_publication"
    assert found.value is None
    assert found.end_value is None


@pytest.mark.parametrize(
    "text",
    [
        "2027年2月29日",
        "2027年13月1日",
        "6月31日",
        "6月30日24:01",
        "6月30日25时",
        "6月30日12:60",
        "6月14日至1日",
        "2027年6月1日至2026年6月14日",
    ],
)
def test_invalid_dates_and_reversed_ranges_are_not_silently_repaired(text: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == text
    assert found.issue == "invalid_date"
    assert found.value is None
    assert found.end_value is None


def test_explicit_leap_day_and_unrelated_numbers() -> None:
    [found] = find_dates("2028年2月29日\uff0c名额2028人\uff0c联系电话01012345678。", None)
    assert found.value == TimeToDay(date=date(2028, 2, 29))


def test_a_new_line_does_not_join_separate_dates_into_a_range() -> None:
    found = find_dates("6月1日\n至6月14日", date(2027, 5, 1))
    assert [item.text for item in found] == ["6月1日", "6月14日"]


@pytest.mark.parametrize(
    ("text", "clock"),
    [
        ("8月12日16:00前", "16:00"),
        ("2028年8月12日17点前", "17:00"),
        ("8月12日24时前", "24:00"),
    ],
)
def test_before_a_clock_time_keeps_the_minute_value_and_original_qualifier(
    text: str, clock: str
) -> None:
    [found] = find_dates(text, date(2028, 7, 1))
    assert isinstance(found.value, TimeToMinute)
    assert found.value.date == date(2028, 8, 12)
    assert found.value.time == clock
    assert found.text == text
    assert found.issue is None
