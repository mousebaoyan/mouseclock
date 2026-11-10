from datetime import date

import pytest

from crawler.crawl.contract import TimeToDay, TimeToMinute, TimeToMonth, TimeValue
from crawler.parse.dates import find_dates


@pytest.mark.parametrize(
    ("text", "days"),
    [
        ("报名截止6月14日2.提交材料", [14]),
        ("6月1日7月2日", [1, 2]),
    ],
)
def test_dates_can_be_followed_immediately_by_numbers(text: str, days: list[int]) -> None:
    found = find_dates(text, date(2027, 5, 1))
    assert [item.value.date.day for item in found if isinstance(item.value, TimeToDay)] == days
    assert all(item.issue is None for item in found)
    assert all(text[item.start : item.end] == item.text for item in found)


@pytest.mark.parametrize(
    "text",
    [
        "6月1日-6月31号",
        "6月1日8:00-17:0",
        "6月1日8:00至17:001",
        "6月1日-6月14日17:0",
        "6月14日17:001",
        "6月1日到31号",
        "6月1日—31号",
        "6月1日\uff5e31号",
        "六月一日至零日",
        "六月一日至一百日",
        "六月一日至一百号",
        "2027-06-01至6/30",
        "2027-06-01至06-14",
        "2027-06-30-07-01",
        "2027-06-01至6.30元",
        "2027-06-01至6/30分",
        "6月1日至6.30",
    ],
)
def test_unrecognized_numeric_range_end_cannot_leave_a_valid_start(text: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.issue == "invalid_date"
    assert found.value is None
    assert found.end_value is None


def test_dash_before_prose_still_allows_an_ordinary_date() -> None:
    [found] = find_dates("6月14日——截止", date(2027, 5, 1))
    assert found.value == TimeToDay(date=date(2027, 6, 14))
    assert found.issue is None


def test_chinese_floor_after_a_date_is_not_an_invalid_range_endpoint() -> None:
    [found] = find_dates("六月一日至一楼报到", date(2027, 5, 1))
    assert found.text == "六月一日"
    assert found.value == TimeToDay(date=date(2027, 6, 1))
    assert found.issue is None


def test_mid_to_late_month_does_not_replace_an_explicit_range_end() -> None:
    [found] = find_dates("7月中下旬至8月上旬", date(2027, 5, 1))
    assert found.text == "7月中下旬至8月上旬"
    assert found.value == TimeToMonth(month="2027-07", part="mid")
    assert found.end_value == TimeToMonth(month="2027-08", part="early")
    assert found.issue is None


@pytest.mark.parametrize("text", ["6月14日星期五17:00前", "6月14日 周五 17:00"])
def test_unparenthesized_weekday_keeps_the_clock(text: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == text
    assert found.value == TimeToMinute(date=date(2027, 6, 14), time="17:00")
    assert found.issue is None


@pytest.mark.parametrize(
    ("text", "start", "end"),
    [
        ("6月1日下午2点至5点", "14:00", "17:00"),
        ("6月1日晚上7点至9点", "19:00", "21:00"),
        ("6月1日8:00至17:00之前", "08:00", "17:00"),
    ],
)
def test_clock_range_inherits_period_only_when_omitted(text: str, start: str, end: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == text
    assert found.value == TimeToMinute(date=date(2027, 6, 1), time=start)
    assert found.end_value == TimeToMinute(date=date(2027, 6, 1), time=end)
    assert found.issue is None


def test_explicit_next_day_does_not_inherit_the_previous_afternoon() -> None:
    [found] = find_dates("6月1日下午2点至6月2日5点", date(2027, 5, 1))
    assert found.value == TimeToMinute(date=date(2027, 6, 1), time="14:00")
    assert found.end_value == TimeToMinute(date=date(2027, 6, 2), time="05:00")
    assert found.issue is None


def test_additional_notice_expressions_keep_all_time_information() -> None:
    publication = date(2027, 5, 1)
    [deadline] = find_dates("6月28日止\uff0817时\uff09", publication)
    assert deadline.value == TimeToMinute(date=date(2027, 6, 28), time="17:00")
    [before] = find_dates("7月4日之前", publication)
    assert before.value == TimeToDay(date=date(2027, 7, 4), mark="before")
    [period] = find_dates("7月中下旬", publication)
    assert period.value == TimeToMonth(month="2027-07", part="mid")
    assert period.end_value == TimeToMonth(month="2027-07", part="late")


@pytest.mark.parametrize(
    ("gap", "clock", "expected"),
    [
        ("中午", "12\uff1a00", "12:00"),
        ("上午", "9点", "09:00"),
        ("上午", "10:30", "10:30"),
        ("中午", "12时30分", "12:30"),
        ("下午", "2:30", "14:30"),
        ("下午", "12点", "12:00"),
        ("晚上", "8点", "20:00"),
        ("晚上", "11:30", "23:30"),
        ("\uff08周五\uff09", "17:00", "17:00"),
        ("\uff08星期五\uff09下午", "2点", "14:00"),
        ("(星期五)", "17:00", "17:00"),
        ("下午\uff08周五\uff09", "3点", "15:00"),
    ],
)
def test_clock_after_period_or_weekday_preserves_minute_precision(
    gap: str, clock: str, expected: str
) -> None:
    text = f"8月10日{gap}{clock}前"
    [found] = find_dates(text, date(2027, 7, 1))
    assert found.text == text
    assert found.issue is None
    assert found.value == TimeToMinute(date=date(2027, 8, 10), time=expected)


@pytest.mark.parametrize(
    ("text", "start_day", "end_day", "start_time", "end_time"),
    [
        ("9月19\u201320日", 19, 20, None, None),
        ("9月19-20日", 19, 20, None, None),
        ("9月19日8:00-17:00", 19, 19, "08:00", "17:00"),
        ("9月19日上午9:30至下午5点", 19, 19, "09:30", "17:00"),
    ],
)
def test_abbreviated_day_and_same_day_clock_ranges(
    text: str, start_day: int, end_day: int, start_time: str | None, end_time: str | None
) -> None:
    [found] = find_dates(text, date(2027, 8, 1))
    assert found.text == text
    assert found.issue is None
    assert found.value == (
        TimeToMinute(date=date(2027, 9, start_day), time=start_time)
        if start_time
        else TimeToDay(date=date(2027, 9, start_day))
    )
    assert found.end_value == (
        TimeToMinute(date=date(2027, 9, end_day), time=end_time)
        if end_time
        else TimeToDay(date=date(2027, 9, end_day))
    )


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
        "9月19日17:00-08:00",
        "9月19日8:00-24:01",
        "6月1日下午2点至上午5点",
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


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("2027-06-30", TimeToDay(date=date(2027, 6, 30))),
        ("2027/6/30", TimeToDay(date=date(2027, 6, 30))),
        ("2027.6.30", TimeToDay(date=date(2027, 6, 30))),
        ("2027 / 6 / 30 17:00", TimeToMinute(date=date(2027, 6, 30), time="17:00")),
        ("2027-06-30下午5点前", TimeToMinute(date=date(2027, 6, 30), time="17:00")),
        ("6月30号", TimeToDay(date=date(2027, 6, 30))),
        ("6月30号24时", TimeToMinute(date=date(2027, 6, 30), time="24:00")),
        ("二\u3007二七年八月五日", TimeToDay(date=date(2027, 8, 5))),
        ("二零二七年十二月三十一号", TimeToDay(date=date(2027, 12, 31))),
        ("二\u3007二八年二月二十九日", TimeToDay(date=date(2028, 2, 29))),
        ("八月上旬", TimeToMonth(month="2027-08", part="early")),
        ("九月中旬", TimeToMonth(month="2027-09", part="mid")),
        ("十一月底", TimeToMonth(month="2027-11", part="late")),
    ],
)
def test_additional_date_spellings_preserve_source_and_precision(
    expression: str, expected: TimeValue
) -> None:
    text = f"报名时间为{expression}\uff0c请及时提交。"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.value == expected
    assert found.end_value is None
    assert found.issue is None
    assert found.text == expression
    assert text[found.start : found.end] == expression


@pytest.mark.parametrize(
    "text",
    [
        "6.30",
        "报名截止为6.30",
        "申请截止日期\uff1a6/30",
        "请于6-30前报名",
        "6.30日提交材料",
        "6/30号报名",
        "报名截止6.30 17:00",
        "6.30开始报名",
        "6.30截止。",
        "\uff086.30\uff0917:00报到",
        "(6/30)17:00报到",
        "报名时间6.1至6.30",
        "6/1至6/30号",
        "6.30日8:00-17:00",
        "上午8.30开始报名",
    ],
)
def test_short_numeric_dates_are_not_recognized_from_context(text: str) -> None:
    assert find_dates(text, date(2027, 5, 1)) == []


@pytest.mark.parametrize(
    "text",
    [
        "Python 3.14",
        "版本2027.6.30",
        "版本号\uff1a2027-06-30",
        "version 2027/6/30",
        "V 2027.6.30",
        "版本(2027.6.30)17:00发布",
        "版本( 2027.6.30 )17:00发布",
        "版本\uff082027.6.30\uff09发布",
        "版本2027 / 6 / 30报名",
        "版本2027 - 6 - 30截止支持",
        "版本2027. 6. 30截止支持",
        "v1.2027.6.30",
        "v1-2027-6-30",
        "v1. 2027. 6. 30",
        "v1 - 2027 - 6 - 30",
        "v1 / 2027 / 6 / 30",
        "一二三月",
        "一二六月一日",
    ],
)
def test_unrelated_numeric_expressions_are_not_promoted_to_dates(text: str) -> None:
    assert find_dates(text, date(2027, 5, 1)) == []


@pytest.mark.parametrize("prefix", ["1.", "2. ", "3.\t"])
def test_numbered_list_items_do_not_hide_a_chinese_date(prefix: str) -> None:
    text = prefix + "7月1日00:00至7月7日24:00报名。"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == "7月1日00:00至7月7日24:00"
    assert found.value == TimeToMinute(date=date(2027, 7, 1), time="00:00")
    assert found.end_value == TimeToMinute(date=date(2027, 7, 7), time="24:00")


@pytest.mark.parametrize(
    ("text", "start", "end"),
    [
        ("6月1日-6月14号", date(2027, 6, 1), date(2027, 6, 14)),
        ("6月1号到14号", date(2027, 6, 1), date(2027, 6, 14)),
        ("2027-06-01-2027-06-14", date(2027, 6, 1), date(2027, 6, 14)),
        ("2027/6/1至6月14号", date(2027, 6, 1), date(2027, 6, 14)),
        ("二\u3007二七年十二月二十八日至一月十日", date(2027, 12, 28), date(2028, 1, 10)),
        ("六月一至三十号", date(2027, 6, 1), date(2027, 6, 30)),
        ("二\u3007二七年六月一至三十日", date(2027, 6, 1), date(2027, 6, 30)),
        ("十二月二十八至一月十日", date(2027, 12, 28), date(2028, 1, 10)),
        ("6月一至三十日", date(2027, 6, 1), date(2027, 6, 30)),
    ],
)
def test_added_date_formats_share_range_and_year_rules(text: str, start: date, end: date) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.value == TimeToDay(date=start)
    assert found.end_value == TimeToDay(date=end)
    assert found.issue is None


@pytest.mark.parametrize(
    ("text", "expected_day", "expected_time"),
    [
        ("2027-6-1 17:00", 1, "17:00"),
        ("2027 / 6 / 1\t08:30", 1, "08:30"),
        ("2027.6.9 17点30分", 9, "17:30"),
        ("(2027/6/1)17:00", 1, "17:00"),
    ],
)
def test_numeric_day_does_not_absorb_the_first_clock_digit(
    text: str, expected_day: int, expected_time: str
) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.value == TimeToMinute(date=date(2027, 6, expected_day), time=expected_time)
    assert found.issue is None
    assert text[found.start : found.end] == found.text


@pytest.mark.parametrize(
    "text",
    [
        "2027-6-1 08:30至2027-6-9 17:00",
        "(2027/6/1)08:30至(2027/6/9)17:00",
    ],
)
def test_numeric_range_endpoints_preserve_the_clock_boundary(text: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.value == TimeToMinute(date=date(2027, 6, 1), time="08:30")
    assert found.end_value == TimeToMinute(date=date(2027, 6, 9), time="17:00")
    assert found.issue is None


@pytest.mark.parametrize("text", ["六月三十号", "八月上旬"])
def test_new_yearless_formats_still_require_publication(text: str) -> None:
    [found] = find_dates(text, None)
    assert found.issue == "missing_publication"
    assert found.value is None
    assert found.end_value is None


@pytest.mark.parametrize("text", ["2027-06-30", "2027/6/30", "2027.6.30"])
def test_complete_numeric_dates_do_not_require_publication(text: str) -> None:
    [found] = find_dates(text, None)
    assert found.value == TimeToDay(date=date(2027, 6, 30))
    assert found.issue is None


@pytest.mark.parametrize(
    "text",
    [
        "2027-02-29",
        "2027/6/31",
        "二\u3007二七年二月二十九日",
        "6月31号",
        "2027-06-30至2027-06-01",
        "2027-06-30 24:01",
        "2027/6-30",
    ],
)
def test_new_formats_preserve_invalid_date_and_range_failure(text: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.issue == "invalid_date"
    assert found.value is None
    assert found.end_value is None


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("\uff086月20日\uff0900:00", TimeToMinute(date=date(2027, 6, 20), time="00:00")),
        ("(6月20日)08:30", TimeToMinute(date=date(2027, 6, 20), time="08:30")),
        (
            "\uff08二\u3007二七年六月二十日\uff09下午2点前",
            TimeToMinute(date=date(2027, 6, 20), time="14:00"),
        ),
        ("(2027/6/20) 24时", TimeToMinute(date=date(2027, 6, 20), time="24:00")),
        ("( 2027/6/20 ) 24时", TimeToMinute(date=date(2027, 6, 20), time="24:00")),
    ],
)
def test_parenthesized_dates_keep_a_clock_directly_after_the_closing_parenthesis(
    expression: str, expected: TimeToMinute
) -> None:
    text = f"报到安排为{expression}\uff0c请提前准备。"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == expression
    assert text[found.start : found.end] == expression
    assert found.value == expected
    assert found.issue is None


@pytest.mark.parametrize(
    "text",
    [
        "\uff086月20日\uff09\n08:30报到",
        "6月20日\uff08注意事项\uff0908:30报到",
        "\uff08见6月20日\uff0908:30报到",
    ],
)
def test_clocks_are_not_joined_across_prose_or_line_breaks(text: str) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == "6月20日"
    assert found.value == TimeToDay(date=date(2027, 6, 20))


@pytest.mark.parametrize("weekday", ["周一", "星期一", "星期六"])
@pytest.mark.parametrize("expression", ["6月1日17:00", "六月一日17:00"])
def test_a_weekday_immediately_before_a_date_does_not_hide_it(
    weekday: str, expression: str
) -> None:
    text = f"{weekday}{expression}截止"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == expression
    assert found.value == TimeToMinute(date=date(2027, 6, 1), time="17:00")


@pytest.mark.parametrize("expression", ["2027-06-30", "2027/6/30", "2027.6.30"])
@pytest.mark.parametrize("prefix", ["1.", "1. ", "1.\t", "1 . "])
def test_numbered_lists_can_start_with_a_complete_numeric_date(
    expression: str, prefix: str
) -> None:
    text = f"{prefix}{expression}截止"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == expression
    assert text[found.start : found.end] == expression
    assert found.value == TimeToDay(date=date(2027, 6, 30))


@pytest.mark.parametrize("boundary", ["。", "\uff01", "?", ";", "\r", "\r\n"])
@pytest.mark.parametrize("expression", ["2027-6-30", "2027/6/30"])
def test_numbered_dates_after_sentence_boundaries(boundary: str, expression: str) -> None:
    text = f"说明{boundary}1. {expression}报名"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == expression
    assert found.value == TimeToDay(date=date(2027, 6, 30))
    assert found.issue is None


def test_a_version_label_on_the_previous_line_does_not_hide_a_date() -> None:
    expression = "2027.6.30"
    text = f"版本\n{expression}截止"
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == expression
    assert found.value == TimeToDay(date=date(2027, 6, 30))


@pytest.mark.parametrize(
    ("text", "expression", "expected"),
    [
        ("6.30至7月1日截止", "7月1日", TimeToDay(date=date(2027, 7, 1))),
        ("版本6.30-7月1日发布", "7月1日", TimeToDay(date=date(2027, 7, 1))),
        ("版本2027.6.30-7月1日发布", "7月1日", TimeToDay(date=date(2027, 7, 1))),
        ("版本2027 / 6 / 30-7月1日发布", "7月1日", TimeToDay(date=date(2027, 7, 1))),
        ("版本6.30至七月上旬更新", "七月上旬", TimeToMonth(month="2027-07", part="early")),
    ],
)
def test_rejected_numeric_candidates_do_not_hide_a_later_date(
    text: str, expression: str, expected: TimeValue
) -> None:
    [found] = find_dates(text, date(2027, 5, 1))
    assert found.text == expression
    assert text[found.start : found.end] == expression
    assert found.value == expected
    assert found.issue is None
