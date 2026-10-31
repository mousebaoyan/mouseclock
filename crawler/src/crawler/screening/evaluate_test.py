import asyncio
import csv
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from crawler.screening.evaluate import Cached, Sample, evaluate_models, main, measure, write_report
from crawler.screening.system_one import Call, Prices, Result, SystemOne, Usage, cost_cny


def sample(label: str, number: int) -> Sample:
    return Sample.model_validate(
        {
            "source_url": "https://example.edu.cn/notices/",
            "section": "Admissions",
            "url": f"https://example.edu.cn/notices/{number}",
            "title": f"Summer camp admission {number}",
            "relevant": label,
            "note": "",
        }
    )


def test_threshold_is_inclusive_and_filtering_uses_only_negatives() -> None:
    samples = [sample("1", 0), sample("1", 1), sample("0", 2), sample("0", 3)]
    result = measure(samples, [0.7, 0.5, 0.5, 0.1], "test", False, 0.5, None)
    assert (result.true_positive, result.false_negative) == (2, 0)
    assert (result.true_negative, result.false_positive) == (1, 1)
    assert (result.recall, result.filtering, result.accuracy) == (1, 0.5, 0.75)


@pytest.mark.parametrize("score", [True, -1, 1.1, float("nan")])
def test_invalid_system_one_score_retains_usage(score: float | bool) -> None:
    async def run() -> Result:
        content = json.dumps(
            {
                "model": "Kev-4b",
                "usage": {"input_tokens": 100, "output_tokens": 1},
                "answers": {"relevant": {"type": "noul", "noul": score}},
            }
        )
        provider = SystemOne(
            "test-placeholder", httpx.MockTransport(lambda _: httpx.Response(200, content=content))
        )
        try:
            return await provider.score(Call(model="Kev-4b", title="Camp", section=None))
        finally:
            await provider.close()

    result = asyncio.run(run())
    assert result.error == "invalid_response"
    assert result.score is None
    assert result.usage == Usage(input_tokens=100, output_tokens=1)


def test_cost_uses_usage_and_unknown_usage_is_not_free() -> None:
    result = Result(elapsed_seconds=1, observed_at=datetime(2026, 10, 31, tzinfo=UTC))
    assert cost_cny(result) is None
    result.usage = Usage(input_tokens=100, output_tokens=10)
    assert cost_cny(result) == 0
    prices = Prices(input_cny_per_million=2, output_cny_per_million=4)
    assert cost_cny(result, prices) == pytest.approx(0.00024)


def test_system_one_accepts_other_models_and_does_not_send_labels() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://example.org/v1/systemone"
        body = json.loads(request.content)
        assert body["model"] == "another-system-one-model"
        assert body["questions"]["relevant"]["type"] == "noul"
        assert body["state"] == {"title": "Camp", "section": "Admissions"}
        return httpx.Response(
            200,
            json={
                "model": "another-system-one-model",
                "answers": {"relevant": {"type": "noul", "noul": 0.83}},
                "usage": {"input_tokens": 100, "output_tokens": 1},
            },
        )

    async def run() -> Result:
        provider = SystemOne("test-placeholder", httpx.MockTransport(handle))
        try:
            return await provider.score(
                Call(
                    model="another-system-one-model",
                    title="Camp",
                    section="Admissions",
                    api_url="https://example.org/v1/systemone",
                )
            )
        finally:
            await provider.close()

    result = asyncio.run(run())
    assert result.score == 0.83
    assert result.error is None


def test_failed_request_does_not_leak_response_body() -> None:
    async def run() -> Result:
        provider = SystemOne(
            "test-placeholder", httpx.MockTransport(lambda _: httpx.Response(401, text="sensitive"))
        )
        try:
            return await provider.score(Call(model="Kev-4b", title="Camp", section=None))
        finally:
            await provider.close()

    result = asyncio.run(run())
    assert result.error == "http_401"
    assert "sensitive" not in result.model_dump_json()
    assert result.score is None


def test_programming_errors_are_not_reported_as_invalid_responses() -> None:
    def handle(_: httpx.Request) -> httpx.Response:
        raise ValueError("programming-error")

    async def run() -> None:
        provider = SystemOne("test-placeholder", httpx.MockTransport(handle))
        try:
            await provider.score(Call(model="Kev-4b", title="Camp", section=None))
        finally:
            await provider.close()

    with pytest.raises(ValueError, match="programming-error"):
        asyncio.run(run())


def test_reuse_preserves_threshold_precision_and_recomputes_labels(tmp_path: Path) -> None:
    item = sample("1", 1)
    threshold = 0.12345678901234568
    rows = [
        Cached(
            call=Call(model="Kev-4b", title=item.title, section=section),
            result=Result(
                score=threshold, elapsed_seconds=1, observed_at=datetime(2026, 10, 31, tzinfo=UTC)
            ),
        )
        for section in (None, item.section)
    ]
    (tmp_path / "scores.jsonl").write_text(
        "".join(row.model_dump_json() + "\n" for row in rows), encoding="utf-8"
    )
    metrics, runs = asyncio.run(evaluate_models([item], ["Kev-4b"], tmp_path, None))
    assert all(row.recall == 1 for row in metrics if row.threshold <= threshold)
    write_report(tmp_path, [item], metrics, runs)
    text = (tmp_path / "report.md").read_text(encoding="utf-8")
    highest_rows = [
        line for line in text.split("## 全部门槛")[0].splitlines() if line.startswith("| Kev-4b |")
    ]
    assert len(highest_rows) == 2
    assert all(float(line.split("|")[3].strip()) == threshold for line in highest_rows)
    assert all(row.threshold <= threshold for row in metrics if row.recall == 1)
    item.relevant = "0"
    metrics, _ = asyncio.run(evaluate_models([item], ["Kev-4b"], tmp_path, None))
    assert all(row.recall is None for row in metrics)
    assert all(row.filtering == 1 for row in metrics if row.threshold > threshold)


@pytest.mark.parametrize("pilot_fails", [True, False])
def test_cli_reports_failed_calls_and_exits_nonzero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    pilot_fails: bool,
) -> None:
    samples = [sample("1", 1), sample("0", 2)]
    data = tmp_path / "data.csv"
    with data.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(Sample.model_fields))
        writer.writeheader()
        writer.writerows(item.model_dump() for item in samples)
    rows = [
        Cached(
            call=Call(model="Kev-4b", title=item.title, section=section),
            result=Result(
                score=None if pilot_fails or index == 1 else 0.8,
                error="http_503" if pilot_fails or index == 1 else None,
                elapsed_seconds=1,
                observed_at=datetime(2026, 10, 31, tzinfo=UTC),
            ),
        )
        for index, item in enumerate(samples)
        for section in (None, item.section)
    ]
    (tmp_path / "scores.jsonl").write_text(
        "".join(row.model_dump_json() + "\n" for row in rows), encoding="utf-8"
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "evaluate",
            "--data",
            str(data),
            "--output",
            str(tmp_path),
            "--reuse-only",
        ],
    )
    assert main() == 1
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "failed"
    assert not any(row["method"] == "Kev-4b" for row in report["metrics"])


def test_missing_environment_key_is_an_immediate_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SYSTEM_ONE_API_KEY", raising=False)
    monkeypatch.setattr(sys, "argv", ["evaluate", "--output", str(tmp_path)])
    with pytest.raises(SystemExit) as caught:
        main()
    assert caught.value.code == 2
    assert not (tmp_path / "scores.jsonl").exists()
