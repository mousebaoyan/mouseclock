from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints, ValidationError

from crawler.crawl.contract import ExtractedProgram, ExtractionContext, UnresolvedDate, Usage
from crawler.crawl.rounds import NoticePage, StepError
from crawler.extraction.numbered import (
    SelectedExtraction,
    SelectedFields,
    SelectedProgram,
    SelectionError,
    indexed_input,
    resolve,
)
from crawler.extraction.prompt import INSTRUCTIONS
from crawler.extraction.responses import Responses, make_request
from crawler.extraction.schema import response_schema
from crawler.parse.indexing import Document, NoticeIndex, index_documents


class UnresolvedSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: Literal["apply.start", "apply.end", "event.start", "event.end", "dates"]
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    evidence: Annotated[list[str], Field(min_length=1, max_length=20)]


class RoundProgram(BaseModel):
    model_config = ConfigDict(extra="forbid")
    college_id: int
    program_id: int | None
    cohort: Annotated[int, Field(ge=2000, le=2100)]
    kind: Literal["winter_camp", "summer_camp", "pre_recommendation", "september_round"]
    role: Literal["call", "update", "result"]
    name: Annotated[str, Field(min_length=1, max_length=200)]
    fields: SelectedFields
    unresolved_dates: Annotated[list[UnresolvedSelection], Field(max_length=30)]


class RoundSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    programs: Annotated[list[RoundProgram], Field(max_length=50)]


def prepare(
    title: str, page: NoticePage, context: ExtractionContext
) -> tuple[dict[str, JsonValue], NoticeIndex]:
    index = index_documents(
        [Document(page.text, hyperlinks=page.hyperlinks)]
        + [Document(a.info.text, attachment=i) for i, a in enumerate(page.attachments)],
        published_on=context.published_on,
    )
    shared = context.model_copy(
        update={
            "colleges": sorted(context.colleges, key=lambda c: c.id),
            "programs": sorted(context.programs, key=lambda p: p.id),
        }
    ).model_dump(mode="json", exclude={"published_on"})
    notice: dict[str, JsonValue] = {
        "title": title,
        "published_on": context.published_on.isoformat() if context.published_on else None,
        "indexed": indexed_input(index),
    }
    return make_request(INSTRUCTIONS, shared, notice, response_schema(RoundSelection)), index


def resolve_programs(
    selected: RoundSelection, index: NoticeIndex, context: ExtractionContext
) -> list[ExtractedProgram]:
    colleges = {c.id: c for c in context.colleges}
    candidates = {p.id: p for p in context.programs}
    programs: list[ExtractedProgram] = []
    for item in selected.programs:
        college = colleges.get(item.college_id)
        if college is None:
            raise SelectionError("unknown_college")
        if item.program_id is not None:
            candidate = candidates.get(item.program_id)
            if candidate is None:
                raise SelectionError("unknown_program")
            if (candidate.college_id, candidate.cohort, candidate.kind) != (
                item.college_id,
                item.cohort,
                item.kind,
            ):
                raise SelectionError("program_metadata_mismatch")
        resolved = resolve(
            SelectedExtraction(
                programs=[
                    SelectedProgram(
                        college=college.name,
                        cohort=item.cohort,
                        kind=item.kind,
                        role=item.role,
                        name=item.name,
                        fields=item.fields,
                    )
                ]
            ),
            index,
        ).programs[0]
        unresolved: list[UnresolvedDate] = []
        for raw in item.unresolved_dates:
            if any(s not in index.sentences for s in raw.evidence):
                raise SelectionError("unknown_sentence")
            evidence = [index.evidence(s) for s in dict.fromkeys(raw.evidence)]
            if not any("".join(raw.text.split()) in "".join(e.quote.split()) for e in evidence):
                raise SelectionError("unresolved_text_not_in_evidence")
            if raw.field != "dates":
                field, edge = raw.field.split(".")
                interval = resolved.fields.apply if field == "apply" else resolved.fields.event
                if interval is not None and getattr(interval.value, edge) is not None:
                    raise SelectionError("unresolved_date_has_value")
            unresolved.append(UnresolvedDate(field=raw.field, text=raw.text, evidence=evidence))
        programs.append(
            ExtractedProgram(
                college_id=item.college_id,
                program_id=item.program_id,
                cohort=item.cohort,
                kind=item.kind,
                role=item.role,
                name=item.name,
                fields=resolved.fields,
                unresolved_dates=unresolved or None,
            )
        )
    return programs


class Extract:
    def __init__(self, llm: Responses) -> None:
        self.llm = llm

    async def __call__(
        self, title: str, page: NoticePage, context: ExtractionContext
    ) -> tuple[list[ExtractedProgram], list[Usage]]:
        payload, index = prepare(title, page, context)
        response = await self.llm.generate(payload)
        usage = response.usage
        if usage is None:
            raise StepError("error", "抽取失败: missing_usage")
        try:
            selected = RoundSelection.model_validate_json(response.output_text(), strict=True)
            programs = resolve_programs(selected, index, context)
        except ValidationError as error:
            raise StepError("error", "抽取失败: invalid_selection") from error
        except SelectionError as error:
            raise StepError("error", f"抽取失败: {error}") from error
        return programs, [
            Usage(
                model=response.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
            )
        ]
