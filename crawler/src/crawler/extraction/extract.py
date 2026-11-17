from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints, ValidationError

from crawler.crawl.contract import (
    ExtractedProgram,
    ExtractionContext,
    ProgramCandidate,
    UnresolvedDate,
    Usage,
)
from crawler.crawl.rounds import NoticePage, StepError
from crawler.extraction.chat import Chat, make_request
from crawler.extraction.numbered import (
    SelectedExtraction,
    SelectedFields,
    SelectedProgram,
    SelectionError,
    indexed_input,
    resolve,
)
from crawler.extraction.prompt import INSTRUCTIONS
from crawler.extraction.schema import response_schema
from crawler.parse.dates import find_dates
from crawler.parse.indexing import Document, NoticeIndex, index_documents

Kind = Literal["winter_camp", "summer_camp", "pre_recommendation", "september_round"]


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
    kind: Kind
    role: Literal["call", "update", "result"]
    name: Annotated[str, Field(min_length=1, max_length=200)]
    fields: SelectedFields
    unresolved_dates: Annotated[list[UnresolvedSelection], Field(max_length=30)]


class RoundSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    programs: Annotated[list[RoundProgram], Field(max_length=50)]


def cohort_of(published_on: date, kind: Kind) -> int:
    """The cohort a notice published that day is about (design §9.1): recommendation for those
    starting in the autumn runs through the year before, and only winter camps start the autumn
    before that. The model, reading a 「2026 年夏令营」 as the cohort 2026, gets it wrong."""
    return published_on.year + (2 if kind == "winter_camp" and published_on.month >= 9 else 1)


def _candidates(context: ExtractionContext) -> list[ProgramCandidate]:
    """The school's programs of the cohort the notice is about. Offered other years' too, the
    model took a series' program of another year for the notice's."""
    published_on = context.published_on
    if published_on is None:
        return context.programs
    return [p for p in context.programs if p.cohort == cohort_of(published_on, p.kind)]


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
            "programs": sorted(_candidates(context), key=lambda p: p.id),
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
    candidates = {p.id: p for p in _candidates(context)}
    chosen = [item.program_id for item in selected.programs if item.program_id is not None]
    if len(set(chosen)) < len(chosen):
        raise SelectionError("duplicate_program")
    programs: list[ExtractedProgram] = []
    for item in selected.programs:
        college = colleges.get(item.college_id)
        if college is None:
            raise SelectionError("unknown_college")
        # The model's cohort only for a notice without a date.
        cohort = (
            item.cohort
            if context.published_on is None
            else cohort_of(context.published_on, item.kind)
        )
        program_id = item.program_id
        if program_id is not None:
            candidate = candidates.get(program_id)
            if candidate is None:
                raise SelectionError("unknown_program")
            # A pick of another college's or kind's program isn't the program; it goes as a new
            # one, which the website holds for review when the school has one of the same
            # college, cohort and kind after all (design §8.4).
            if (candidate.college_id, candidate.cohort, candidate.kind) != (
                item.college_id,
                cohort,
                item.kind,
            ):
                program_id = None
        resolved = resolve(
            SelectedExtraction(
                programs=[
                    SelectedProgram(
                        college=college.name,
                        cohort=cohort,
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
            # A time the program reads, all of it, was a candidate the model could have picked: one
            # of the other times, or for a start or end it picked already, isn't worth a person's
            # look. Words around a date can move it (6月30日后的第三个工作日).
            text = "".join(raw.text.split())
            readable = any(
                m.value and "".join(m.text.split()) == text
                for m in find_dates(raw.text, context.published_on)
            )
            if raw.field == "dates":
                if readable:
                    continue
            else:
                field, edge = raw.field.split(".")
                interval = resolved.fields.apply if field == "apply" else resolved.fields.event
                if interval is not None and getattr(interval.value, edge) is not None:
                    if readable:
                        continue
                    raise SelectionError("unresolved_date_has_value")
            unresolved.append(UnresolvedDate(field=raw.field, text=raw.text, evidence=evidence))
        programs.append(
            ExtractedProgram(
                college_id=item.college_id,
                program_id=program_id,
                cohort=cohort,
                kind=item.kind,
                role=item.role,
                name=item.name,
                fields=resolved.fields,
                unresolved_dates=unresolved or None,
            )
        )
    return programs


class Extract:
    def __init__(self, llm: Chat) -> None:
        self.llm = llm

    async def __call__(
        self, title: str, page: NoticePage, context: ExtractionContext, usage: list[Usage]
    ) -> list[ExtractedProgram]:
        payload, index = prepare(title, page, context)
        response = await self.llm.generate(payload)
        tokens = response.usage
        if tokens is None:
            raise StepError("error", "抽取失败: missing_usage")
        usage.append(
            Usage(
                model=response.model,
                input_tokens=tokens.prompt_tokens,
                output_tokens=tokens.completion_tokens,
            )
        )
        try:
            selected = RoundSelection.model_validate_json(response.output_text(), strict=True)
            return resolve_programs(selected, index, context)
        except ValidationError as error:
            raise StepError("error", "抽取失败: invalid_selection") from error
        except SelectionError as error:
            raise StepError("error", f"抽取失败: {error}") from error
