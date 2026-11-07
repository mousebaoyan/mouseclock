from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from crawler.crawl.contract import (
    ApplyValue,
    EventValue,
    ExtractedFields,
)


class Program(BaseModel):
    model_config = ConfigDict(extra="forbid")
    college: Annotated[str, Field(min_length=1)]
    cohort: Annotated[int, Field(ge=2000, le=2100)]
    kind: Literal["winter_camp", "summer_camp", "pre_recommendation", "september_round"]
    role: Literal["call", "update", "result"]
    name: str
    fields: ExtractedFields


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    programs: Annotated[list[Program], Field(max_length=50)]


class LabelFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    apply: ApplyValue | None = None
    apply_url: str | None = None
    event: EventValue | None = None
    degrees: list[Literal["master", "direct_phd"]] | None = None


class LabelProgram(BaseModel):
    model_config = ConfigDict(extra="forbid")
    college: str
    cohort: int
    kind: Literal["winter_camp", "summer_camp", "pre_recommendation", "september_round"]
    role: Literal["call", "update", "result"]
    fields: LabelFields


class Notice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str
    title: str
    published_on: date
    school: str
    programs: list[LabelProgram]


def response_schema(output: type[BaseModel]) -> dict[str, JsonValue]:
    def strict(node: JsonValue) -> JsonValue:
        if isinstance(node, list):
            return [strict(item) for item in node]
        if not isinstance(node, dict):
            return node
        result = {k: strict(v) for k, v in node.items() if k not in {"default", "title"}}
        properties = result.get("properties")
        if isinstance(properties, dict):
            result["required"] = list(properties)
            result["additionalProperties"] = False
        return result

    schema: dict[str, JsonValue] = output.model_json_schema()
    return {k: strict(v) for k, v in schema.items()}
