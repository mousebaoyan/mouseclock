import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from crawler.extraction.schema import Extraction
from crawler.parse.indexing import NoticeIndex

type Confidence = Annotated[float, Field(ge=0, le=1)]


class SelectionError(ValueError):
    pass


class Selection[T](BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: T
    evidence: Annotated[list[str], Field(min_length=1, max_length=20)]
    confidence: Confidence


class DateRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date_id: str
    edge: Literal["first", "last"]


class SelectedApply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: DateRef | None
    end: DateRef | None
    rolling: Literal[True] | None


class SelectedEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: DateRef | None
    end: DateRef | None
    mode: Literal["online", "offline", "hybrid"] | None
    place: str | None


class SelectedDate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str
    start: DateRef | None
    end: DateRef | None


class SelectedFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    apply: Selection[SelectedApply] | None
    apply_url: Selection[str] | None
    event: Selection[SelectedEvent] | None
    degrees: Selection[list[Literal["master", "direct_phd"]]] | None
    dates: Selection[list[SelectedDate]] | None
    majors: Selection[list[str]] | None
    requirements: Selection[list[str]] | None
    materials: Selection[list[str]] | None
    assessment: Selection[list[str]] | None
    quota: Selection[str] | None
    benefits: Selection[list[str]] | None
    contacts: Selection[list[str]] | None


class SelectedProgram(BaseModel):
    model_config = ConfigDict(extra="forbid")
    college: str
    cohort: Annotated[int, Field(ge=2000, le=2100)]
    kind: Literal["winter_camp", "summer_camp", "pre_recommendation", "september_round"]
    role: Literal["call", "update", "result"]
    name: str
    fields: SelectedFields


class SelectedExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    programs: Annotated[list[SelectedProgram], Field(max_length=50)]


def indexed_input(index: NoticeIndex) -> dict[str, JsonValue]:
    return {
        "sentences": {key: sentence.text for key, sentence in index.sentences.items()},
        "dates": {
            key: {
                "sentence_id": mention.sentence_id,
                "text": mention.match.text,
                "first": mention.match.value.model_dump(mode="json", exclude_none=True),
                "last": mention.match.end_value.model_dump(mode="json", exclude_none=True)
                if mention.match.end_value
                else None,
            }
            for key, mention in index.dates.items()
            if mention.match.issue is None and mention.match.value is not None
        },
        "links": {
            key: {"sentence_id": ref.sentence_id, "target": ref.target}
            for key, ref in index.links.items()
        },
        "emails": {
            key: {"sentence_id": ref.sentence_id, "target": ref.target}
            for key, ref in index.emails.items()
        },
    }


def resolve(selection: SelectedExtraction, index: NoticeIndex) -> Extraction:
    def time_value(ref: DateRef | None, evidence: list[str]) -> JsonValue:
        if ref is None:
            return None
        mention = index.dates[ref.date_id]
        value = mention.match.value if ref.edge == "first" else mention.match.end_value
        if mention.match.issue is not None or value is None:
            raise SelectionError("unusable_date_reference")
        evidence.append(mention.sentence_id)
        return value.model_dump(mode="json", exclude_none=True)

    def quoted(value: JsonValue, evidence: list[str], confidence: float) -> JsonValue:
        return {
            "value": value,
            "confidence": confidence,
            "evidence": [
                index.evidence(s).model_dump(mode="json", exclude_none=True)
                for s in dict.fromkeys(evidence)
            ],
        }

    programs: list[JsonValue] = []
    try:
        for program in selection.programs:
            fields: dict[str, JsonValue] = {}
            for key, field in (("apply", program.fields.apply), ("event", program.fields.event)):
                if field is None:
                    continue
                evidence = list(field.evidence)
                value: dict[str, JsonValue] = field.value.model_dump(
                    mode="json",
                    exclude={"start", "end"},
                    exclude_none=True,
                )
                for edge, ref in (("start", field.value.start), ("end", field.value.end)):
                    if ref is not None:
                        value[edge] = time_value(ref, evidence)
                fields[key] = quoted(value, evidence, field.confidence)
            entrance = program.fields.apply_url
            if entrance is not None:
                evidence = list(entrance.evidence)
                if entrance.value in index.links:
                    link = index.links[entrance.value]
                    target = link.target
                else:
                    link = index.emails[entrance.value]
                    target = "mailto:" + link.target
                evidence.append(link.sentence_id)
                fields["apply_url"] = quoted(target, evidence, entrance.confidence)
            dates = program.fields.dates
            if dates is not None:
                evidence = list(dates.evidence)
                items: list[JsonValue] = []
                for item in dates.value:
                    point: dict[str, JsonValue] = {"label": item.label}
                    for edge, ref in (("start", item.start), ("end", item.end)):
                        if ref is not None:
                            point[edge] = time_value(ref, evidence)
                    items.append(point)
                fields["dates"] = quoted(items, evidence, dates.confidence)
            for key, text_field in (
                ("degrees", program.fields.degrees),
                ("majors", program.fields.majors),
                ("requirements", program.fields.requirements),
                ("materials", program.fields.materials),
                ("assessment", program.fields.assessment),
                ("quota", program.fields.quota),
                ("benefits", program.fields.benefits),
                ("contacts", program.fields.contacts),
            ):
                if text_field is not None:
                    text_value = (
                        list[JsonValue](text_field.value)
                        if isinstance(text_field.value, list)
                        else text_field.value
                    )
                    fields[key] = quoted(text_value, text_field.evidence, text_field.confidence)
            programs.append(
                {
                    "college": program.college,
                    "cohort": program.cohort,
                    "kind": program.kind,
                    "role": program.role,
                    "name": program.name,
                    "fields": fields,
                }
            )
    except KeyError as error:
        raise SelectionError("unknown_reference") from error
    return Extraction.model_validate_json(json.dumps({"programs": programs}), strict=True)
