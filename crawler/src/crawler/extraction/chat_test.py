import asyncio
import json
import logging
from types import SimpleNamespace

import httpx
import pytest
from pydantic import JsonValue

from crawler.crawl.rounds import StepError
from crawler.extraction.chat import Chat, Completion, make_request


def completion(
    text: str | None,
    *,
    input_tokens: int = 100,
    output_tokens: int = 10,
    cached_tokens: int | None = None,
    finish_reason: str = "stop",
    usage: bool = True,
) -> dict[str, JsonValue]:
    """An answer as the platform's Chat Completions sends it."""
    body: dict[str, JsonValue] = {
        "model": "deepseek-flash",
        "choices": [
            {"message": {"role": "assistant", "content": text}, "finish_reason": finish_reason}
        ],
    }
    if usage:
        tokens: dict[str, JsonValue] = {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
        }
        if cached_tokens is not None:
            tokens["prompt_tokens_details"] = {"cached_tokens": cached_tokens}
        body["usage"] = tokens
    return body


def test_call_log_excludes_queue_time(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    now = 0.0
    monkeypatch.setattr("crawler.extraction.chat.time", SimpleNamespace(monotonic=lambda: now))

    def handle(_request: httpx.Request) -> httpx.Response:
        nonlocal now
        now += 1
        return httpx.Response(
            200, json=completion("{}", input_tokens=120, output_tokens=20, cached_tokens=90)
        )

    async def run() -> None:
        nonlocal now
        async with Chat("local-test", httpx.MockTransport(handle)) as llm:
            llm.slots = asyncio.Semaphore(1)
            await llm.slots.acquire()
            task = asyncio.create_task(llm.generate({}))
            await asyncio.sleep(0)
            assert not task.done()
            now = 100
            llm.slots.release()
            await task

    with caplog.at_level(logging.INFO, logger="crawler.extraction.chat"):
        asyncio.run(run())
    [record] = [r for r in caplog.records if r.getMessage() == "Model answered"]
    fields = vars(record)
    assert fields["elapsed"] == 1
    assert (fields["model"], fields["finish_reasons"]) == ("deepseek-flash", ["stop"])
    assert (fields["input_tokens"], fields["output_tokens"], fields["cached_tokens"]) == (
        120,
        20,
        90,
    )


def test_shared_prefix_stays_identical_when_notice_or_mapping_order_changes() -> None:
    schema: dict[str, JsonValue] = {"type": "object"}
    first = make_request("rules", {"colleges": [], "programs": []}, {"title": "a"}, schema)
    second = make_request("rules", {"programs": [], "colleges": []}, {"title": "b"}, schema)
    a, b = first.pop("messages"), second.pop("messages")
    assert isinstance(a, list)
    assert isinstance(b, list)
    assert a[:2] == b[:2]
    assert a[2] != b[2]
    assert first == second


def test_answer_is_held_to_the_schema_and_keeps_cache_usage() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["response_format"]["type"] == "json_schema"
        assert body["response_format"]["json_schema"]["strict"] is True
        return httpx.Response(200, json=completion('{"programs":[]}', cached_tokens=80))

    async def run() -> Completion:
        async with Chat("local-test", httpx.MockTransport(handle)) as client:
            return await client.generate(make_request("rules", {}, {}, {"type": "object"}))

    result = asyncio.run(run())
    assert result.output_text() == '{"programs":[]}'
    assert result.usage is not None
    assert result.usage.prompt_tokens_details is not None
    assert result.usage.prompt_tokens_details.cached_tokens == 80


@pytest.mark.parametrize("finish_reason", ["length", "content_filter"])
def test_unfinished_answer_keeps_usage_but_cannot_be_used_as_extraction(
    finish_reason: str,
) -> None:
    result = Completion.model_validate(completion("{}", finish_reason=finish_reason))
    with pytest.raises(StepError, match=finish_reason):
        result.output_text()
    assert result.usage is not None
    assert result.usage.completion_tokens == 10
    assert result.usage.prompt_tokens_details is None


@pytest.mark.parametrize(
    "body", [completion(None), completion(""), {"model": "deepseek-flash", "choices": []}]
)
def test_empty_or_missing_output_is_not_an_irrelevant_notice(body: dict[str, JsonValue]) -> None:
    with pytest.raises(StepError):
        Completion.model_validate(body).output_text()


@pytest.mark.parametrize("status", [401, 429, 503])
def test_http_failure_reports_status_without_response_body_or_key(status: int) -> None:
    async def run() -> None:
        client = Chat(
            "local-test",
            httpx.MockTransport(lambda _: httpx.Response(status, text="sensitive upstream detail")),
        )
        async with client:
            with pytest.raises(StepError) as caught:
                await client.generate({})
            assert caught.value.detail == f"模型调用失败: http_{status}"

    asyncio.run(run())
