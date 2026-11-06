import argparse
import asyncio
import json
import os
from collections import Counter
from pathlib import Path
from statistics import mean, median, quantiles
from typing import Annotated

from pydantic import BaseModel, Field, JsonValue, TypeAdapter, ValidationError

from crawler.crawl.fetch import Fetcher, FetchError
from crawler.extraction.llm import (
    DEFAULT_MODELS,
    LLM,
    MAX_TOKENS,
    TIMEOUT,
    Call,
    Mode,
    Result,
    cost_cny,
    make_call,
)
from crawler.extraction.metrics import FIELD_NAMES, META, Evaluation
from crawler.extraction.numbered import SelectedExtraction, SelectionError, resolve
from crawler.extraction.pages import Page, PageError, read_page
from crawler.extraction.schema import Extraction, Notice
from crawler.parse.indexing import Document, index_documents

CONCURRENCY = 3


class CachedCall(BaseModel):
    call: Call
    result: Result


class Options(BaseModel):
    dataset: Path
    output: Path
    models: list[str]
    modes: list[Mode]
    limit: Annotated[int | None, Field(gt=0)] = None
    reuse_only: bool
    prepare_only: bool
    retry_errors: bool = False


def write_json(path: Path, value: JsonValue) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def select_notices(notices: list[Notice], limit: int | None) -> list[Notice]:
    if limit is None or limit >= len(notices):
        return notices
    # Evenly spaced, deterministic pilot; it is not a held-out test set.
    return [notices[i * len(notices) // limit] for i in range(limit)]


def summarize(model: str, results: list[Result], evaluation: Evaluation) -> dict[str, JsonValue]:
    calls = len(results)
    known = [r for r in results if r.usage is not None]
    costs = [cost_cny(model, r) for r in results]
    references = [cost_cny(model, r, reference=True) for r in results]
    times = [r.elapsed_seconds for r in results]
    reasoning = [
        r.usage.completion_tokens_details.reasoning_tokens
        for r in known
        if r.usage is not None
        and r.usage.completion_tokens_details is not None
        and r.usage.completion_tokens_details.reasoning_tokens is not None
    ]
    report = evaluation.report()
    report.update(
        {
            "calls": calls,
            "failures": sum(r.error is not None for r in results),
            "known_usage_calls": len(known),
            "input_tokens_per_notice": mean(
                r.usage.prompt_tokens for r in known if r.usage is not None
            )
            if known
            else None,
            "output_tokens_per_notice": mean(
                r.usage.completion_tokens for r in known if r.usage is not None
            )
            if known
            else None,
            "reasoning_tokens_per_notice": mean(reasoning) if reasoning else None,
            "reasoning_usage_calls": len(reasoning),
            "mean_seconds": mean(times) if times else None,
            "p50_seconds": median(times) if times else None,
            "p95_seconds": quantiles(times, n=100, method="inclusive")[94]
            if len(times) > 1
            else times[0]
            if times
            else None,
            "estimated_total_cny": sum(c for c in costs if c is not None)
            if costs and all(c is not None for c in costs)
            else None,
            "reference_cny_per_notice": sum(c for c in references if c is not None) / calls
            if calls and all(c is not None for c in references)
            else None,
        }
    )
    report["returned_models"] = list[JsonValue](
        sorted({r.returned_model for r in results if r.returned_model})
    )
    report["known_estimated_cny"] = sum(c for c in costs if c is not None)
    report["unknown_cost_calls"] = sum(c is None for c in costs)
    report["known_reference_cny"] = sum(c for c in references if c is not None)
    known_references = [c for c in references if c is not None]
    report["reference_cny_per_known_response"] = (
        mean(known_references) if known_references else None
    )
    successes = [r.elapsed_seconds for r in results if r.error is None]
    report["successful_mean_seconds"] = mean(successes) if successes else None
    report["failure_types"] = dict[str, JsonValue](Counter(r.error for r in results if r.error))
    return report


def markdown(report: dict[str, JsonValue]) -> str:
    rows = [
        "# 抽取摸底实验",
        "",
        "本轮使用 #75 的 S/D/L/E 编号,程序按引用还原时间值、报名入口和证据。",
        "参数为请求值,不保证服务端采用;实际推理 token 单列。准确率不计双方都缺省的字段,",
        "只对标注集已有的项目元数据与 apply/apply_url/event/degrees 计准确率,其他字段只校验证据。",
        "多项目采用一对一最优匹配,先匹配学院、届、类型、作用,再以字段值打破平局。",
        "失败记录为未抽取,保留已返回用量;证据匹配只忽略空白,不能替代语义核验。",
        "",
        "费用按官方单价估算,本轮估算含已知缓存与北京时间优惠;参考费用统一按常规时段、不计缓存。",
        "用量未知时费用未知,不计成免费。单次非流式请求耗时包含网络及排队,无首 token 延迟指标。",
        "",
        "| 模型 / 请求设置 | 样本 | 失败 | 已标字段全对 | 截止准确率 | 证据未找到 | "
        "平均秒 | 输入/输出 token | 参考元/条 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    experiments = report.get("experiments")
    if isinstance(experiments, dict):
        for name, item in experiments.items():
            if not isinstance(item, dict):
                continue
            fields = item.get("fields")
            deadline = fields.get("apply.end") if isinstance(fields, dict) else None
            accuracy = deadline.get("accuracy") if isinstance(deadline, dict) else None

            def number(value: JsonValue) -> str:
                return f"{value:.4f}" if isinstance(value, (int, float)) else "未知"

            rows.append(
                f"| {name} | {item.get('notices')} | {item.get('failures')} | "
                f"{number(item.get('exact_notice_accuracy'))} | {number(accuracy)} | "
                f"{number(item.get('missing_quote_rate'))} | {number(item.get('mean_seconds'))} | "
                f"{number(item.get('input_tokens_per_notice'))}/"
                f"{number(item.get('output_tokens_per_notice'))} | "
                f"{number(item.get('reference_cny_per_notice'))} |"
            )
    rows.extend(
        [
            "",
            "逐字段指标、分母、截止召回率/精确率和失败网址见 report.json。",
            "报告中的比例取值 0-1。正文与包含证据的响应缓存仅供本地使用,不提交。",
            "",
        ]
    )
    return "\n".join(rows)


async def evaluate(options: Options) -> int:
    key = os.environ.get("LLM_API_KEY")
    if not options.reuse_only and not options.prepare_only and not key:
        raise ValueError("LLM_API_KEY_missing")
    notices = TypeAdapter(list[Notice]).validate_json(options.dataset.read_bytes())
    if not notices or len({n.url for n in notices}) != len(notices):
        raise ValueError("empty_or_duplicate_dataset")
    selected = select_notices(notices, options.limit)
    options.output.mkdir(parents=True, exist_ok=True)
    page_errors: list[JsonValue] = []
    pages: dict[str, Page] = {}
    async with Fetcher() as fetcher:
        for index, notice in enumerate(notices):
            if notice not in selected:
                continue
            try:
                pages[notice.url] = await read_page(
                    notice.url,
                    options.output / "pages" / f"{index:03}.json",
                    fetcher,
                    reuse_only=options.reuse_only,
                )
            except FetchError as error:
                page_errors.append({"url": notice.url, "error": error.failure})
            except PageError as error:
                page_errors.append({"url": notice.url, "error": str(error)})
            except (ValidationError, UnicodeError) as error:
                page_errors.append({"url": notice.url, "error": type(error).__name__})
    write_json(
        options.output / "page-status.json",
        {
            "selected": len(selected),
            "ready": len(pages),
            "failures": page_errors,
        },
    )
    print(f"pages_ready={len(pages)}/{len(selected)} failures={len(page_errors)}", flush=True)
    if options.prepare_only:
        return int(bool(page_errors))
    if page_errors:
        # Keep the denominator fixed across models instead of silently shrinking the dataset.
        return 1
    records_path = options.output / "calls.jsonl"
    cache: dict[str, Result] = {}
    if records_path.exists():
        for line in records_path.read_text(encoding="utf-8").splitlines():
            entry = CachedCall.model_validate_json(line)
            cache[entry.call.model_dump_json()] = entry.result
    llm = LLM(key) if key and not options.reuse_only else None
    semaphore = asyncio.Semaphore(CONCURRENCY)
    groups: dict[tuple[str, Mode], tuple[Evaluation, list[Result]]] = {
        (model, mode): (Evaluation(), []) for mode in options.modes for model in options.models
    }

    async def run(notice: Notice, model: str, mode: Mode) -> Result:
        evaluation, results = groups[model, mode]
        page = pages[notice.url]
        call = make_call(notice, page.text, model, mode)
        identity = call.model_dump_json()
        result = cache.get(identity)
        if result is not None and options.retry_errors and result.error is not None:
            result = None
        fresh = result is None
        if result is None:
            if llm is None:
                raise ValueError("response_cache_missing")
            async with semaphore:
                result = await llm.extract(call)
        prediction: Extraction | None = None
        if result.error is None and result.content is not None:
            try:
                prediction = resolve(
                    SelectedExtraction.model_validate_json(result.content, strict=True),
                    index_documents([Document(page.text)], published_on=notice.published_on),
                )
            except SelectionError, ValidationError:
                result.error = "invalid_selection"
        if fresh:
            cache[identity] = result
            with records_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(CachedCall(call=call, result=result).model_dump_json() + "\n")
        evaluation.add(notice, prediction, page.text)
        results.append(result)
        if result.error or evaluation.notices % 10 == 0 or evaluation.notices == len(selected):
            print(
                f"model={model} mode={mode} done={evaluation.notices}/{len(selected)} "
                f"error={result.error or 'none'}",
                flush=True,
            )
        return result

    try:
        results = await asyncio.gather(
            *(
                run(notice, model, mode)
                for notice in selected
                for mode in options.modes
                for model in options.models
            )
        )
        report: dict[str, JsonValue] = {
            "dataset": str(options.dataset),
            "urls": [n.url for n in selected],
            "method": "numbered",
            "evaluated_fields": list[JsonValue](META + FIELD_NAMES),
            "settings": {
                "concurrency": CONCURRENCY,
                "max_tokens": MAX_TOKENS,
                "timeout_seconds": TIMEOUT,
                "response_format": "json_schema",
                "strict": True,
                "temperature": 0,
            },
            "experiments": {
                f"{model}/{mode}": summarize(model, items, evaluation)
                for (model, mode), (evaluation, items) in groups.items()
            },
        }
        write_json(options.output / "report.json", report)
        (options.output / "report.md").write_text(markdown(report), encoding="utf-8", newline="\n")
    finally:
        if llm:
            await llm.close()
    return int(any(result.error for result in results))


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate body-only, numbered JSON extraction.")
    parser.add_argument("--dataset", type=Path, default=Path("../data/extraction.json"))
    parser.add_argument("--output", type=Path, default=Path("extraction-results"))
    parser.add_argument("--models", nargs="+", default=list(DEFAULT_MODELS))
    parser.add_argument("--modes", nargs="+", choices=("off", "low", "high"), default=["off"])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--reuse-only", action="store_true")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--retry-errors", action="store_true")
    try:
        options = Options.model_validate(vars(parser.parse_args()))
        if options.reuse_only and options.retry_errors:
            parser.error("--retry-errors requires API access; omit --reuse-only")
        status = asyncio.run(evaluate(options))
    except ValidationError:
        parser.exit(1, "invalid_options_dataset_or_cache\n")
    raise SystemExit(status)


if __name__ == "__main__":
    main()
