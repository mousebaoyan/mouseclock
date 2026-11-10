import asyncio
import json

import httpx
import pytest
from pydantic import JsonValue

from crawler.crawl.rounds import StepError
from crawler.extraction.responses import Response, Responses, make_request


def test_shared_prefix_stays_identical_when_notice_or_mapping_order_changes() -> None:
    schema: dict[str, JsonValue] = {"type": "object"}
    first = make_request("rules", {"colleges": [], "programs": []}, {"title": "a"}, schema)
    second = make_request("rules", {"programs": [], "colleges": []}, {"title": "b"}, schema)
    a, b = first.pop("input"), second.pop("input")
    assert isinstance(a, list)
    assert isinstance(b, list)
    assert a[0] == b[0]
    assert a[1] != b[1]
    assert first == second


def test_responses_envelope_excludes_reasoning_and_preserves_cache_usage() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.deepseek.com/responses"
        body = json.loads(request.content)
        assert body["text"]["format"]["type"] == "json_schema"
        assert body["text"]["format"]["strict"] is True
        assert body["reasoning"] == {"effort": "none"}
        return httpx.Response(
            200,
            json={
                "model": "deepseek-flash",
                "status": "completed",
                "output": [
                    {
                        "type": "reasoning",
                        "content": [{"type": "reasoning_text", "text": "private"}],
                    },
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": '{"programs":[]}'}],
                    },
                ],
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 10,
                    "input_tokens_details": {"cached_tokens": 80},
                },
            },
        )

    async def run() -> Response:
        client = Responses("local-test", httpx.MockTransport(handle))
        async with client:
            return await client.generate(make_request("rules", {}, {}, {"type": "object"}))

    result = asyncio.run(run())
    assert result.output_text() == '{"programs":[]}'
    assert result.usage is not None
    assert result.usage.input_tokens_details is not None
    assert result.usage.input_tokens_details.cached_tokens == 80


@pytest.mark.parametrize("status", ["incomplete", "failed", "in_progress"])
def test_non_completed_response_keeps_usage_but_cannot_be_used_as_extraction(status: str) -> None:
    result = Response.model_validate(
        {
            "model": "deepseek-flash",
            "status": status,
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "{}"}]}],
            "usage": {"input_tokens": 100, "output_tokens": 10},
        }
    )
    with pytest.raises(StepError, match=status):
        result.output_text()
    assert result.usage is not None
    assert result.usage.output_tokens == 10
    assert result.usage.input_tokens_details is None


@pytest.mark.parametrize("content", [[], [{"type": "refusal"}], [{"type": "output_text"}]])
def test_empty_or_refused_output_is_not_an_irrelevant_notice(content: list[dict[str, str]]) -> None:
    result = Response.model_validate(
        {
            "model": "deepseek-flash",
            "status": "completed",
            "output": [{"type": "message", "content": content}],
        }
    )
    with pytest.raises(StepError):
        result.output_text()


@pytest.mark.parametrize("status", [401, 429, 503])
def test_http_failure_reports_status_without_response_body_or_key(status: int) -> None:
    async def run() -> None:
        client = Responses(
            "local-test",
            httpx.MockTransport(lambda _: httpx.Response(status, text="sensitive upstream detail")),
        )
        async with client:
            with pytest.raises(StepError) as caught:
                await client.generate({})
            assert caught.value.detail == f"抽取失败: http_{status}"

    asyncio.run(run())
