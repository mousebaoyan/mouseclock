import argparse
import asyncio
import csv
import json
import os
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from time import perf_counter
from typing import Annotated

from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError

from crawler.crawl.contract import ExtractionContext
from crawler.crawl.fetch import Fetcher, FetchError
from crawler.crawl.rounds import NoticePage, StepError
from crawler.extraction.diagnostics import date_coverage
from crawler.extraction.extract import RoundSelection, prepare, resolve_programs
from crawler.extraction.metrics import Evaluation
from crawler.extraction.numbered import SelectionError
from crawler.extraction.pages import Page, PageError, read_page
from crawler.extraction.responses import MODEL, Response, Responses
from crawler.extraction.schema import Extraction, Notice, Program
from crawler.parse.indexing import Document

CONCURRENCY = 3


class Result(BaseModel):
    response: Response | None = None
    elapsed_seconds: float
    observed_at: datetime
    error: str | None = None


class CachedCall(BaseModel):
    call: dict[str, JsonValue]
    result: Result


class Options(BaseModel):
    dataset: Path
    output: Path
    sources: Path = Path("../data/sources.csv")
    limit: Annotated[int | None, Field(gt=0)] = None
    reuse_only: bool = False
    prepare_only: bool = False
    off_peak: bool = False


def write_json(path: Path, value: JsonValue) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def select_notices(notices: list[Notice], limit: int | None) -> list[Notice]:
    if limit is None or limit >= len(notices):
        return notices
    # Evenly spaced, deterministic pilot; it is not a held-out test set.
    return [notices[i * len(notices) // limit] for i in range(limit)]


def colleges_by_school(path: Path) -> dict[str, list[dict[str, JsonValue]]]:
    with path.open(encoding="utf-8", newline="") as stream:
        names = sorted({(r["school"], r["college"]) for r in csv.DictReader(stream)})
    schools: dict[str, list[dict[str, JsonValue]]] = {}
    for college_id, (school, college) in enumerate(names, 1):
        schools.setdefault(school, []).append({"id": college_id, "name": college})
    return schools


def cost_cny(result: Result, *, off_peak: bool = False, cached: bool = True) -> float | None:
    usage = result.response.usage if result.response else None
    if usage is None:
        return None
    hits = usage.input_tokens_details.cached_tokens if usage.input_tokens_details else None
    if cached and hits is None:
        return None
    hit = hits if cached and hits is not None else 0
    # Official CNY/M tokens; the experiment explicitly selects its billing period.
    return (
        ((usage.input_tokens - hit) * 2 + hit * 0.04 + usage.output_tokens * 8)
        / 1e6
        * (0.5 if off_peak else 1)
    )


def summarize(
    results: list[Result], evaluation: Evaluation, off_peak: bool
) -> dict[str, JsonValue]:
    report = evaluation.report()
    usages = [r.response.usage for r in results if r.response and r.response.usage is not None]
    hits = [
        u.input_tokens_details.cached_tokens if u.input_tokens_details else None for u in usages
    ]
    inputs = sum(u.input_tokens for u in usages)
    known_hits = sum(n for n in hits if n is not None)
    costs = [cost_cny(r, off_peak=off_peak) for r in results]
    report.update(
        {
            "calls": len(results),
            "failures": sum(r.error is not None for r in results),
            "failure_types": dict[str, JsonValue](Counter(r.error for r in results if r.error)),
            "known_usage_calls": len(usages),
            "input_tokens": inputs,
            "output_tokens": sum(u.output_tokens for u in usages),
            "cache_hit_tokens": known_hits,
            "cache_hit_rate": known_hits / inputs
            if inputs and len(usages) == len(results) and all(n is not None for n in hits)
            else None,
            "estimated_total_cny": sum(c for c in costs if c is not None)
            if all(c is not None for c in costs)
            else None,
            "known_estimated_cny": sum(c for c in costs if c is not None),
            "unknown_cost_calls": sum(c is None for c in costs),
            "mean_seconds": mean(r.elapsed_seconds for r in results) if results else None,
        }
    )
    return report


def markdown(report: dict[str, JsonValue]) -> str:
    return (
        "# 官方编号抽取复验\n\n固定标注分母。失败保留分母。"
        "费用按用量估算。未核对账单。\n\n```json\n"
        + json.dumps(report["experiments"], ensure_ascii=False, indent=2)
        + "\n```\n"
    )


async def evaluate(options: Options) -> int:
    key = os.environ.get("LLM_API_KEY")
    if not options.reuse_only and not options.prepare_only and not key:
        raise ValueError("LLM_API_KEY_missing")
    notices = TypeAdapter(list[Notice]).validate_json(options.dataset.read_bytes())
    if not notices or len({n.url for n in notices}) != len(notices):
        raise ValueError("empty_or_duplicate_dataset")
    selected = select_notices(notices, options.limit)
    schools = colleges_by_school(options.sources)
    options.output.mkdir(parents=True, exist_ok=True)
    pages: dict[str, Page] = {}
    errors: list[JsonValue] = []
    async with Fetcher() as fetcher:
        for notice in selected:
            try:
                pages[notice.url] = await read_page(
                    notice.url,
                    options.output / "pages.json",
                    fetcher,
                    reuse_only=options.reuse_only,
                )
            except FetchError as error:
                errors.append({"url": notice.url, "error": error.failure})
            except (PageError, ValidationError, UnicodeError) as error:
                errors.append(
                    {
                        "url": notice.url,
                        "error": str(error)
                        if isinstance(error, PageError)
                        else type(error).__name__,
                    }
                )
    coverage = (
        date_coverage(
            selected, {u: Document(p.text, hyperlinks=p.hyperlinks) for u, p in pages.items()}
        )
        if not errors
        else None
    )
    write_json(
        options.output / "page-status.json",
        {
            "selected": len(selected),
            "ready": len(pages),
            "failures": errors,
            "date_coverage": coverage,
        },
    )
    print(f"pages_ready={len(pages)}/{len(selected)} failures={len(errors)}", flush=True)
    if options.prepare_only or errors:
        return int(bool(errors))
    records_path = options.output / "calls.jsonl"
    cache: dict[str, Result] = {}
    if records_path.exists():
        for line in records_path.read_text(encoding="utf-8").splitlines():
            entry = CachedCall.model_validate_json(line)
            if (
                entry.result.response is not None
                and entry.result.response.status == "completed"
                and entry.result.error is None
            ):
                cache[json.dumps(entry.call, sort_keys=True)] = entry.result
    evaluation = Evaluation()
    results: list[Result] = []
    semaphore = asyncio.Semaphore(CONCURRENCY)
    async with Responses(key or "") as llm:

        async def run(notice: Notice) -> None:
            context = ExtractionContext.model_validate(
                {
                    "published_on": notice.published_on,
                    "colleges": schools[notice.school],
                    "programs": [],
                }
            )
            page = pages[notice.url]
            call, index = prepare(
                notice.title, NoticePage("", page.text, [], hyperlinks=page.hyperlinks), context
            )
            identity = json.dumps(call, sort_keys=True)
            result = cache.get(identity)
            if result is None:
                if options.reuse_only:
                    raise ValueError("response_cache_missing")
                async with semaphore:
                    start = perf_counter()
                    result = Result(elapsed_seconds=0, observed_at=datetime.now(UTC))
                    try:
                        result.response = await llm.generate(call)
                    except StepError as error:
                        result.error = error.detail
                    result.elapsed_seconds = perf_counter() - start
                if (
                    result.error is None
                    and result.response is not None
                    and result.response.status == "completed"
                ):
                    with records_path.open("a", encoding="utf-8", newline="\n") as stream:
                        stream.write(CachedCall(call=call, result=result).model_dump_json() + "\n")
            # Only provider results are cached; selection restoration always runs again.
            result = result.model_copy()
            prediction: Extraction | None = None
            if result.error is None and result.response is not None:
                try:
                    programs = resolve_programs(
                        RoundSelection.model_validate_json(
                            result.response.output_text(), strict=True
                        ),
                        index,
                        context,
                    )
                    names = {c.id: c.name for c in context.colleges}
                    prediction = Extraction(
                        programs=[
                            Program(
                                college=names[p.college_id],
                                cohort=p.cohort,
                                kind=p.kind,
                                role=p.role,
                                name=p.name,
                                fields=p.fields,
                            )
                            for p in programs
                        ]
                    )
                    if result.response.usage is None:
                        prediction = None
                        result.error = "missing_usage"
                except (SelectionError, ValidationError) as error:
                    result.error = type(error).__name__
                except StepError as error:
                    result.error = error.detail
            evaluation.add(notice, prediction, page.text)
            results.append(result)
            print(f"done={len(results)}/{len(selected)} error={result.error or 'none'}", flush=True)

        await asyncio.gather(*(run(n) for n in selected))
    report: dict[str, JsonValue] = {
        "dataset": str(options.dataset),
        "urls": [n.url for n in selected],
        "date_coverage": coverage,
        "scope": "First ingestion; colleges from sources.csv; no existing projects or attachments",
        "billing_period": "off_peak" if options.off_peak else "peak",
        "experiments": {MODEL: summarize(results, evaluation, options.off_peak)},
    }
    write_json(options.output / "report.json", report)
    (options.output / "report.md").write_text(markdown(report), encoding="utf-8", newline="\n")
    return int(any(r.error for r in results))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate the production numbered extraction scheme."
    )
    parser.add_argument("--dataset", type=Path, default=Path("../data/extraction.json"))
    parser.add_argument("--sources", type=Path, default=Path("../data/sources.csv"))
    parser.add_argument("--output", type=Path, default=Path("extraction-results"))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--reuse-only", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument(
        "--off-peak", action="store_true", help="Use official off-peak token prices for this run"
    )
    raise SystemExit(asyncio.run(evaluate(Options.model_validate(vars(parser.parse_args())))))


if __name__ == "__main__":
    main()
