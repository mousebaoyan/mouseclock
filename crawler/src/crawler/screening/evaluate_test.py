import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from crawler.screening.evaluate import Cached, Sample, evaluate_models, measure
from crawler.screening.siliconflow import (
    CHAT_MODELS,
    Call,
    Result,
    Score,
    SiliconFlow,
    Usage,
    cost_cny,
)


def sample(label: str, number: int) -> Sample:
    return Sample.model_validate(
        {
            "source_url": "https://example.edu.cn/notices/",
            "section": "Admissions",
            "url": f"https://example.edu.cn/notices/{number}",
            "title": "Summer camp admission",
            "relevant": label,
            "note": "",
        }
    )


def test_threshold_is_inclusive_and_filtering_uses_only_negatives() -> None:
    samples = [sample("1", 0), sample("1", 1), sample("0", 2), sample("0", 3)]
    result = measure(samples, [0.7, 0.5, 0.5, 0.1], "test", False, 0.5, None)
    assert (result.true_positive, result.false_negative) == (2, 0)
    assert (result.true_negative, result.false_positive) == (1, 1)
    assert result.recall == 1
    assert result.filtering == 0.5
    assert result.accuracy == 0.75
    assert result.cost_per_1000_cny is None


@pytest.mark.parametrize(
    "content", ['{"score": true}', '{"score": -1}', '{"score": 1.1}', '{"score": NaN}']
)
def test_invalid_scores_are_not_silently_classified_as_irrelevant(content: str) -> None:
    with pytest.raises(ValidationError):
        Score.model_validate_json(content)


def test_cached_input_and_utc8_off_peak_pricing() -> None:
    result = Result(
        elapsed_seconds=1,
        observed_at=datetime(2026, 10, 30, 12, tzinfo=UTC),
        created=int(datetime(2026, 10, 29, 20, tzinfo=UTC).timestamp()),
        usage=Usage(prompt_tokens=100, completion_tokens=10, prompt_cache_hit_tokens=80),
    )
    assert cost_cny(CHAT_MODELS[0], result) == pytest.approx((20 + 80 * 0.02 + 10 * 4) / 1_000_000)
    result.created = int(datetime(2026, 10, 30, 4, tzinfo=UTC).timestamp())
    assert cost_cny(CHAT_MODELS[0], result) == pytest.approx(
        (20 * 2 + 80 * 0.04 + 10 * 8) / 1_000_000
    )
    result.usage = Usage(prompt_tokens=100, completion_tokens=10)
    assert cost_cny(CHAT_MODELS[0], result) is None


def test_api_inputs_exclude_labels_and_invalid_output_retains_usage() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["enable_thinking"] is False
        assert json.loads(body["messages"][1]["content"]) == {
            "title": "Summer camp admission",
            "section": "Admissions",
        }
        return httpx.Response(
            200,
            json={
                "model": CHAT_MODELS[0],
                "created": 1793300000,
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 8,
                    "prompt_cache_hit_tokens": 0,
                },
                "choices": [
                    {"finish_reason": "stop", "message": {"content": '{"score": "invalid"}'}}
                ],
            },
        )

    async def run() -> Result:
        provider = SiliconFlow("test-placeholder", httpx.MockTransport(handle))
        try:
            return await provider.score(
                Call(model=CHAT_MODELS[0], title="Summer camp admission", section="Admissions")
            )
        finally:
            await provider.close()

    result = asyncio.run(run())
    assert result.error == "invalid_response"
    assert result.score is None
    assert result.usage is not None
    assert result.usage.prompt_tokens == 100


def test_failed_request_does_not_leak_response_body() -> None:
    async def run() -> Result:
        provider = SiliconFlow(
            "test-placeholder", httpx.MockTransport(lambda _: httpx.Response(401, text="sensitive"))
        )
        try:
            return await provider.score(Call(model=CHAT_MODELS[0], title="A notice", section=None))
        finally:
            await provider.close()

    result = asyncio.run(run())
    assert result.error == "http_401"
    assert "sensitive" not in result.model_dump_json()
    assert result.score is None


def test_reuse_recomputes_metrics_from_current_labels_without_an_api_key(tmp_path: Path) -> None:
    item = sample("1", 1)
    rows = [
        Cached(
            call=Call(model=CHAT_MODELS[0], title=item.title, section=section),
            result=Result(
                score=0.6,
                elapsed_seconds=1,
                observed_at=datetime(2026, 10, 30, 12, tzinfo=UTC),
            ),
        )
        for section in (None, item.section)
    ]
    (tmp_path / "scores.jsonl").write_text(
        "".join(row.model_dump_json() + "\n" for row in rows), encoding="utf-8"
    )
    metrics, _ = asyncio.run(evaluate_models([item], [CHAT_MODELS[0]], tmp_path, None))
    assert all(row.recall == 1 for row in metrics if row.threshold <= 0.6)
    item.relevant = "0"
    metrics, _ = asyncio.run(evaluate_models([item], [CHAT_MODELS[0]], tmp_path, None))
    assert all(row.recall is None for row in metrics)
    assert all(row.filtering == 1 for row in metrics if row.threshold > 0.6)


def test_system_one_uses_typed_yes_no_response() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/systemone"
        body = json.loads(request.content)
        assert body["questions"]["relevant"]["type"] == "noul"
        assert body["state"] == {"title": "Summer camp admission"}
        return httpx.Response(
            200,
            json={
                "model": "Kev-4b",
                "answers": {"relevant": {"type": "noul", "noul": 0.83}},
                "usage": {"input_tokens": 100, "output_tokens": 1},
            },
        )

    async def run() -> Result:
        provider = SiliconFlow("test-placeholder", httpx.MockTransport(handle))
        try:
            return await provider.score(
                Call(model="Kev-4b", title="Summer camp admission", section=None)
            )
        finally:
            await provider.close()

    result = asyncio.run(run())
    assert result.score == 0.83
    assert result.error is None
    assert result.usage is not None
    assert result.usage.prompt_tokens == 100
