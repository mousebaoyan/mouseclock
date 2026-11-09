from typing import Annotated, Literal

import httpx
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

ROUND_INSTRUCTIONS = (
    INSTRUCTIONS
    + """

本任务接入真实抓取流程,以下编号和上下文规则替代上面 college 的自由填写规则:
college_id 必须选同校 colleges 中的编号,不生成学院名称或新编号。
program_id 只选 programs 中同学院、届、类型的已有项目编号;确为新项目时 null。
近期项目是识别项目的对照,不是这条通知的事实或证据。不能从对照抄字段。
更新通知只写这次明确写出的内容:只延期截止就只给 apply.end,不能抄旧的 start。
S/D/L/E 编号覆盖正文和附件,证据的附件位置由程序还原,不由你编造。
有明确时分的报名截止应选择含完整时分的候选,不能拿同一天只有日期的候选替代。
必须分别保留有独立报名时间的项目,不能因它们在同一通知中而合并。
原文明确写了时间,但 D 候选没有对应值时,不要猜值或悄悄省略:
在 unresolved_dates 中填写 field(apply.start/apply.end/event.start/event.end/dates)、
照抄的时间原文 text 和支持它的 S 编号 evidence。对应 start/end 仍写 null。
没有未识别时间时 unresolved_dates 写空列表。另行通知、未写时间不算未识别时间。
未识别时间送人审核,不能把它改成其他字段的日期。未知编号或不合法输出会使整条失败。
"""
)


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
    page: NoticePage, context: ExtractionContext
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
        "title": page.title,
        "published_on": context.published_on.isoformat() if context.published_on else None,
        "indexed": indexed_input(index),
    }
    return make_request(ROUND_INSTRUCTIONS, shared, notice, response_schema(RoundSelection)), index


def resolve_programs(
    selected: RoundSelection, index: NoticeIndex, context: ExtractionContext
) -> list[ExtractedProgram]:
    colleges = {c.id: c for c in context.colleges}
    candidates = {p.id: p for p in context.programs}
    programs: list[ExtractedProgram] = []
    try:
        for item in selected.programs:
            college = colleges[item.college_id]
            if item.program_id is not None:
                candidate = candidates[item.program_id]
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
    except KeyError as error:
        raise SelectionError("unknown_reference") from error
    return programs


class Extract:
    def __init__(self, key: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.llm = Responses(key, transport)

    async def close(self) -> None:
        await self.llm.close()

    async def __call__(
        self, page: NoticePage, context: ExtractionContext
    ) -> tuple[list[ExtractedProgram], list[Usage]]:
        payload, index = prepare(page, context)
        response = await self.llm.generate(payload)
        try:
            selected = RoundSelection.model_validate_json(response.output_text(), strict=True)
            programs = resolve_programs(selected, index, context)
        except (ValidationError, SelectionError) as error:
            raise StepError("error", "Invalid extraction selection") from error
        usage = response.usage
        if usage is None:
            raise StepError("error", "LLM did not return usage")
        return programs, [
            Usage(
                model=response.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
            )
        ]
