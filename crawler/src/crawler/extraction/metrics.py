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
    # Maximum one-to-one assignment, weighted toward project identity before field values.
    size = max(len(gold), len(predicted))
    if not size:
        return []
    costs = [[0] * size for _ in range(size)]
    for i, expected in enumerate(gold):
        a = values(expected)
        for j, actual in enumerate(predicted):
            b = values(actual)
            costs[i][j] = -(
                100 * sum(a[k] == b[k] for k in META)
                + sum(a[k] == b.get(k) for k in FIELD_NAMES if k in a)
            )
    u, v, matching = [0] * (size + 1), [0] * (size + 1), [0] * (size + 1)
    for row in range(1, size + 1):
        matching[0] = row
        column = 0
        distance, used, previous = [10**9] * (size + 1), [False] * (size + 1), [0] * (size + 1)
        while True:
            used[column] = True
            current = matching[column]
            delta, following = 10**9, 0
            for j in range(1, size + 1):
                if used[j]:
                    continue
                cost = costs[current - 1][j - 1] - u[current] - v[j]
                if cost < distance[j]:
                    distance[j], previous[j] = cost, column
                if distance[j] < delta:
                    delta, following = distance[j], j
            for j in range(size + 1):
                if used[j]:
                    u[matching[j]] += delta
                    v[j] -= delta
                else:
                    distance[j] -= delta
            column = following
            if matching[column] == 0:
                break
        while column:
            before = previous[column]
            matching[column] = matching[before]
            column = before
    return [
        (
            gold[matching[j] - 1] if matching[j] <= len(gold) else None,
            predicted[j - 1] if j <= len(predicted) else None,
        )
        for j in range(1, size + 1)
    ]


@dataclass
class Metric:
    correct: int = 0
    expected: int = 0
    predicted: int = 0
    union: int = 0

    def add(self, expected: JsonValue, actual: JsonValue) -> None:
        self.expected += expected is not None
        self.predicted += actual is not None
        self.union += expected is not None or actual is not None
        self.correct += expected is not None and actual is not None and expected == actual

    def report(self) -> dict[str, JsonValue]:
        return {
            "correct": self.correct,
            "expected": self.expected,
            "predicted": self.predicted,
            "union": self.union,
            "accuracy": self.correct / self.union if self.union else None,
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
