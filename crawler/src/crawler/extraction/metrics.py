from collections import defaultdict
from dataclasses import dataclass

from pydantic import JsonValue

from crawler.extraction.schema import Extraction, LabelFields, LabelProgram, Notice, Program

META = ("college", "cohort", "kind", "role")
FIELD_NAMES = ("apply", "apply_url", "event", "degrees")


def plain(program: Program) -> LabelProgram:
    fields = program.fields
    return LabelProgram(
        college=program.college,
        cohort=program.cohort,
        kind=program.kind,
        role=program.role,
        fields=LabelFields(
            apply=fields.apply.value if fields.apply else None,
            apply_url=fields.apply_url.value if fields.apply_url else None,
            event=fields.event.value if fields.event else None,
            degrees=fields.degrees.value if fields.degrees else None,
        ),
    )


def values(program: LabelProgram) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {
        "college": program.college,
        "cohort": program.cohort,
        "kind": program.kind,
        "role": program.role,
    }
    fields: dict[str, JsonValue] = program.fields.model_dump(mode="json", exclude_none=True)
    degrees = fields.get("degrees")
    if isinstance(degrees, list):
        fields["degrees"] = [str(value) for value in sorted(degrees, key=str)]
    result.update(fields)
    for key in ("apply", "event"):
        nested = fields.get(key)
        if isinstance(nested, dict):
            result.update({f"{key}.{k}": v for k, v in nested.items()})
    return result


def pair_programs(
    gold: list[LabelProgram],
    predicted: list[LabelProgram],
) -> list[tuple[LabelProgram | None, LabelProgram | None]]:
    remaining = list(predicted)
    pairs: list[tuple[LabelProgram | None, LabelProgram | None]] = []
    for expected in gold:
        scores = [
            sum(getattr(expected, k) == getattr(actual, k) for k in META) for actual in remaining
        ]
        match = max(range(len(scores)), key=scores.__getitem__) if scores else None
        if match is not None and scores[match] == 0:
            match = None
        pairs.append((expected, remaining.pop(match) if match is not None else None))
    pairs.extend((None, actual) for actual in remaining)
    return pairs


@dataclass
class Metric:
    correct: int = 0
    expected: int = 0
    predicted: int = 0
    union: int = 0
    wrong: int = 0
    missing: int = 0
    extra: int = 0

    def add(self, expected: JsonValue, actual: JsonValue) -> None:
        self.expected += expected is not None
        self.predicted += actual is not None
        self.union += expected is not None or actual is not None
        self.correct += expected is not None and actual is not None and expected == actual
        self.wrong += expected is not None and actual is not None and expected != actual
        self.missing += expected is not None and actual is None
        self.extra += expected is None and actual is not None

    def report(self) -> dict[str, JsonValue]:
        return {
            "correct": self.correct,
            "expected": self.expected,
            "predicted": self.predicted,
            "union": self.union,
            "wrong": self.wrong,
            "missing": self.missing,
            "extra": self.extra,
            "accuracy": self.correct / self.expected if self.expected else None,
            "recall": self.correct / self.expected if self.expected else None,
            "precision": self.correct / self.predicted if self.predicted else None,
        }


class Evaluation:
    def __init__(self) -> None:
        self.metrics: defaultdict[str, Metric] = defaultdict(Metric)
        self.notices = 0
        self.exact_notices = 0
        self.quotes = 0
        self.missing_quotes = 0
        self.relevant = Metric()
        self.errors: list[JsonValue] = []

    def add(self, notice: Notice, prediction: Extraction | None, text: str) -> None:
        self.notices += 1
        actual = [plain(p) for p in prediction.programs] if prediction else []
        expected_relevant = bool(notice.programs)
        actual_relevant = bool(actual)
        self.relevant.add(True if expected_relevant else None, True if actual_relevant else None)
        equal = prediction is not None
        differences: list[JsonValue] = []
        for index, (expected, predicted) in enumerate(pair_programs(notice.programs, actual)):
            a, b = values(expected) if expected else {}, values(predicted) if predicted else {}
            equal = equal and a == b
            for key in a.keys() | b.keys():
                self.metrics[key].add(a.get(key), b.get(key))
                if a.get(key) != b.get(key):
                    differences.append(
                        {"pair": index, "field": key, "expected": a.get(key), "actual": b.get(key)}
                    )
        self.exact_notices += equal
        if not equal:
            self.errors.append(
                {
                    "url": notice.url,
                    "reason": "parse_or_call_failure" if prediction is None else "field_mismatch",
                    "differences": differences,
                }
            )
        if prediction:
            normalized = "".join(text.split())
            for program in prediction.programs:
                for field in (
                    program.fields.apply,
                    program.fields.apply_url,
                    program.fields.event,
                    program.fields.degrees,
                    program.fields.dates,
                    program.fields.majors,
                    program.fields.requirements,
                    program.fields.materials,
                    program.fields.assessment,
                    program.fields.quota,
                    program.fields.benefits,
                    program.fields.contacts,
                ):
                    if field:
                        for evidence in field.evidence:
                            self.quotes += 1
                            quote = "".join(evidence.quote.split())
                            self.missing_quotes += (
                                evidence.attachment is not None
                                or not quote
                                or quote not in normalized
                            )

    def report(self) -> dict[str, JsonValue]:
        return {
            "notices": self.notices,
            "exact_notices": self.exact_notices,
            "exact_notice_accuracy": self.exact_notices / self.notices if self.notices else None,
            "fields": {key: metric.report() for key, metric in sorted(self.metrics.items())},
            "relevance": self.relevant.report(),
            "quotes": self.quotes,
            "missing_quotes": self.missing_quotes,
            "missing_quote_rate": self.missing_quotes / self.quotes if self.quotes else None,
            "errors": self.errors,
        }
