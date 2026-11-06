"""Chinese date expressions, preserving the precision in design.md §8.2."""

import re
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from crawler.crawl.contract import TimeToDay, TimeToMinute, TimeToMonth, TimeValue

_CLOCK = r"(?:[0-9]{1,2}[:\uff1a][0-9]{2}|[0-9]{1,2}[时点](?:[0-9]{1,2}分?)?)"
_GAP = r"(?:[ \t]*(?:[\uff08(](?:星期|周)[一二三四五六日天][\uff09)]|上午|中午|下午|晚上))*[ \t]*"
# Spaces are allowed between components, but a line break ends an expression.
_DAY = (
    rf"[0-9]{{1,2}}[ \t]*日(?:{_GAP}{_CLOCK}|[ \t]*止[ \t]*[\uff08(]{_CLOCK}[\uff09)])?"
    r"(?:[ \t]*(?:前后|左右|之前|前))?"
)
_MONTH = (
    rf"(?:[0-9]{{4}}[ \t]*年[ \t]*)?[0-9]{{1,2}}[ \t]*月[ \t]*"
    rf"(?:{_DAY}|中下旬|上旬|中旬|下旬|初|底)?"
)
_ATOM = rf"(?:即日起|{_MONTH})"
_SEPARATOR = r"(?:至|到|—+|\u2013|\uff0d|\uff5e|~|-)"
_EXPRESSION = re.compile(
    rf"(?<![0-9年月])(?P<first>(?:[0-9]{{4}}[ \t]*年[ \t]*)?"
    rf"[0-9]{{1,2}}[ \t]*月[ \t]*[0-9]{{1,2}}(?=[ \t]*{_SEPARATOR}[ \t]*{_DAY})|{_ATOM})"
    rf"(?:[ \t]*{_SEPARATOR}[ \t]*(?P<last>{_ATOM}|{_DAY}|{_GAP}{_CLOCK}(?:前后|左右|前)?))?"
    r"(?![0-9])"
)
_POINT = re.compile(
    r"(?:(?P<year>[0-9]{4})年)?(?:(?P<month>[0-9]{1,2})月)?"
    r"(?:(?P<day>[0-9]{1,2})日)?"
    r"(?P<period>上午|中午|下午|晚上)?"
    r"(?:(?P<hour>[0-9]{1,2})[:\uff1a](?P<minute>[0-9]{2})|"
    r"(?P<clock_hour>[0-9]{1,2})[时点](?:(?P<clock_minute>[0-9]{1,2})分?)?)?"
    r"(?P<part>上旬|中旬|下旬|初|底)?(?P<mark>前后|左右|之前|前)?"
)
_PARTS: dict[str, Literal["early", "mid", "late"]] = {
    "上旬": "early",
    "初": "early",
    "中旬": "mid",
    "下旬": "late",
    "底": "late",
}
_PART_STARTS = {None: 1, "early": 1, "mid": 11, "late": 21}


@dataclass(frozen=True)
class DateMatch:
    start: int
    end: int
    text: str
    value: TimeValue | None
    end_value: TimeValue | None = None
    issue: Literal["missing_publication", "invalid_date"] | None = None


def _calendar(value: TimeValue) -> date:
    if isinstance(value, TimeToMonth):
        year, month = map(int, value.month.split("-"))
        return date(year, month, 1)
    return value.date


def _earliest(value: TimeValue) -> datetime:
    day = _calendar(value)
    if isinstance(value, TimeToMonth):
        day = day.replace(day=_PART_STARTS[value.part])
    if isinstance(value, TimeToMinute):
        hour, minute = map(int, value.time.split(":"))
        return datetime.combine(day, datetime.min.time()) + timedelta(hours=hour, minutes=minute)
    return datetime.combine(day, datetime.min.time())


def _point(
    text: str, published_on: date | None, previous: TimeValue | None = None
) -> TimeValue | None:
    compact = re.sub(r"[ \t]", "", text)
    compact = re.sub(r"[\uff08(](?:星期|周)[一二三四五六日天][\uff09)]", "", compact)
    compact = re.sub(rf"止[\uff08(]({_CLOCK})[\uff09)]$", r"\1", compact)
    if compact == "即日起":
        return TimeToDay(date=published_on) if published_on is not None else None
    match = _POINT.fullmatch(compact)
    if match is None:
        raise ValueError("Unsupported date expression")
    year_text, month_text = match["year"], match["month"]
    context = _calendar(previous) if previous is not None else published_on
    if year_text is not None:
        year = int(year_text)
    elif context is not None:
        year = context.year
    else:
        return None
    if month_text is not None:
        month = int(month_text)
    elif previous is not None:
        month = _calendar(previous).month
    else:
        raise ValueError("Missing month outside a range")
    day_text = match["day"]
    if day_text is None and previous is not None and (match["hour"] or match["clock_hour"]):
        day_text = str(_calendar(previous).day)
    part = _PARTS.get(match["part"])
    if year_text is None and context is not None and month_text is not None:
        cutoff_year = context.year - (context.month <= 6)
        cutoff_month = (context.month - 7) % 12 + 1
        cutoff_day = min(context.day, monthrange(cutoff_year, cutoff_month)[1])
        comparison_day = int(day_text) if day_text else _PART_STARTS[part]
        # Compare before validation: the inferred next year may make February 29 valid.
        year += (year, month, comparison_day) < (cutoff_year, cutoff_month, cutoff_day)
    calendar_day = date(year, month, int(day_text) if day_text else 1)
    hour_text = match["hour"] or match["clock_hour"]
    if hour_text is not None:
        if day_text is None or match["mark"] in {"前后", "左右"}:
            raise ValueError("Unsupported time precision")
        hour = int(hour_text)
        if match["period"] in {"下午", "晚上"} and 1 <= hour <= 11:
            hour += 12
        minute = int(match["minute"] or match["clock_minute"] or 0)
        return TimeToMinute(date=calendar_day, time=f"{hour:02}:{minute:02}")
    if day_text is not None:
        mark = match["mark"]
        return TimeToDay(
            date=calendar_day,
            mark="before" if mark in {"前", "之前"} else "about" if mark is not None else None,
        )
    return TimeToMonth(month=f"{year:04}-{month:02}", part=part)


def find_dates(text: str, published_on: date | None) -> list[DateMatch]:
    matches: list[DateMatch] = []
    for match in _EXPRESSION.finditer(text):
        value: TimeValue | None = None
        end_value: TimeValue | None = None
        issue: Literal["missing_publication", "invalid_date"] | None = None
        try:
            first = match["first"]
            last = match["last"]
            if first.endswith("中下旬"):
                last = first.removesuffix("中下旬") + "下旬"
                first = first.removesuffix("中下旬") + "中旬"
            if first[-1].isdigit() and "月" in first and "日" not in first:
                first += "日"
            value = _point(first, published_on)
            if value is None:
                issue = "missing_publication"
            if last is not None:
                end_value = _point(last, published_on, value)
                if end_value is None:
                    issue = "missing_publication"
                elif value is not None and _earliest(end_value) < _earliest(value):
                    raise ValueError("Reversed date range")
        except ValueError:
            issue = "invalid_date"
        # An unresolved expression must never present a partially usable range.
        if issue is not None:
            value, end_value = None, None
        start, end = match.span()
        while end > start and text[end - 1] in " \t":
            end -= 1
        matches.append(DateMatch(start, end, text[start:end], value, end_value, issue))
    return matches
