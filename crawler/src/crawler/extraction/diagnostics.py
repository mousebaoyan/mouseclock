from pydantic import JsonValue

from crawler.extraction.schema import Notice
from crawler.parse.indexing import Document, index_documents


def date_coverage(notices: list[Notice], documents: dict[str, Document]) -> dict[str, JsonValue]:
    fields: dict[str, JsonValue] = {}
    missing: list[JsonValue] = []
    for field in ("apply", "event"):
        for edge in ("start", "end"):
            total = covered = 0
            for notice in notices:
                index = index_documents([documents[notice.url]], published_on=notice.published_on)
                candidates = [
                    value.model_dump(mode="json", exclude_none=True)
                    for mention in index.dates.values()
                    if mention.match.issue is None
                    for value in (mention.match.value, mention.match.end_value)
                    if value is not None
                ]
                for program in notice.programs:
                    interval = getattr(program.fields, field)
                    value = getattr(interval, edge) if interval is not None else None
                    if value is None:
                        continue
                    total += 1
                    expected = value.model_dump(mode="json", exclude_none=True)
                    if expected in candidates:
                        covered += 1
                    else:
                        missing.append(
                            {
                                "url": notice.url,
                                "college": program.college,
                                "field": f"{field}.{edge}",
                                "expected": expected,
                            }
                        )
            fields[f"{field}.{edge}"] = {"covered": covered, "total": total}
    return {"fields": fields, "missing": missing}
