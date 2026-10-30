import argparse
import asyncio
import csv
import getpass
import json
import os
from collections import Counter
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from crawler.screening.siliconflow import (
    CHAT_MODELS,
    PRICES,
    PRICING_DATE,
    PRICING_URL,
    SYSTEM_ONE_PRICING_URL,
    Call,
    Result,
    SiliconFlow,
    cost_cny,
)

CORE = ("夏令营", "冬令营", "推免")
COMMON = (*CORE, "推荐免试")
CAMPS = (*COMMON, "入营", "优秀营员", "暑期学校", "暑期研修班", "学术交流营", "科学营", "开放日")
SELECTION = (*CAMPS, "免试攻读", "优本计划", "优秀本科生选拔", "春闱", "预报名", "提前选拔")
KEYWORDS = {
    "core": CORE,
    "common": COMMON,
    "camps": CAMPS,
    "selection": SELECTION,
    "admission": (*SELECTION, "研究生招生", "招生简章", "招生章程"),
    "broad": (*SELECTION, "研究生招生", "招生简章", "招生章程", "复试", "考核", "名单"),
}
THRESHOLDS = (0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 0.95, 0.99, 1)


class Sample(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_url: str
    section: str
    url: str
    title: str = Field(min_length=1)
    relevant: Literal["0", "1"]
    note: str

    @field_validator("source_url", "url")
    @classmethod
    def public_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Expected an HTTP(S) URL")
        return value


class Cached(BaseModel):
    call: Call
    result: Result


class Metrics(BaseModel):
    method: str
    with_section: bool
    threshold: float
    samples: int
    true_positive: int
    false_negative: int
    true_negative: int
    false_positive: int
    recall: float | None
    filtering: float | None
    accuracy: float
    cost_per_1000_cny: float | None


def read_samples(path: Path) -> list[Sample]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        samples = [Sample.model_validate(row) for row in csv.DictReader(stream)]
    if not samples or len({sample.url for sample in samples}) != len(samples):
        raise ValueError("Dataset must be nonempty and notice URLs must be unique")
    return samples


def measure(
    samples: list[Sample],
    scores: list[float],
    method: str,
    with_section: bool,
    threshold: float,
    cost_per_1000_cny: float | None,
) -> Metrics:
    counts: Counter[tuple[bool, bool]] = Counter(
        (sample.relevant == "1", score >= threshold)
        for sample, score in zip(samples, scores, strict=True)
    )
    tp, fn, tn, fp = (
        counts[(True, True)],
        counts[(True, False)],
        counts[(False, False)],
        counts[(False, True)],
    )
    return Metrics(
        method=method,
        with_section=with_section,
        threshold=threshold,
        samples=len(samples),
        true_positive=tp,
        false_negative=fn,
        true_negative=tn,
        false_positive=fp,
        recall=tp / (tp + fn) if tp + fn else None,
        filtering=tn / (tn + fp) if tn + fp else None,
        accuracy=(tp + tn) / len(samples),
        cost_per_1000_cny=cost_per_1000_cny,
    )


def keyword_metrics(samples: list[Sample]) -> list[Metrics]:
    return [
        measure(
            samples,
            [
                float(
                    any(
                        word in (sample.title + (" " + sample.section if section else ""))
                        for word in words
                    )
                )
                for sample in samples
            ],
            f"keywords/{name}",
            section,
            0.5,
            0,
        )
        for name, words in KEYWORDS.items()
        for section in (False, True)
    ]


async def evaluate_models(
    samples: list[Sample],
    models: list[str],
    output: Path,
    api_key: str | None,
    retry_errors: bool = False,
) -> tuple[list[Metrics], list[dict[str, object]]]:
    cache_path = output / "scores.jsonl"
    cache: dict[str, Cached] = {}
    if cache_path.exists():
        for line in cache_path.read_text(encoding="utf-8").splitlines():
            cached = Cached.model_validate_json(line)
            cache[cached.call.model_dump_json()] = cached
    provider = SiliconFlow(api_key) if api_key is not None else None
    semaphore = asyncio.Semaphore(5)
    metrics: list[Metrics] = []
    runs: list[dict[str, object]] = []
    try:
        with cache_path.open("a", encoding="utf-8", newline="\n") as stream:

            async def score(call: Call) -> Cached:
                key = call.model_dump_json()
                if key in cache and (not retry_errors or cache[key].result.error is None):
                    return cache[key]
                if provider is None:
                    raise ValueError("Missing cached result; rerun without --reuse-only")
                async with semaphore:
                    cached = Cached(call=call, result=await provider.score(call))
                    stream.write(cached.model_dump_json() + "\n")
                    stream.flush()
                    cache[key] = cached
                    return cached

            for model in models:
                for with_section in (False, True):
                    calls = [
                        Call(
                            model=model, title=s.title, section=s.section if with_section else None
                        )
                        for s in samples
                    ]
                    # A failed credential/model pilot must not trigger hundreds of failing requests.
                    pilot = await score(calls[0])
                    if pilot.result.error is not None:
                        runs.append(
                            {
                                "model": model,
                                "with_section": with_section,
                                "pilot_error": pilot.result.error,
                            }
                        )
                        print(
                            f"model={model} with_section={with_section} "
                            f"pilot_error={pilot.result.error}",
                            flush=True,
                        )
                        continue
                    unique = {call.model_dump_json(): call for call in calls}
                    pending = [asyncio.create_task(score(call)) for call in unique.values()]
                    for completed, task in enumerate(asyncio.as_completed(pending), 1):
                        await task
                        if completed % 50 == 0:
                            print(
                                f"model={model} with_section={with_section} "
                                f"completed={completed}/{len(unique)}",
                                flush=True,
                            )
                    results = [cache[call.model_dump_json()].result for call in calls]
                    errors = Counter(result.error for result in results if result.error is not None)
                    costs = [cost_cny(model, result) for result in results]
                    unique_results = [cache[key].result for key in unique]
                    measured_costs = [cost_cny(model, result) for result in unique_results]
                    fee = (
                        sum(value for value in costs if value is not None) / len(samples) * 1000
                        if all(value is not None for value in costs)
                        else None
                    )
                    runs.append(
                        {
                            "model": model,
                            "with_section": with_section,
                            "samples": len(samples),
                            "unique_inputs": len(unique),
                            "errors": dict(errors),
                            "cost_per_1000_cny": fee,
                            "dataset_weighted_input_tokens": sum(
                                result.usage.prompt_tokens for result in results if result.usage
                            ),
                            "dataset_weighted_output_tokens": sum(
                                result.usage.completion_tokens for result in results if result.usage
                            ),
                            "measured_input_tokens": sum(
                                result.usage.prompt_tokens
                                for result in unique_results
                                if result.usage
                            ),
                            "measured_output_tokens": sum(
                                result.usage.completion_tokens
                                for result in unique_results
                                if result.usage
                            ),
                            "measured_cost_cny": (
                                sum(value for value in measured_costs if value is not None)
                                if all(value is not None for value in measured_costs)
                                else None
                            ),
                        }
                    )
                    if errors:
                        print(
                            f"model={model} with_section={with_section} errors={dict(errors)}",
                            flush=True,
                        )
                        continue
                    scores = [result.score for result in results if result.score is not None]
                    if len(scores) != len(samples):
                        raise ValueError("Incomplete scores must not be evaluated")
                    positive_scores = [
                        value
                        for sample, value in zip(samples, scores, strict=True)
                        if sample.relevant == "1"
                    ]
                    threshold_values: set[float] = set(THRESHOLDS)
                    if positive_scores:
                        threshold_values.add(min(positive_scores))
                    thresholds = sorted(threshold_values)
                    metrics.extend(
                        measure(samples, scores, model, with_section, threshold, fee)
                        for threshold in thresholds
                    )
                    print(
                        f"model={model} with_section={with_section} "
                        f"finished cost_per_1000_cny={fee}",
                        flush=True,
                    )
    finally:
        if provider is not None:
            await provider.close()
    return metrics, runs


def write_report(
    output: Path, samples: list[Sample], metrics: list[Metrics], runs: list[dict[str, object]]
) -> None:
    report: dict[str, object] = {
        "samples": len(samples),
        "positive": sum(sample.relevant == "1" for sample in samples),
        "negative": sum(sample.relevant == "0" for sample in samples),
        "sources": len({sample.source_url for sample in samples}),
        "pricing_date": PRICING_DATE,
        "pricing_source": PRICING_URL,
        "system_one_alpha_pricing_source": SYSTEM_ONE_PRICING_URL,
        "cost_basis": (
            "Observed token usage at the published rate, scaled by dataset rows; not an invoice"
        ),
        "evaluation_scope": (
            "Development-set evaluation; keyword vocabulary and thresholds are dataset-informed"
        ),
        "prices_cny_per_million_input_output_cached": PRICES,
        "keywords": KEYWORDS,
        "runs": runs,
        "metrics": [row.model_dump() for row in metrics],
    }
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (output / "metrics.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(Metrics.model_fields))
        writer.writeheader()
        writer.writerows(row.model_dump() for row in metrics)
    lines = [
        "# 初筛实验结果",
        "",
        f"数据:{len(samples)} 条,相关 {report['positive']} 条,无关 {report['negative']} 条,"
        f"来自 {report['sources']} 个列表页。",
        "",
        "召回率 = TP/(TP+FN);无关过滤率 = TN/(TN+FP);准确率 = (TP+TN)/总数。",
        "门槛为保留分数的下限,分数等于门槛时保留。",
        "",
        "词表及门槛参考了当前数据,属于开发集评估。相关通知零漏检只适用于本次标注集,"
        "后续应按学院或时间留出独立测试数据。聊天模型输出的分数是自评分,不是校准概率。",
        "",
        "## 关键词规则",
        "",
        "| 组 | 召回率 | 无关过滤率 | 准确率 | 漏检 |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    lines.extend(
        f"| {row.method} | {percent(row.recall)} | {percent(row.filtering)} | "
        f"{percent(row.accuracy)} | {row.false_negative} |"
        for row in metrics
        if row.method.startswith("keywords/") and not row.with_section
    )
    lines.extend(["", "词表:", ""])
    lines.extend(f"- `{name}`:{'、'.join(words)}。" for name, words in KEYWORDS.items())
    lines.extend(
        [
            "",
            "## API:零漏检条件下过滤率最高的候选门槛",
            "",
            "过滤率相同时优先接近 0.5 的已测试门槛。待维护者确认。",
            "",
            "| 模型 | 带栏目名 | 门槛 | 召回率 | 无关过滤率 | 准确率 | 元/千条 |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    groups: dict[tuple[str, bool], list[Metrics]] = {}
    for row in metrics:
        if not row.method.startswith("keywords/"):
            groups.setdefault((row.method, row.with_section), []).append(row)
    for rows in groups.values():
        eligible = [row for row in rows if row.recall == 1]
        if not eligible:
            continue
        best = max(eligible, key=lambda row: (row.true_negative, -abs(row.threshold - 0.5)))
        fee = f"{best.cost_per_1000_cny:.6f}" if best.cost_per_1000_cny is not None else "待核实"
        lines.append(
            f"| {best.method} | {'是' if best.with_section else '否'} | {best.threshold:g} | "
            f"{percent(best.recall)} | {percent(best.filtering)} | "
            f"{percent(best.accuracy)} | {fee} |"
        )
    lines.extend(
        [
            "",
            "费用按本次输入、输出、缓存命中 token 及官方价格折算,非账户实际账单;"
            "千条费用按当前标题分布估算,不含抓取正文和后续抽取的费用。",
            f"价格核对日期:{PRICING_DATE};[硅基流动价格页]({PRICING_URL})。",
            "System One 按 Alpha 当前免费公告估算为 0 元,正式收费后需要更新价格。",
            f"[System One Alpha 价格说明]({SYSTEM_ONE_PRICING_URL})。",
            "",
            "## 全部门槛",
            "",
            "| 方法 | 带栏目名 | 门槛 | 召回率 | 无关过滤率 | 准确率 | 漏检 |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    lines.extend(
        f"| {row.method} | {'是' if row.with_section else '否'} | {row.threshold:g} | "
        f"{percent(row.recall)} | {percent(row.filtering)} | {percent(row.accuracy)} | "
        f"{row.false_negative} |"
        for row in metrics
    )
    lines.extend(
        [
            "",
            "## 调用情况",
            "",
            "```json",
            json.dumps(runs, ensure_ascii=False, indent=2),
            "```",
            "",
        ]
    )
    (output / "report.md").write_text("\n".join(lines), encoding="utf-8")


def percent(value: float | None) -> str:
    return f"{value:.2%}" if value is not None else "不适用"


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate screening without crawling source sites")
    parser.add_argument("--data", type=Path, default=Path("../data/screening.csv"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", nargs="+", default=["Kev-4b", *CHAT_MODELS])
    parser.add_argument("--keywords-only", action="store_true")
    parser.add_argument("--reuse-only", action="store_true")
    parser.add_argument("--retry-errors", action="store_true")
    args = parser.parse_args()
    samples = read_samples(args.data)
    args.output.mkdir(parents=True, exist_ok=True)
    metrics = keyword_metrics(samples)
    runs: list[dict[str, object]] = []
    if not args.keywords_only:
        key = None
        if not args.reuse_only:
            key = os.environ.get("SILICONFLOW_API_KEY") or getpass.getpass("API key (hidden): ")
        model_metrics, runs = asyncio.run(
            evaluate_models(samples, args.models, args.output, key, args.retry_errors)
        )
        metrics.extend(model_metrics)
    write_report(args.output, samples, metrics, runs)
    print(f"samples={len(samples)} metrics={len(metrics)} output={args.output}")


if __name__ == "__main__":
    main()
